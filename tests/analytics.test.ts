import { describe, expect, test } from "bun:test";
import {
  aggregateAnalytics,
  compareCohorts,
  defineAnalyticsSchema,
  normalizeRouteTemplate,
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
    expect(snapshot.suppressedMeasures).toBe(0);
    expect(snapshot.groups).toHaveLength(1);
    expect(snapshot.groups[0]?.measures.durationMs?.quantiles.p50).toBe(200);
  });

  test("suppresses sparse measures inside an otherwise visible cohort", () => {
    const schema = defineAnalyticsSchema({
      dimensions: ["route"] as const,
      measures: ["durationMs", "revenue"] as const,
      minimumCohortSize: 3,
      name: "sparse-measures",
    });
    const snapshot = aggregateAnalytics(
      schema,
      [
        { durationMs: 10, revenue: 99 },
        { durationMs: 20 },
        { durationMs: 30 },
      ].map((measures, index) => ({
        at: index + 1,
        dimensions: { route: "/checkout" },
        measures,
      })),
      { groupBy: ["route"] },
    );

    expect(snapshot.groups[0]?.measures.durationMs?.count).toBe(3);
    expect(snapshot.groups[0]?.measures.revenue).toBeUndefined();
    expect(snapshot.suppressedMeasures).toBe(1);
  });

  test("normalizes route identifiers and rejects direct identity values", () => {
    const schema = defineAnalyticsSchema({
      dimensionNormalizers: {
        route: normalizeRouteTemplate,
      },
      dimensions: ["route"] as const,
      measures: ["count"] as const,
      minimumCohortSize: 2,
      name: "routes",
    });
    const snapshot = aggregateAnalytics(
      schema,
      [
        "/orders/11111111-1111-4111-8111-111111111111",
        "/orders/22222222-2222-4222-8222-222222222222",
      ].map((route, index) => ({
        at: index + 1,
        dimensions: { route },
        measures: { count: 1 },
      })),
      { groupBy: ["route"] },
    );

    expect(snapshot.groups[0]?.dimensions.route).toBe("/orders/:id");
    expect(() =>
      aggregateAnalytics(
        schema,
        [
          {
            at: 1,
            dimensions: { route: "person@example.com" },
            measures: { count: 1 },
          },
        ],
        { groupBy: ["route"] },
      ),
    ).toThrow("Sensitive analytics dimension value is forbidden");
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
        baselineSampleSize: 100,
        current: 3_000,
        currentSampleSize: 100,
        direction: "lower-is-better",
        regressionThreshold: 0.25,
      }),
    ).toMatchObject({
      evidence: "sufficient",
      regression: true,
      relativeChange: 0.5,
    });
  });

  test("does not call a low-sample directional change a regression", () => {
    expect(
      compareCohorts({
        baseline: 2_000,
        baselineSampleSize: 5,
        current: 3_000,
        currentSampleSize: 5,
        direction: "lower-is-better",
        regressionThreshold: 0.25,
      }),
    ).toMatchObject({ evidence: "insufficient", regression: false });
  });
});
