import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  LessonProgressStatus,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refunds,
  users,
  videoWatchEvents,
} from "~/db/schema";

export const REFUND_WINDOW_DAYS = 14;
export const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;
export const REFUND_COMPLETION_LIMIT = 0.5;

export type RefundEligibility =
  | { eligible: true; amount: number; lastDayInWindow: string }
  | { eligible: false; message: string };

export type CourseRefundOffer =
  | {
      kind: "eligible";
      purchaseId: number;
      amount: number;
      lastDayInWindow: string;
    }
  | { kind: "claimedSeat"; buyerName: string }
  | null;

/**
 * What the course page offers a Student who wants their money back. It only
 * ever refunds the Student's own individual Purchase, never a Team Purchase
 * they also made.
 */
export function getCourseRefundOffer(input: {
  userId: number;
  courseId: number;
  now: Date;
}): CourseRefundOffer {
  const purchase = findIndividualPurchase(input.userId, input.courseId);

  if (!purchase) {
    // Only the Buyer can request a Refund, so a Student on a claimed Seat is
    // pointed at them. Their email stays private.
    const seatBuyer = findBuyerOfClaimedSeat(input.userId, input.courseId);
    return seatBuyer ? { kind: "claimedSeat", buyerName: seatBuyer.name } : null;
  }

  const eligibility = getRefundEligibility({
    userId: input.userId,
    purchaseId: purchase.id,
    now: input.now,
  });
  if (!eligibility.eligible) return null;

  return {
    kind: "eligible",
    purchaseId: purchase.id,
    amount: eligibility.amount,
    lastDayInWindow: eligibility.lastDayInWindow,
  };
}

// An individual Purchase is one with no Seats. If there is more than one, the
// latest is the one that enrols the Student.
function findIndividualPurchase(userId: number, courseId: number) {
  return db
    .select({ id: purchases.id })
    .from(purchases)
    .leftJoin(coupons, eq(coupons.purchaseId, purchases.id))
    .where(
      and(
        eq(purchases.userId, userId),
        eq(purchases.courseId, courseId),
        isNull(coupons.id)
      )
    )
    .orderBy(desc(purchases.createdAt))
    .get();
}

function findBuyerOfClaimedSeat(userId: number, courseId: number) {
  return db
    .select({ name: users.name })
    .from(coupons)
    .innerJoin(purchases, eq(coupons.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .where(
      and(
        eq(coupons.redeemedByUserId, userId),
        eq(coupons.courseId, courseId),
        isNotNull(coupons.redeemedAt)
      )
    )
    .get();
}

/**
 * Refund Eligibility: whether a Refund can be requested for one specific
 * Purchase, and for how much. The course page and the refund route both ask
 * here, so the rules live in one place.
 */
export function getRefundEligibility(input: {
  userId: number;
  purchaseId: number;
  now: Date;
}): RefundEligibility {
  const purchase = db
    .select()
    .from(purchases)
    .where(eq(purchases.id, input.purchaseId))
    .get();

  if (!purchase || purchase.userId !== input.userId) {
    return { eligible: false, message: "You have not bought this course." };
  }

  const seats = db
    .select({ redeemedAt: coupons.redeemedAt })
    .from(coupons)
    .where(eq(coupons.purchaseId, purchase.id))
    .all();

  if (seats.some((seat) => seat.redeemedAt !== null)) {
    return {
      eligible: false,
      message: "A claimed team seat cannot be refunded.",
    };
  }

  // Deliberate for now: nobody can refund a Team Purchase until /team offers it.
  if (seats.length > 0) {
    return {
      eligible: false,
      message: "A team purchase cannot be refunded yet.",
    };
  }

  const earlierRefund = db
    .select({ id: refunds.id })
    .from(refunds)
    .where(eq(refunds.purchaseId, purchase.id))
    .get();

  if (earlierRefund) {
    return {
      eligible: false,
      message: "You have already requested a refund on this purchase.",
    };
  }

  const windowEnd = new Date(purchase.createdAt);
  windowEnd.setDate(windowEnd.getDate() + REFUND_WINDOW_DAYS);
  const lastDayInWindow = calendarDay(windowEnd);
  const today = calendarDay(input.now);
  const isWithinWindow =
    today >= calendarDay(new Date(purchase.createdAt)) &&
    today <= lastDayInWindow;

  if (!isWithinWindow) {
    return {
      eligible: false,
      message: `The ${REFUND_WINDOW_DAYS}-day refund window has closed.`,
    };
  }

  const lessonIds = getLessonIdsForCourse(purchase.courseId);

  if (getSecondsWatched(input.userId, lessonIds) >= REFUND_WATCH_LIMIT_SECONDS) {
    return {
      eligible: false,
      message: "You have watched too much of this course to get a refund.",
    };
  }

  if (
    lessonIds.length > 0 &&
    getCompletedLessonCount(input.userId, lessonIds) / lessonIds.length >=
      REFUND_COMPLETION_LIMIT
  ) {
    return {
      eligible: false,
      message: "You have completed too much of this course to get a refund.",
    };
  }

  return { eligible: true, amount: purchase.amountPaid, lastDayInWindow };
}

function getCompletedLessonCount(userId: number, lessonIds: number[]): number {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return result?.count ?? 0;
}

function getLessonIdsForCourse(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

// Time watched is the furthest point reached in each lesson, added up.
function getSecondsWatched(userId: number, lessonIds: number[]): number {
  if (lessonIds.length === 0) return 0;

  return db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all()
    .reduce((total, row) => total + row.furthest, 0);
}

// The Refund Window is counted in whole days, not hours — someone who buys at
// 23:00 still gets the whole of their fourteenth day.
function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}
