import { describe, expect, test } from "bun:test";
import {
  aggregateAnalytics,
  compareCohorts,
  defineAnalyticsSchema,
} from "../src";

describe("privacy-safe analytics", () => {
  test("suppresses small cohorts and calculates declared route measures", () => {
    const schema = defineAnalyticsSchema({
      dimensions: ["route", "release"] as const,
      measures: ["durationMs"] as const,
      minimumCohortSize: 3,
      name: "request-performance",
    });
    const snapshot = aggregateAnalytics(
      schema,
      [
        ["/checkout", "r2", 100],
        ["/checkout", "r2", 200],
        ["/checkout", "r2", 300],
        ["/private", "r2", 500],
      ].map(([route, release, durationMs], index) => ({
        at: index + 1,
        dimensions: { release: String(release), route: String(route) },
        measures: { durationMs: Number(durationMs) },
      })),
      { groupBy: ["route", "release"], quantiles: [0.5, 0.95] },
    );

    expect(snapshot.accepted).toBe(4);
    expect(snapshot.suppressedGroups).toBe(1);
    expect(snapshot.groups).toHaveLength(1);
    expect(snapshot.groups[0]?.measures.durationMs?.quantiles.p50).toBe(200);
  });

  test("rejects identity-shaped dimensions", () => {
    expect(() =>
      defineAnalyticsSchema({
        dimensions: ["user_id"] as const,
        measures: ["count"] as const,
        name: "unsafe",
      }),
    ).toThrow("Sensitive analytics dimension is forbidden");
  });

  test("compares cohorts with an explicit direction", () => {
    expect(
      compareCohorts({
        baseline: 2_000,
        current: 3_000,
        direction: "lower-is-better",
        regressionThreshold: 0.25,
      }),
    ).toMatchObject({ regression: true, relativeChange: 0.5 });
  });
});
