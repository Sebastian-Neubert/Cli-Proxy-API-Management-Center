/**
 * Pure aggregation of hourly API cost buckets: local-day grouping, window sums, top-N
 * stacked daily series and per-model / per-account totals. Buckets are UTC hours; days
 * are local to the browser and a bucket belongs to the day its hour starts in.
 */

import type { ApiCostAccount, ApiCostBucket, ApiCostUnpricedModel } from '@/types/apiCost';
import { niceCeil } from '@/features/quota/pool/chartGeometry';

export const RANGE_DAYS = [7, 30, 90] as const;
export type RangeDays = (typeof RANGE_DAYS)[number];

/** Series key of the folded "other models" stack segment. */
export const OTHER_SERIES = '__other__';

export interface CostTotals {
  requests: number;
  unpricedRequests: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number;
}

export const emptyTotals = (): CostTotals => ({
  requests: 0,
  unpricedRequests: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  costUsd: 0,
});

const addInto = (target: CostTotals, bucket: CostTotals): CostTotals => {
  target.requests += bucket.requests;
  target.unpricedRequests += bucket.unpricedRequests;
  target.inputTokens += bucket.inputTokens;
  target.cacheReadTokens += bucket.cacheReadTokens;
  target.cacheWriteTokens += bucket.cacheWriteTokens;
  target.outputTokens += bucket.outputTokens;
  target.costUsd += bucket.costUsd;
  return target;
};

/** All token buckets together (they are mutually exclusive). */
export const totalTokens = (totals: CostTotals): number =>
  totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.outputTokens;

/** Local midnight of the day containing `ms`. */
export function localDayStart(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Local midnight `days` calendar days after the day containing `ms` (DST safe). */
export function addLocalDays(ms: number, days: number): number {
  const date = new Date(localDayStart(ms));
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/** Start of a window of `days` local days that ends with (and includes) today. */
export const windowStartMs = (nowMs: number, days: number): number =>
  addLocalDays(nowMs, -(Math.max(1, days) - 1));

/** Sum of the buckets whose hour starts at or after `fromMs`. */
export function sumSince(buckets: readonly ApiCostBucket[], fromMs: number): CostTotals {
  const totals = emptyTotals();
  for (const bucket of buckets) {
    if (bucket.hourMs >= fromMs) addInto(totals, bucket);
  }
  return totals;
}

export interface WindowSummaries {
  today: CostTotals;
  last7: CostTotals;
  last30: CostTotals;
}

/** Today, the last 7 and the last 30 local days (each including today). */
export function windowSummaries(buckets: readonly ApiCostBucket[], nowMs: number): WindowSummaries {
  return {
    today: sumSince(buckets, windowStartMs(nowMs, 1)),
    last7: sumSince(buckets, windowStartMs(nowMs, 7)),
    last30: sumSince(buckets, windowStartMs(nowMs, 30)),
  };
}

export interface DailySeries {
  /** Model name, or OTHER_SERIES. */
  key: string;
  costUsd: number;
}

export interface DailyPoint {
  /** Local midnight. */
  dayMs: number;
  totals: CostTotals;
  /** Cost per series, aligned with `DailyCostModel.series`. */
  values: number[];
}

export interface DailyCostModel {
  /** Top models by cost (descending), then OTHER_SERIES when anything was folded. */
  series: DailySeries[];
  /** One point per local day of the range, oldest first, including empty days. */
  days: DailyPoint[];
  /** Highest daily cost in the range. */
  maxCostUsd: number;
}

/**
 * Daily cost for the `days` local days ending today, stacked by the `topN` most expensive
 * models of the range; the rest fold into OTHER_SERIES.
 */
export function buildDailyCost(
  buckets: readonly ApiCostBucket[],
  nowMs: number,
  days: number,
  topN = 6
): DailyCostModel {
  const startMs = windowStartMs(nowMs, days);
  const inRange = buckets.filter((bucket) => bucket.hourMs >= startMs);

  const byModel = totalsByModel(inRange);
  const top = byModel.slice(0, Math.max(0, topN));
  const folded = byModel.slice(top.length);
  const series: DailySeries[] = top.map((row) => ({ key: row.model, costUsd: row.totals.costUsd }));
  if (folded.length > 0) {
    series.push({
      key: OTHER_SERIES,
      costUsd: folded.reduce((sum, row) => sum + row.totals.costUsd, 0),
    });
  }
  const seriesIndex = new Map(top.map((row, index) => [row.model, index]));
  const otherIndex = folded.length > 0 ? series.length - 1 : -1;

  const points: DailyPoint[] = [];
  const pointIndex = new Map<number, number>();
  for (let offset = 0; offset < Math.max(1, days); offset += 1) {
    const dayMs = addLocalDays(startMs, offset);
    if (dayMs > nowMs) break;
    pointIndex.set(dayMs, points.length);
    points.push({ dayMs, totals: emptyTotals(), values: series.map(() => 0) });
  }

  for (const bucket of inRange) {
    const index = pointIndex.get(localDayStart(bucket.hourMs));
    if (index === undefined) continue;
    const point = points[index];
    addInto(point.totals, bucket);
    const slot = seriesIndex.get(bucket.model) ?? otherIndex;
    if (slot >= 0) point.values[slot] += bucket.costUsd;
  }

  return {
    series,
    days: points,
    maxCostUsd: points.reduce((max, point) => Math.max(max, point.totals.costUsd), 0),
  };
}

export interface ModelRow {
  model: string;
  totals: CostTotals;
  /** Share of the total cost, 0-1 (0 when the total is 0). */
  share: number;
}

const byCostDesc = <T extends { totals: CostTotals }>(
  left: T,
  right: T,
  nameOf: (row: T) => string
) =>
  right.totals.costUsd - left.totals.costUsd ||
  right.totals.requests - left.totals.requests ||
  nameOf(left).localeCompare(nameOf(right));

/** Totals per model, most expensive first. */
export function totalsByModel(buckets: readonly ApiCostBucket[]): ModelRow[] {
  const map = new Map<string, CostTotals>();
  for (const bucket of buckets) {
    const totals = map.get(bucket.model) ?? emptyTotals();
    map.set(bucket.model, addInto(totals, bucket));
  }
  const grand = [...map.values()].reduce((sum, totals) => sum + totals.costUsd, 0);
  return [...map.entries()]
    .map(([model, totals]) => ({ model, totals, share: grand > 0 ? totals.costUsd / grand : 0 }))
    .sort((left, right) => byCostDesc(left, right, (row) => row.model));
}

export interface AccountRow {
  /** Raw auth id; '' for requests not attributed to a credential. */
  id: string;
  name: string;
  email: string;
  provider: string;
  disabled: boolean;
  /** False when the credential no longer exists (or was never attributed). */
  known: boolean;
  totals: CostTotals;
  share: number;
}

/** Totals per credential, most expensive first. Removed credentials keep their raw id. */
export function totalsByAccount(
  buckets: readonly ApiCostBucket[],
  accounts: readonly ApiCostAccount[]
): AccountRow[] {
  const known = new Map(accounts.map((account) => [account.id, account]));
  const map = new Map<string, { totals: CostTotals; provider: string }>();
  for (const bucket of buckets) {
    const entry = map.get(bucket.authId) ?? { totals: emptyTotals(), provider: '' };
    addInto(entry.totals, bucket);
    if (!entry.provider && bucket.provider) entry.provider = bucket.provider;
    map.set(bucket.authId, entry);
  }
  const grand = [...map.values()].reduce((sum, entry) => sum + entry.totals.costUsd, 0);
  return [...map.entries()]
    .map(([id, entry]): AccountRow => {
      const account = id ? known.get(id) : undefined;
      return {
        id,
        name: account?.name || id,
        email: account?.email ?? '',
        provider: account?.provider || entry.provider,
        disabled: account?.disabled ?? false,
        known: account !== undefined,
        totals: entry.totals,
        share: grand > 0 ? entry.totals.costUsd / grand : 0,
      };
    })
    .sort((left, right) => byCostDesc(left, right, (row) => row.name));
}

/** Models with unpriced requests, most requests first (their cost counts as 0). */
export const unpricedModels = (rows: readonly ModelRow[]): ApiCostUnpricedModel[] =>
  rows
    .filter((row) => row.totals.unpricedRequests > 0)
    .map((row) => ({ model: row.model, requests: row.totals.unpricedRequests }))
    .sort((left, right) => right.requests - left.requests || left.model.localeCompare(right.model));

/** Y axis for a cost chart: a nice step (at most three intervals) and the ticks up to max. */
export function costAxis(maxValue: number): { max: number; ticks: number[] } {
  const value = Math.max(0.03, Number.isFinite(maxValue) ? maxValue : 0);
  const step = niceCeil(value / 3);
  const intervals = Math.max(1, Math.ceil(value / step - 1e-9));
  const ticks = Array.from({ length: intervals + 1 }, (_, index) =>
    Number((step * index).toPrecision(12))
  );
  return { max: ticks[ticks.length - 1], ticks };
}

/** Buckets whose hour starts at or after `fromMs`. */
export const bucketsSince = (buckets: readonly ApiCostBucket[], fromMs: number): ApiCostBucket[] =>
  buckets.filter((bucket) => bucket.hourMs >= fromMs);

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "$1,234.56"; positive amounts below one cent read "<$0.01". */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return USD.format(0);
  if (value < 0.01) return '<$0.01';
  return USD.format(value);
}

/** Short axis label: "$0", "$2.5", "$40", "$1.2K". */
export function formatUsdTick(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0';
  if (value >= 1000) {
    const scaled = value / 1000;
    return `$${Number(scaled.toFixed(scaled < 100 ? 1 : 0))}K`;
  }
  if (value >= 10) return `$${Math.round(value)}`;
  return `$${Number(value.toFixed(2))}`;
}
