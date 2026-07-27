const DEFAULT_MAX_GROUPS = 1_000;
const DEFAULT_MINIMUM_COHORT_SIZE = 5;
const MAX_DIMENSION_VALUE_LENGTH = 512;
const SENSITIVE_DIMENSION =
  /(^|[_.-])(email|ip|name|phone|prompt|secret|token|user)([_.-]|$)/i;

export type AnalyticsSchema<
  Dimension extends string,
  Measure extends string,
> = {
  dimensions: readonly Dimension[];
  maxGroups?: number;
  measures: readonly Measure[];
  minimumCohortSize?: number;
  name: string;
};

export type AnalyticsObservation<
  Dimension extends string,
  Measure extends string,
> = {
  at: number;
  dimensions: Partial<Record<Dimension, string>>;
  measures: Partial<Record<Measure, number>>;
  release?: string;
};

export type AnalyticsQuery<Dimension extends string> = {
  end?: number;
  groupBy: readonly Dimension[];
  quantiles?: readonly number[];
  start?: number;
};

export type MeasureAggregate = {
  average: number;
  count: number;
  maximum: number;
  minimum: number;
  quantiles: Record<string, number>;
  sum: number;
};

export type AnalyticsGroup<Dimension extends string, Measure extends string> = {
  dimensions: Partial<Record<Dimension, string>>;
  measures: Partial<Record<Measure, MeasureAggregate>>;
  observations: number;
};

export type AnalyticsSnapshot<
  Dimension extends string,
  Measure extends string,
> = {
  accepted: number;
  groups: Array<AnalyticsGroup<Dimension, Measure>>;
  schema: string;
  suppressedGroups: number;
};

export type CohortComparison = {
  absoluteChange: number;
  baseline: number;
  current: number;
  direction: "higher-is-better" | "lower-is-better";
  regression: boolean;
  relativeChange: number | null;
};

const assertUnique = (values: readonly string[], label: string) => {
  if (new Set(values).size !== values.length)
    throw new Error(`${label} must not contain duplicates`);
};

export const defineAnalyticsSchema = <
  const Dimension extends string,
  const Measure extends string,
>(
  schema: AnalyticsSchema<Dimension, Measure>,
): AnalyticsSchema<Dimension, Measure> => {
  if (!schema.name.trim()) throw new Error("Analytics schema name is required");
  assertUnique(schema.dimensions, "Analytics dimensions");
  assertUnique(schema.measures, "Analytics measures");
  for (const dimension of schema.dimensions)
    if (SENSITIVE_DIMENSION.test(dimension))
      throw new Error(
        `Sensitive analytics dimension is forbidden: ${dimension}`,
      );
  if ((schema.minimumCohortSize ?? DEFAULT_MINIMUM_COHORT_SIZE) < 2)
    throw new Error("Analytics minimum cohort size must be at least two");
  if ((schema.maxGroups ?? DEFAULT_MAX_GROUPS) < 1)
    throw new Error("Analytics max groups must be positive");

  return Object.freeze({
    ...schema,
    dimensions: Object.freeze([...schema.dimensions]),
    measures: Object.freeze([...schema.measures]),
  });
};

export const quantile = (
  values: readonly number[],
  requested: number,
): number => {
  if (!Number.isFinite(requested) || requested < 0 || requested > 1)
    throw new Error("Quantile must be between zero and one");
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * requested;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower]!;
  const upperValue = sorted[upper]!;

  return lowerValue + (upperValue - lowerValue) * (position - lower);
};

const aggregateMeasure = (
  values: readonly number[],
  quantiles: readonly number[],
): MeasureAggregate => {
  const sum = values.reduce((total, value) => total + value, 0);

  return {
    average: sum / values.length,
    count: values.length,
    maximum: Math.max(...values),
    minimum: Math.min(...values),
    quantiles: Object.fromEntries(
      quantiles.map((value) => [
        `p${Math.round(value * 100)}`,
        quantile(values, value),
      ]),
    ),
    sum,
  };
};

const validateObservation = <Dimension extends string, Measure extends string>(
  schema: AnalyticsSchema<Dimension, Measure>,
  observation: AnalyticsObservation<Dimension, Measure>,
) => {
  if (!Number.isFinite(observation.at) || observation.at < 0)
    throw new Error("Analytics observation time is invalid");
  const dimensions = new Set<string>(schema.dimensions);
  for (const [name, value] of Object.entries(observation.dimensions)) {
    if (!dimensions.has(name))
      throw new Error(`Undeclared analytics dimension: ${name}`);
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > MAX_DIMENSION_VALUE_LENGTH
    )
      throw new Error(`Analytics dimension value is invalid: ${name}`);
  }
  const measures = new Set<string>(schema.measures);
  for (const [name, value] of Object.entries(observation.measures)) {
    if (!measures.has(name))
      throw new Error(`Undeclared analytics measure: ${name}`);
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error(`Analytics measure is invalid: ${name}`);
  }
};

export const aggregateAnalytics = <
  Dimension extends string,
  Measure extends string,
>(
  schema: AnalyticsSchema<Dimension, Measure>,
  observations: readonly AnalyticsObservation<Dimension, Measure>[],
  query: AnalyticsQuery<Dimension>,
): AnalyticsSnapshot<Dimension, Measure> => {
  const allowedDimensions = new Set<string>(schema.dimensions);
  for (const dimension of query.groupBy)
    if (!allowedDimensions.has(dimension))
      throw new Error(`Undeclared analytics grouping: ${dimension}`);
  const quantiles = query.quantiles ?? [0.5, 0.75, 0.95, 0.99];
  for (const value of quantiles) quantile([], value);
  const groups = new Map<
    string,
    {
      dimensions: Partial<Record<Dimension, string>>;
      measures: Map<Measure, number[]>;
      observations: number;
    }
  >();
  let accepted = 0;
  for (const observation of observations) {
    validateObservation(schema, observation);
    if (query.start !== undefined && observation.at < query.start) continue;
    if (query.end !== undefined && observation.at >= query.end) continue;
    const dimensions = Object.fromEntries(
      query.groupBy.map((name) => [
        name,
        observation.dimensions[name] ?? "unknown",
      ]),
    ) as Partial<Record<Dimension, string>>;
    const key = JSON.stringify(dimensions);
    let group = groups.get(key);
    if (!group) {
      if (groups.size >= (schema.maxGroups ?? DEFAULT_MAX_GROUPS))
        throw new Error("Analytics group cardinality limit exceeded");
      group = { dimensions, measures: new Map(), observations: 0 };
      groups.set(key, group);
    }
    group.observations += 1;
    accepted += 1;
    for (const [name, value] of Object.entries(observation.measures)) {
      if (typeof value !== "number") continue;
      const values = group.measures.get(name as Measure) ?? [];
      values.push(value);
      group.measures.set(name as Measure, values);
    }
  }
  const minimum = schema.minimumCohortSize ?? DEFAULT_MINIMUM_COHORT_SIZE;
  const visible = [...groups.values()].filter(
    (group) => group.observations >= minimum,
  );

  return {
    accepted,
    groups: visible.map((group) => ({
      dimensions: group.dimensions,
      measures: Object.fromEntries(
        [...group.measures].map(([name, values]) => [
          name,
          aggregateMeasure(values, quantiles),
        ]),
      ) as Partial<Record<Measure, MeasureAggregate>>,
      observations: group.observations,
    })),
    schema: schema.name,
    suppressedGroups: groups.size - visible.length,
  };
};

export const compareCohorts = (input: {
  baseline: number;
  current: number;
  direction: CohortComparison["direction"];
  regressionThreshold?: number;
}): CohortComparison => {
  if (!Number.isFinite(input.baseline) || !Number.isFinite(input.current))
    throw new Error("Cohort values must be finite");
  const absoluteChange = input.current - input.baseline;
  const relativeChange =
    input.baseline === 0 ? null : absoluteChange / Math.abs(input.baseline);
  const threshold = input.regressionThreshold ?? 0;
  const harmfulChange =
    input.direction === "lower-is-better" ? absoluteChange : -absoluteChange;

  return {
    absoluteChange,
    baseline: input.baseline,
    current: input.current,
    direction: input.direction,
    regression:
      harmfulChange > 0 &&
      (relativeChange === null || Math.abs(relativeChange) >= threshold),
    relativeChange,
  };
};
