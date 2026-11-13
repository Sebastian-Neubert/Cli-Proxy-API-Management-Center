/**
 * Subscription usage overview model: joins credential accounts with recorded history and
 * derives the per-provider chart series and headline stats. Pure and clock-free.
 */

import type { QuotaHistoryAccount, QuotaHistoryProvider } from '@/types/quotaPool';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';
import type { PoolAccount } from './logic';
import {
  ACCOUNT_CAPACITY,
  accountStateAt,
  buildDrainSeries,
  buildRecordedSeries,
  poolBurnRate,
  simulateProjection,
  weeklySampleFromWindows,
  type AccountState,
  type FutureUsage,
  type OverviewAccount,
  type Projection,
  type RatePoint,
  type RecordedSeries,
  type ResetAnnotation,
  type WeeklySample,
} from './projection';

export const BURN_WINDOWS_HOURS = [1, 3, 6] as const;
export type BurnWindowHours = (typeof BURN_WINDOWS_HOURS)[number];
export const RANGE_SHIFT_MS = 7 * DAY_MS;
/** Stats look at least this far ahead, even when the visible range ends sooner. */
export const MIN_HORIZON_MS = 7 * DAY_MS;

/** Default visible range: one week back to one week ahead, shifted by `offset` weeks. */
export function overviewRange(nowMs: number, offset: number): { startMs: number; endMs: number } {
  const centre = nowMs + offset * RANGE_SHIFT_MS;
  return { startMs: centre - RANGE_SHIFT_MS, endMs: centre + RANGE_SHIFT_MS };
}

const findHistoryAccount = (
  account: PoolAccount,
  history: QuotaHistoryProvider | null
): QuotaHistoryAccount | null => {
  if (!history) return null;
  const authIndex = String(account.file.authIndex ?? '').trim();
  const id = typeof account.file.id === 'string' ? account.file.id.trim() : '';
  const name = account.file.name;
  return (
    (authIndex && history.accounts.find((item) => item.authIndex === authIndex)) ||
    (id && history.accounts.find((item) => item.id === id)) ||
    history.accounts.find((item) => item.id === name || item.name === name) ||
    null
  );
};

/**
 * Recorded weekly samples plus the credential snapshot when it is fresher than the last
 * recorded point. A snapshot without an observation time only counts when nothing was
 * recorded (it is then treated as observed now).
 */
export function accountSamples(
  account: PoolAccount,
  history: QuotaHistoryAccount | null,
  nowMs: number
): WeeklySample[] {
  const samples = (history?.points ?? [])
    .map((point) => weeklySampleFromWindows(point.tMs, point.windows))
    .filter((sample): sample is WeeklySample => sample !== null && sample.tMs <= nowMs);
  const lastRecordedMs = samples.length ? samples[samples.length - 1].tMs : null;
  const observedMs = account.file.quotaReset?.observedAtMs ?? null;
  const snapshotMs =
    observedMs !== null ? Math.min(observedMs, nowMs) : lastRecordedMs === null ? nowMs : null;
  if (snapshotMs !== null && (lastRecordedMs === null || snapshotMs > lastRecordedMs)) {
    const snapshot = weeklySampleFromWindows(snapshotMs, account.windows);
    if (snapshot) samples.push(snapshot);
  }
  return samples;
}

/** Enabled accounts of one provider with their samples (disabled accounts never serve). */
export function buildOverviewAccounts(
  accounts: readonly PoolAccount[],
  history: QuotaHistoryProvider | null,
  nowMs: number
): OverviewAccount[] {
  return accounts
    .filter((account) => account.file.disabled !== true)
    .map((account) => {
      const recorded = findHistoryAccount(account, history);
      return {
        key: account.key,
        name: account.file.name,
        email: (account.file.email ?? '').trim() || recorded?.email || '',
        samples: accountSamples(account, recorded, nowMs),
      };
    });
}

export interface OverviewOptions {
  nowMs: number;
  startMs: number;
  endMs: number;
  burnWindowHours: BurnWindowHours;
  futureUsage: FutureUsage;
  /** False when the backend has no history route: no recorded series, burn unknown. */
  hasHistory: boolean;
}

export interface OverviewModel {
  accounts: OverviewAccount[];
  states: AccountState[];
  capacity: number;
  remaining: number;
  unknownCount: number;
  /** Null when no history is available. */
  burnPerHour: number | null;
  recorded: RecordedSeries;
  drain: RatePoint[];
  projection: Projection;
  /** End of the simulation: the visible range end, but at least a week ahead of now. */
  horizonEndMs: number;
  nextReset: ResetAnnotation | null;
}

export function buildOverviewModel(
  accounts: OverviewAccount[],
  options: OverviewOptions
): OverviewModel {
  const { nowMs, startMs, endMs, hasHistory } = options;
  const windowMs = options.burnWindowHours * HOUR_MS;
  const states = accounts.map((account) => accountStateAt(account.samples, nowMs));
  const burnPerHour = hasHistory ? poolBurnRate(accounts, nowMs, windowMs) : null;
  const recordedEnd = Math.min(nowMs, endMs);
  const recorded =
    hasHistory && recordedEnd > startMs
      ? buildRecordedSeries(accounts, startMs, recordedEnd)
      : { points: [], resets: [] };
  const drain =
    hasHistory && recordedEnd > startMs
      ? buildDrainSeries(accounts, startMs, recordedEnd, windowMs)
      : [];
  const horizonEndMs = Math.max(endMs, nowMs + MIN_HORIZON_MS);
  const projection = simulateProjection({
    states,
    nowMs,
    endMs: horizonEndMs,
    burnPerHour: burnPerHour ?? 0,
    futureUsage: options.futureUsage,
  });
  return {
    accounts,
    states,
    capacity: accounts.length * ACCOUNT_CAPACITY,
    remaining: states.reduce((sum, state) => sum + state.remaining, 0),
    unknownCount: states.filter((state) => state.unknown).length,
    burnPerHour,
    recorded,
    drain,
    projection,
    horizonEndMs,
    nextReset: projection.resets[0] ?? null,
  };
}
