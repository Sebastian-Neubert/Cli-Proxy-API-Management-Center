/**
 * Pooled weekly quota: recorded series, burn rate and a forward projection.
 *
 * Every enabled account contributes 100% to the pool; its remaining share is
 * `100 - used_percent` of its weekly (>= 24h) window. Pure and clock-free: `nowMs`
 * and the range are always passed in, so every case is directly testable.
 */

import type { QuotaWindow } from '@/types/quotaPool';
import { HOUR_MS, MINUTE_MS } from '@/utils/time/durations';
import { longWindowOf } from './logic';

export const ACCOUNT_CAPACITY = 100;
/** Grid of the recorded series and step of the projection. */
export const SERIES_STEP_MS = 15 * MINUTE_MS;
/** Increases smaller than this (in percentage points) are noise, not resets. */
const RESET_ANNOTATION_MIN = 1;
const EPSILON = 1e-9;

export type FutureUsage = 'same' | 'none';

/** Weekly window state of one account at one instant. */
export interface WeeklySample {
  tMs: number;
  /** Remaining share, 0-100. */
  remaining: number;
  resetAtMs: number | null;
  windowMinutes: number | null;
}

/** Account state the projection starts from. */
export interface AccountState {
  remaining: number;
  resetAtMs: number | null;
  windowMinutes: number | null;
  /** True when the weekly used share is unknown (counted as a full 100%). */
  unknown: boolean;
}

export interface OverviewAccount {
  key: string;
  /** File name; used when no email is known. */
  name: string;
  email: string;
  /** Recorded weekly samples, ascending, including the freshest known state. */
  samples: WeeklySample[];
}

export interface SeriesPoint {
  tMs: number;
  value: number;
  /** Per-account value in `accounts` order; null where the account had no data yet. */
  perAccount: Array<number | null>;
}

export interface ResetAnnotation {
  tMs: number;
  /** Restored share in percentage points (pool scale). */
  amount: number;
}

export interface RecordedSeries {
  points: SeriesPoint[];
  resets: ResetAnnotation[];
}

export interface RatePoint {
  tMs: number;
  /** Pool burn in %/h. */
  value: number;
}

export interface Projection {
  points: SeriesPoint[];
  resets: ResetAnnotation[];
  /** First instant the pooled demand cannot be served; null when not within the horizon. */
  poolEmptyMs: number | null;
  /** First instant any single account reaches 0%; null when not within the horizon. */
  firstEmpty: { tMs: number; index: number } | null;
}

const clampRemaining = (value: number): number => Math.min(ACCOUNT_CAPACITY, Math.max(0, value));

/** Weekly window → sample; null when the window or its used share is unknown. */
export function weeklySampleFromWindows(
  tMs: number,
  windows: readonly QuotaWindow[]
): WeeklySample | null {
  const weekly = longWindowOf(windows);
  if (!weekly || weekly.usedPercent === null) return null;
  return {
    tMs,
    remaining: clampRemaining(ACCOUNT_CAPACITY - weekly.usedPercent),
    resetAtMs: weekly.resetAtMs,
    windowMinutes: weekly.windowMinutes,
  };
}

/** Index of the last sample at or before `tMs`, or -1. */
function lastIndexAtOrBefore(samples: readonly WeeklySample[], tMs: number): number {
  let low = 0;
  let high = samples.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (samples[mid].tMs <= tMs) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * Remaining share at `tMs`, carried forward from the last sample at or before it.
 * A recorded reset that passed since that sample means the window refilled (100).
 * Null before the account's first sample.
 */
export function valueAt(samples: readonly WeeklySample[], tMs: number): number | null {
  const index = lastIndexAtOrBefore(samples, tMs);
  if (index < 0) return null;
  const sample = samples[index];
  if (sample.resetAtMs !== null && sample.resetAtMs <= tMs) return ACCOUNT_CAPACITY;
  return sample.remaining;
}

/**
 * Account state at `nowMs`: the carried-forward sample with every passed reset rolled
 * forward by the window length. Accounts without data are a full, unknown 100%.
 */
export function accountStateAt(samples: readonly WeeklySample[], nowMs: number): AccountState {
  const index = lastIndexAtOrBefore(samples, nowMs);
  if (index < 0) {
    return { remaining: ACCOUNT_CAPACITY, resetAtMs: null, windowMinutes: null, unknown: true };
  }
  const sample = samples[index];
  let { remaining, resetAtMs } = sample;
  const { windowMinutes } = sample;
  if (resetAtMs !== null && resetAtMs <= nowMs) {
    remaining = ACCOUNT_CAPACITY;
    if (windowMinutes !== null && windowMinutes > 0) {
      const windowMs = windowMinutes * MINUTE_MS;
      resetAtMs += Math.ceil((nowMs - resetAtMs + 1) / windowMs) * windowMs;
    } else {
      resetAtMs = null;
    }
  }
  return { remaining, resetAtMs, windowMinutes, unknown: false };
}

/** Grid instants: multiples of `stepMs` strictly inside (start, end), plus both ends. */
export function gridInstants(startMs: number, endMs: number, stepMs = SERIES_STEP_MS): number[] {
  if (!(endMs > startMs)) return endMs === startMs ? [startMs] : [];
  const result = [startMs];
  for (let t = Math.floor(startMs / stepMs) * stepMs + stepMs; t < endMs; t += stepMs) {
    if (t > startMs) result.push(t);
  }
  result.push(endMs);
  return result;
}

/**
 * Recorded pool remaining over [startMs, endMs]. Accounts without data yet count as
 * 100% while at least one account has data; grid points where none has data are skipped.
 * Increases (resets) are annotated with the restored amount.
 */
export function buildRecordedSeries(
  accounts: readonly OverviewAccount[],
  startMs: number,
  endMs: number,
  stepMs = SERIES_STEP_MS
): RecordedSeries {
  const points: SeriesPoint[] = [];
  const resets: ResetAnnotation[] = [];
  let previous: SeriesPoint | null = null;
  for (const tMs of gridInstants(startMs, endMs, stepMs)) {
    const perAccount = accounts.map((account) => valueAt(account.samples, tMs));
    if (perAccount.every((value) => value === null)) {
      previous = null;
      continue;
    }
    const value = perAccount.reduce<number>((sum, item) => sum + (item ?? ACCOUNT_CAPACITY), 0);
    const point = { tMs, value, perAccount };
    if (previous) {
      let restored = 0;
      perAccount.forEach((item, index) => {
        const before = previous?.perAccount[index] ?? null;
        if (item !== null && before !== null && item > before) restored += item - before;
      });
      if (restored >= RESET_ANNOTATION_MIN) resets.push({ tMs, amount: restored });
    }
    points.push(point);
    previous = point;
  }
  return { points, resets };
}

/**
 * Consumption of one account over (fromMs, toMs] in %/h: the sum of decreases in
 * remaining. Increases (resets) are ignored, and a recorded reset that passed between
 * two samples restarts the comparison from a full window.
 */
export function accountBurnRate(
  samples: readonly WeeklySample[],
  fromMs: number,
  toMs: number
): number {
  const hours = (toMs - fromMs) / HOUR_MS;
  if (!(hours > 0)) return 0;
  const startIndex = lastIndexAtOrBefore(samples, fromMs);
  let previousValue: number | null = startIndex >= 0 ? valueAt(samples, fromMs) : null;
  let previousReset: number | null =
    startIndex >= 0 && previousValue !== ACCOUNT_CAPACITY ? samples[startIndex].resetAtMs : null;
  let consumed = 0;
  for (let index = startIndex + 1; index < samples.length; index += 1) {
    const sample = samples[index];
    if (sample.tMs > toMs) break;
    if (previousValue !== null && previousReset !== null && previousReset <= sample.tMs) {
      previousValue = ACCOUNT_CAPACITY;
    }
    if (previousValue !== null && sample.remaining < previousValue) {
      consumed += previousValue - sample.remaining;
    }
    previousValue = sample.remaining;
    previousReset = sample.resetAtMs;
  }
  return consumed / hours;
}

/** Pooled burn over the trailing `windowMs` ending at `nowMs`, in %/h. */
export function poolBurnRate(
  accounts: readonly OverviewAccount[],
  nowMs: number,
  windowMs: number
): number {
  return accounts.reduce(
    (sum, account) => sum + accountBurnRate(account.samples, nowMs - windowMs, nowMs),
    0
  );
}

/** Recorded pool burn (%/h, trailing `windowMs`) at each grid instant of [startMs, endMs]. */
export function buildDrainSeries(
  accounts: readonly OverviewAccount[],
  startMs: number,
  endMs: number,
  windowMs: number,
  stepMs = SERIES_STEP_MS
): RatePoint[] {
  const firstSample = accounts.reduce<number>(
    (min, account) => Math.min(min, account.samples[0]?.tMs ?? Number.POSITIVE_INFINITY),
    Number.POSITIVE_INFINITY
  );
  return gridInstants(startMs, endMs, stepMs)
    .filter((tMs) => tMs >= firstSample)
    .map((tMs) => ({ tMs, value: poolBurnRate(accounts, tMs, windowMs) }));
}

/** Soonest-reset routing order: known resets first (soonest wins), then unknowns. */
function drainOrder(states: readonly AccountState[]): number[] {
  return states
    .map((_, index) => index)
    .sort((left, right) => {
      const a = states[left].resetAtMs ?? Number.POSITIVE_INFINITY;
      const b = states[right].resetAtMs ?? Number.POSITIVE_INFINITY;
      return a !== b ? a - b : left - right;
    });
}

export interface ProjectionInput {
  states: readonly AccountState[];
  nowMs: number;
  endMs: number;
  /** Pool burn in %/h; ignored (treated as 0) when `futureUsage` is `none`. */
  burnPerHour: number;
  futureUsage: FutureUsage;
  stepMs?: number;
}

/**
 * Simulate the pool from `nowMs` to `endMs`. Each step drains `burn · dt` from accounts
 * in soonest-reset order (as the proxy's soonest-reset routing would), clamping at 0 and
 * spilling into the next account. A passing reset refills the account to 100% and moves
 * its reset one window ahead; accounts without a known reset never reset.
 */
export function simulateProjection(input: ProjectionInput): Projection {
  const { nowMs, endMs, stepMs = SERIES_STEP_MS } = input;
  const burn = input.futureUsage === 'none' ? 0 : Math.max(0, input.burnPerHour);
  const states = input.states.map((state) => ({ ...state }));
  const points: SeriesPoint[] = [];
  const resets: ResetAnnotation[] = [];
  let poolEmptyMs: number | null = null;
  let firstEmpty: Projection['firstEmpty'] = null;

  const push = (tMs: number) => {
    const perAccount = states.map((state) => state.remaining);
    points.push({ tMs, value: perAccount.reduce((sum, value) => sum + value, 0), perAccount });
  };

  states.forEach((state, index) => {
    if (firstEmpty === null && state.remaining <= EPSILON) firstEmpty = { tMs: nowMs, index };
  });
  if (states.length > 0 && poolEmptyMs === null && burn > 0) {
    if (states.every((state) => state.remaining <= EPSILON)) poolEmptyMs = nowMs;
  }
  push(nowMs);

  let t = nowMs;
  while (t < endMs) {
    let next = Math.min(t + stepMs, endMs);
    for (const state of states) {
      if (state.resetAtMs !== null && state.resetAtMs > t && state.resetAtMs < next) {
        next = state.resetAtMs;
      }
    }

    if (burn > 0) {
      let demand = (burn * (next - t)) / HOUR_MS;
      let served = 0;
      let emptiedPool = false;
      for (const index of drainOrder(states)) {
        if (demand <= EPSILON) break;
        const state = states[index];
        if (state.remaining <= EPSILON) continue;
        const take = Math.min(state.remaining, demand);
        served += take;
        demand -= take;
        state.remaining -= take;
        if (state.remaining <= EPSILON) {
          state.remaining = 0;
          if (firstEmpty === null) {
            firstEmpty = { tMs: t + (served / burn) * HOUR_MS, index };
          }
        }
      }
      if (demand > EPSILON && poolEmptyMs === null) {
        poolEmptyMs = t + (served / burn) * HOUR_MS;
        emptiedPool = true;
      }
      if (emptiedPool && poolEmptyMs !== null && poolEmptyMs > t && poolEmptyMs < next) {
        push(poolEmptyMs);
      }
    }

    t = next;
    const due = states.filter((state) => state.resetAtMs !== null && state.resetAtMs <= t);
    if (due.length > 0) {
      push(t);
      let restored = 0;
      for (const state of due) {
        restored += ACCOUNT_CAPACITY - state.remaining;
        state.remaining = ACCOUNT_CAPACITY;
        if (state.windowMinutes !== null && state.windowMinutes > 0) {
          const windowMs = state.windowMinutes * MINUTE_MS;
          let resetAt = state.resetAtMs as number;
          while (resetAt <= t) resetAt += windowMs;
          state.resetAtMs = resetAt;
        } else {
          state.resetAtMs = null;
        }
      }
      if (restored > EPSILON) resets.push({ tMs: t, amount: restored });
    }
    push(t);
  }

  return { points, resets, poolEmptyMs, firstEmpty };
}

export interface DurationPart {
  value: number;
  unit: 'day' | 'hour' | 'minute';
}

/** Two largest non-zero units of a duration: `2d 18h`, `15h 49m`, `12m`. Floors minutes. */
export function durationParts(ms: number): DurationPart[] {
  const totalMinutes = Math.max(0, Math.floor(ms / MINUTE_MS));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const day: DurationPart = { value: days, unit: 'day' };
  const hour: DurationPart = { value: hours, unit: 'hour' };
  const minute: DurationPart = { value: minutes, unit: 'minute' };
  if (days > 0) return hours > 0 ? [day, hour] : [day];
  if (hours > 0) return minutes > 0 ? [hour, minute] : [hour];
  return [minute];
}

/** Pool percentage, rounded to whole points: `555%`. */
export function formatPoolPercent(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${Math.round(value)}%`;
}

/** Burn rate with one decimal: `3.7%/h`. */
export function formatBurnRate(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${(Math.round(value * 10) / 10).toFixed(1)}%/h`;
}

/** Reset amount with an explicit sign: `+100%`. */
export function formatRestored(value: number): string {
  return `+${formatPoolPercent(value)}`;
}
