# @absolutejs/analytics

Typed product and operational analytics primitives for AbsoluteJS.

The package deliberately does not provide an unbounded client event collector.
Callers declare every dimension and measure, identity-shaped dimensions are
rejected, cardinality is bounded, and cohorts smaller than a configured privacy
threshold are suppressed. The result is deterministic aggregate evidence that
can feed dashboards, Outcomes, SLOs, incidents, and release gates without
turning application telemetry into a shadow user database.

```ts
import {
  aggregateAnalytics,
  defineAnalyticsSchema,
} from "@absolutejs/analytics";

const schema = defineAnalyticsSchema({
  name: "route-performance",
  dimensions: ["route", "release"],
  measures: ["durationMs"],
  minimumCohortSize: 10,
});

const snapshot = aggregateAnalytics(schema, observations, {
  groupBy: ["route", "release"],
  quantiles: [0.5, 0.75, 0.95, 0.99],
});
```

Tenant identity belongs at the storage/query authorization boundary and is not
an analytics dimension. Prompts, tokens, email addresses, IP addresses, and
user identifiers do not belong in this package's event contract.
