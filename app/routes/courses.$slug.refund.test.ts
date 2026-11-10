import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import { RouterContextProvider } from "react-router";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

const testDbHolder = vi.hoisted(() => ({
  current: undefined as unknown,
}));
const session = vi.hoisted(() => ({ userId: null as number | null }));

vi.mock("~/db", () => ({
  get db() {
    return testDbHolder.current;
  },
}));

vi.mock("~/lib/session", () => ({
  getCurrentUserId: vi.fn(async () => session.userId),
}));

import { action } from "./courses.$slug.refund";

type TestDb = ReturnType<typeof createTestDb>;

let testDb: TestDb;
let base: ReturnType<typeof seedBaseData>;
let logSpy: MockInstance<typeof console.log>;

beforeEach(() => {
  testDb = createTestDb();
  testDbHolder.current = testDb;
  base = seedBaseData(testDb);
  testDb.update(schema.courses).set({ price: 9900 }).run();
  session.userId = base.user.id;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

function buyIndividually(
  overrides: Partial<typeof schema.purchases.$inferInsert> = {}
) {
  return testDb
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid: 7900,
      country: "US",
      ...overrides,
    })
    .returning()
    .get();
}

function requestRefund(purchaseId: number) {
  const body = new FormData();
  body.set("purchaseId", String(purchaseId));
  body.set("reason", "The course is not what I expected.");

  const url = new URL(`http://localhost/courses/${base.course.slug}/refund`);

  return action({
    params: { slug: base.course.slug },
    request: new Request(url, { method: "POST", body }),
    context: new RouterContextProvider(),
    url,
    pattern: "/courses/:slug/refund",
  });
}

function sentEmails(): string[] {
  return logSpy.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith("[email]"));
}

describe("POST /courses/:slug/refund", () => {
  it("requests a Refund for the amount paid on the Purchase and emails the Buyer", async () => {
    const purchase = buyIndividually();

    const response = await requestRefund(purchase.id);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).headers.get("Location")).toBe("/settings");
    expect(sentEmails()).toHaveLength(1);
    expect(sentEmails()[0]).toContain("The refund is for $79.00");
  });

  it("rejects a direct request once the Buyer has completed half the lessons", async () => {
    const purchase = buyIndividually();
    const courseModule = testDb
      .insert(schema.modules)
      .values({ courseId: base.course.id, title: "Module 1", position: 1 })
      .returning()
      .get();
    const [first] = [1, 2].map((position) =>
      testDb
        .insert(schema.lessons)
        .values({ moduleId: courseModule.id, title: "Lesson", position })
        .returning()
        .get()
    );
    testDb
      .insert(schema.lessonProgress)
      .values({
        userId: base.user.id,
        lessonId: first.id,
        status: schema.LessonProgressStatus.Completed,
      })
      .run();

    await expect(requestRefund(purchase.id)).rejects.toMatchObject({
      init: { status: 403 },
    });
    expect(sentEmails()).toHaveLength(0);
  });

  it("rejects a direct request against a Team Purchase", async () => {
    const purchase = buyIndividually({ amountPaid: 29700 });
    const team = testDb.insert(schema.teams).values({}).returning().get();
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: base.course.id,
        purchaseId: purchase.id,
        code: "SEAT-1",
      })
      .run();

    await expect(requestRefund(purchase.id)).rejects.toMatchObject({
      init: { status: 403 },
    });
    expect(sentEmails()).toHaveLength(0);
  });

  it.each([
    schema.RefundStatus.Requested,
    schema.RefundStatus.Approved,
    schema.RefundStatus.Declined,
  ])("rejects a second request after a %s Refund", async (status) => {
    const purchase = buyIndividually();
    testDb
      .insert(schema.refunds)
      .values({ purchaseId: purchase.id, status, reason: "First attempt." })
      .run();

    await expect(requestRefund(purchase.id)).rejects.toMatchObject({
      init: { status: 403 },
    });
    expect(sentEmails()).toHaveLength(0);
  });

  it("rejects a request for another person's Purchase", async () => {
    const purchase = buyIndividually({ userId: base.instructor.id });

    await expect(requestRefund(purchase.id)).rejects.toMatchObject({
      init: { status: 403 },
    });
  });
});
