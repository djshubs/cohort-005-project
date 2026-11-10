import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { eq } from "drizzle-orm";

const testDbHolder = vi.hoisted(() => ({
  current: undefined as unknown,
}));

vi.mock("~/db", () => ({
  get db() {
    return testDbHolder.current;
  },
}));

import { getCourseRefundOffer, getRefundEligibility } from "./refunds.server";

type TestDb = ReturnType<typeof createTestDb>;

let testDb: TestDb;
let base: ReturnType<typeof seedBaseData>;

const PURCHASED_AT = "2026-03-01T10:00:00.000Z";
const SHORTLY_AFTER = new Date("2026-03-03T10:00:00.000Z");

beforeEach(() => {
  testDb = createTestDb();
  testDbHolder.current = testDb;
  base = seedBaseData(testDb);
  testDb
    .update(schema.courses)
    .set({ price: 9900 })
    .run();
});

function buyIndividually(
  userId: number,
  overrides: Partial<typeof schema.purchases.$inferInsert> = {}
) {
  return testDb
    .insert(schema.purchases)
    .values({
      userId,
      courseId: base.course.id,
      amountPaid: 7900,
      country: "US",
      createdAt: PURCHASED_AT,
      ...overrides,
    })
    .returning()
    .get();
}

function addLessons(count: number) {
  const courseModule = testDb
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Module 1", position: 1 })
    .returning()
    .get();

  return Array.from({ length: count }, (_, index) =>
    testDb
      .insert(schema.lessons)
      .values({
        moduleId: courseModule.id,
        title: `Lesson ${index + 1}`,
        position: index + 1,
      })
      .returning()
      .get()
  );
}

function watchUpTo(userId: number, lessonId: number, positionSeconds: number) {
  testDb
    .insert(schema.videoWatchEvents)
    .values({ userId, lessonId, eventType: "progress", positionSeconds })
    .run();
}

function complete(userId: number, lessonId: number) {
  testDb
    .insert(schema.lessonProgress)
    .values({
      userId,
      lessonId,
      status: schema.LessonProgressStatus.Completed,
      completedAt: PURCHASED_AT,
    })
    .run();
}

function buyForTeam(
  buyerId: number,
  seats: number,
  overrides: Partial<typeof schema.purchases.$inferInsert> = {}
) {
  const purchase = buyIndividually(buyerId, {
    amountPaid: 9900 * seats,
    ...overrides,
  });
  const team = testDb.insert(schema.teams).values({}).returning().get();
  const coupons = Array.from({ length: seats }, (_, index) =>
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: base.course.id,
        purchaseId: purchase.id,
        code: `SEAT-${purchase.id}-${index}`,
      })
      .returning()
      .get()
  );
  return { purchase, coupons };
}

function claimSeat(couponId: number, userId: number) {
  testDb
    .update(schema.coupons)
    .set({ redeemedByUserId: userId, redeemedAt: PURCHASED_AT })
    .where(eq(schema.coupons.id, couponId))
    .run();
}

describe("getRefundEligibility", () => {
  it("offers the full amount paid on the Purchase, not the current list price", () => {
    const purchase = buyIndividually(base.user.id);

    const eligibility = getRefundEligibility({
      userId: base.user.id,
      purchaseId: purchase.id,
      now: SHORTLY_AFTER,
    });

    expect(eligibility).toMatchObject({ eligible: true, amount: 7900 });
  });

  it("refuses anyone who is not the Buyer of the Purchase", () => {
    const purchase = buyIndividually(base.user.id);

    const eligibility = getRefundEligibility({
      userId: base.instructor.id,
      purchaseId: purchase.id,
      now: SHORTLY_AFTER,
    });

    expect(eligibility).toMatchObject({ eligible: false });
  });

  it.each([
    schema.RefundStatus.Requested,
    schema.RefundStatus.Approved,
    schema.RefundStatus.Declined,
  ])("refuses a Purchase that already has a %s Refund", (status) => {
    const purchase = buyIndividually(base.user.id);
    testDb
      .insert(schema.refunds)
      .values({ purchaseId: purchase.id, status, reason: "Changed my mind." })
      .run();

    const eligibility = getRefundEligibility({
      userId: base.user.id,
      purchaseId: purchase.id,
      now: SHORTLY_AFTER,
    });

    expect(eligibility).toMatchObject({ eligible: false });
  });

  describe("the 14-day Refund Window, counted in whole days", () => {
    // Bought late on 1 March, local time.
    const lateOnTheFirst = new Date(2026, 2, 1, 23, 0).toISOString();

    it("stays open for the whole of the fourteenth day after the Purchase", () => {
      const purchase = buyIndividually(base.user.id, {
        createdAt: lateOnTheFirst,
      });

      const eligibility = getRefundEligibility({
        userId: base.user.id,
        purchaseId: purchase.id,
        now: new Date(2026, 2, 15, 23, 30),
      });

      expect(eligibility).toEqual({
        eligible: true,
        amount: 7900,
        lastDayInWindow: "2026-03-15",
      });
    });

    it("has closed on the fifteenth day", () => {
      const purchase = buyIndividually(base.user.id, {
        createdAt: lateOnTheFirst,
      });

      const eligibility = getRefundEligibility({
        userId: base.user.id,
        purchaseId: purchase.id,
        now: new Date(2026, 2, 16, 0, 30),
      });

      expect(eligibility).toEqual({
        eligible: false,
        message: "The 14-day refund window has closed.",
      });
    });
  });

  describe("the 2-hour watch limit", () => {
    it("allows a Buyer who has watched just under 2 hours", () => {
      const purchase = buyIndividually(base.user.id);
      const [first, second] = addLessons(2);
      watchUpTo(base.user.id, first.id, 3600);
      watchUpTo(base.user.id, second.id, 3599);

      const eligibility = getRefundEligibility({
        userId: base.user.id,
        purchaseId: purchase.id,
        now: SHORTLY_AFTER,
      });

      expect(eligibility).toMatchObject({ eligible: true });
    });

    it("refuses a Buyer who has watched 2 hours, counting the furthest point in each lesson", () => {
      const purchase = buyIndividually(base.user.id);
      const [first, second] = addLessons(2);
      watchUpTo(base.user.id, first.id, 1200);
      watchUpTo(base.user.id, first.id, 3600);
      watchUpTo(base.user.id, second.id, 3600);

      const eligibility = getRefundEligibility({
        userId: base.user.id,
        purchaseId: purchase.id,
        now: SHORTLY_AFTER,
      });

      expect(eligibility).toEqual({
        eligible: false,
        message: "You have watched too much of this course to get a refund.",
      });
    });
  });

  describe("the 50% completion limit", () => {
    it("allows a Buyer who has completed under half the lessons", () => {
      const purchase = buyIndividually(base.user.id);
      const [first] = addLessons(3);
      complete(base.user.id, first.id);

      const eligibility = getRefundEligibility({
        userId: base.user.id,
        purchaseId: purchase.id,
        now: SHORTLY_AFTER,
      });

      expect(eligibility).toMatchObject({ eligible: true });
    });

    it("refuses a Buyer who has completed exactly half the lessons", () => {
      const purchase = buyIndividually(base.user.id);
      const [first] = addLessons(2);
      complete(base.user.id, first.id);

      const eligibility = getRefundEligibility({
        userId: base.user.id,
        purchaseId: purchase.id,
        now: SHORTLY_AFTER,
      });

      expect(eligibility).toEqual({
        eligible: false,
        message: "You have completed too much of this course to get a refund.",
      });
    });
  });

  describe("Team Purchases", () => {
    it("refuses a Team Purchase even when no Seat has been claimed", () => {
      const { purchase } = buyForTeam(base.user.id, 3);

      const eligibility = getRefundEligibility({
        userId: base.user.id,
        purchaseId: purchase.id,
        now: SHORTLY_AFTER,
      });

      expect(eligibility).toEqual({
        eligible: false,
        message: "A team purchase cannot be refunded yet.",
      });
    });

    it("refuses a Team Purchase once one of its Seats has been claimed", () => {
      const { purchase, coupons } = buyForTeam(base.user.id, 3);
      claimSeat(coupons[0].id, base.instructor.id);

      const eligibility = getRefundEligibility({
        userId: base.user.id,
        purchaseId: purchase.id,
        now: SHORTLY_AFTER,
      });

      expect(eligibility).toEqual({
        eligible: false,
        message: "A claimed team seat cannot be refunded.",
      });
    });
  });
});

describe("getCourseRefundOffer", () => {
  it("offers the Student's own Purchase, not a later Team Purchase", () => {
    const ownPlace = new Date(2026, 2, 1, 10, 0).toISOString();
    const laterTeam = new Date(2026, 2, 10, 10, 0).toISOString();
    const own = buyIndividually(base.user.id, {
      amountPaid: 7900,
      createdAt: ownPlace,
    });
    buyForTeam(base.user.id, 3, { createdAt: laterTeam });

    const offer = getCourseRefundOffer({
      userId: base.user.id,
      courseId: base.course.id,
      now: new Date(2026, 2, 12, 10, 0),
    });

    expect(offer).toEqual({
      kind: "eligible",
      purchaseId: own.id,
      amount: 7900,
      lastDayInWindow: "2026-03-15",
    });
  });

  it("names the Buyer, without their email, to a Student on a claimed Seat", () => {
    const { coupons } = buyForTeam(base.instructor.id, 2);
    claimSeat(coupons[0].id, base.user.id);

    const offer = getCourseRefundOffer({
      userId: base.user.id,
      courseId: base.course.id,
      now: SHORTLY_AFTER,
    });

    expect(offer).toEqual({
      kind: "claimedSeat",
      buyerName: "Test Instructor",
    });
  });

  it("offers nothing when the Student's own Purchase is not eligible", () => {
    const purchase = buyIndividually(base.user.id);
    testDb
      .insert(schema.refunds)
      .values({
        purchaseId: purchase.id,
        status: schema.RefundStatus.Declined,
        reason: "Changed my mind.",
      })
      .run();

    const offer = getCourseRefundOffer({
      userId: base.user.id,
      courseId: base.course.id,
      now: SHORTLY_AFTER,
    });

    expect(offer).toBeNull();
  });
});
