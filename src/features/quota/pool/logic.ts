/**
 * Pooled quota view model: Claude/Codex subscription accounts, their quota windows,
 * routing rank and cache-read share. Pure and clock-free (`nowMs` is passed in).
 */

import type { AuthFileItem } from '@/types/authFile';
import type {
  QuotaWindow,
  RoutingPreference,
  RoutingPreferenceCandidate,
  RoutingPreferenceProvider,
  TokenUsageTotals,
} from '@/types/quotaPool';
import { resolveAuthProvider } from '@/utils/quota/validators';

export const POOL_PROVIDERS = ['claude', 'codex'] as const;
export type PoolProvider = (typeof POOL_PROVIDERS)[number];

/** A window at least this long is a "long" (weekly-class) window, as the proxy ranks it. */
export const LONG_WINDOW_MINUTES = 24 * 60;

export interface PoolAccount {
  key: string;
  file: AuthFileItem;
  provider: PoolProvider;
  windows: QuotaWindow[];
  /** Matching routing candidate, when the backend reported one. */
  candidate: RoutingPreferenceCandidate | null;
}

export interface PoolSummary {
  accountCount: number;
  enabledCount: number;
  /** Enabled accounts with no known long-window reset. */
  unknownResetCount: number;
  avgLongUsedPercent: number | null;
  maxLongUsedPercent: number | null;
  earliestLongResetMs: number | null;
  /** Pooled cache-read share over the last 24 hours. */
  cacheReadShare24h: number | null;
}

const isPoolProvider = (value: string): value is PoolProvider =>
  (POOL_PROVIDERS as readonly string[]).includes(value);

const authIndexOf = (file: AuthFileItem): string => String(file.authIndex ?? '').trim();
const idOf = (file: AuthFileItem): string => (typeof file.id === 'string' ? file.id.trim() : '');

export const poolAccountKey = (file: AuthFileItem): string =>
  `${file.name}\u0000${authIndexOf(file)}`;

/**
 * Cache-read share of all prompt tokens: cache_read / (input + cache_read + cache_write).
 * Buckets are mutually exclusive. Null when no prompt tokens were recorded.
 */
export function cacheReadShare(totals: TokenUsageTotals | null | undefined): number | null {
  if (!totals) return null;
  const denominator = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  if (!(denominator > 0)) return null;
  return totals.cacheReadTokens / denominator;
}

/** Sum token buckets across accounts. */
export function sumTotals(list: readonly TokenUsageTotals[]): TokenUsageTotals {
  return list.reduce<TokenUsageTotals>(
    (sum, totals) => ({
      requests: sum.requests + totals.requests,
      failed: sum.failed + totals.failed,
      inputTokens: sum.inputTokens + totals.inputTokens,
      cacheReadTokens: sum.cacheReadTokens + totals.cacheReadTokens,
      cacheWriteTokens: sum.cacheWriteTokens + totals.cacheWriteTokens,
      outputTokens: sum.outputTokens + totals.outputTokens,
    }),
    {
      requests: 0,
      failed: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    }
  );
}

/**
 * The account's longest window of at least 24 hours (Claude `7d`; Codex `primary` or
 * `secondary`, whichever is weekly). Falls back to a window named `7d` when lengths are missing.
 */
export function longWindowOf(windows: readonly QuotaWindow[]): QuotaWindow | null {
  let best: QuotaWindow | null = null;
  for (const window of windows) {
    if (window.windowMinutes === null || window.windowMinutes < LONG_WINDOW_MINUTES) continue;
    if (!best || window.windowMinutes > (best.windowMinutes ?? 0)) best = window;
  }
  if (best) return best;
  return windows.find((window) => window.windowMinutes === null && window.name === '7d') ?? null;
}

/** Long-window reset of an account; prefers the proxy's own `quota_reset`. */
export function longResetMs(account: PoolAccount, nowMs: number): number | null {
  const fromReset = account.file.quotaReset?.resetAtMs ?? null;
  if (fromReset !== null && fromReset > nowMs) return fromReset;
  const fromWindow = longWindowOf(account.windows)?.resetAtMs ?? null;
  return fromWindow !== null && fromWindow > nowMs ? fromWindow : null;
}

const findCandidate = (
  file: AuthFileItem,
  provider: RoutingPreferenceProvider | undefined
): RoutingPreferenceCandidate | null => {
  if (!provider) return null;
  const authIndex = authIndexOf(file);
  const id = idOf(file);
  return (
    (authIndex && provider.candidates.find((item) => item.authIndex === authIndex)) ||
    (id && provider.candidates.find((item) => item.id === id)) ||
    provider.candidates.find((item) => item.id === file.name || item.name === file.name) ||
    null
  );
};

/** Claude/Codex accounts per provider, ordered by routing rank, then by name. */
export function buildPoolAccounts(
  files: readonly AuthFileItem[],
  preference: RoutingPreference | null
): Record<PoolProvider, PoolAccount[]> {
  const result: Record<PoolProvider, PoolAccount[]> = { claude: [], codex: [] };
  for (const file of files) {
    const provider = resolveAuthProvider(file);
    if (!isPoolProvider(provider)) continue;
    const providerPreference = preference?.providers.find((item) => item.provider === provider);
    result[provider].push({
      key: poolAccountKey(file),
      file,
      provider,
      windows: file.quotaWindows ?? [],
      candidate: findCandidate(file, providerPreference),
    });
  }
  for (const provider of POOL_PROVIDERS) {
    result[provider].sort((left, right) => {
      const leftRank = left.candidate?.rank ?? Number.POSITIVE_INFINITY;
      const rightRank = right.candidate?.rank ?? Number.POSITIVE_INFINITY;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.file.name.localeCompare(right.file.name);
    });
  }
  return result;
}

/** Pool-level figures over enabled accounts (disabled accounts never serve requests). */
export function summarizePool(accounts: readonly PoolAccount[], nowMs: number): PoolSummary {
  const enabled = accounts.filter((account) => account.file.disabled !== true);
  const usedValues: number[] = [];
  let earliest: number | null = null;
  let unknownResetCount = 0;
  for (const account of enabled) {
    const used = longWindowOf(account.windows)?.usedPercent ?? null;
    if (used !== null) usedValues.push(used);
    const reset = longResetMs(account, nowMs);
    if (reset === null) unknownResetCount += 1;
    else if (earliest === null || reset < earliest) earliest = reset;
  }
  const usage = enabled
    .map((account) => account.file.tokenUsage?.last24h)
    .filter((totals): totals is TokenUsageTotals => Boolean(totals));
  return {
    accountCount: accounts.length,
    enabledCount: enabled.length,
    unknownResetCount,
    avgLongUsedPercent: usedValues.length
      ? usedValues.reduce((sum, value) => sum + value, 0) / usedValues.length
      : null,
    maxLongUsedPercent: usedValues.length ? Math.max(...usedValues) : null,
    earliestLongResetMs: earliest,
    cacheReadShare24h: usage.length ? cacheReadShare(sumTotals(usage)) : null,
  };
}

/** Compact window length: 300 → `5h`, 10080 → `7d`, 90 → `90m`. */
export function windowLengthParts(
  minutes: number | null
): { value: number; unit: 'day' | 'hour' | 'minute' } | null {
  if (minutes === null || !(minutes > 0)) return null;
  if (minutes % 1440 === 0) return { value: minutes / 1440, unit: 'day' };
  if (minutes % 60 === 0) return { value: minutes / 60, unit: 'hour' };
  return { value: Math.round(minutes), unit: 'minute' };
}

export type WindowTone = 'ok' | 'warning' | 'limited' | 'unknown';

/** Upstream window status → display tone. */
export function windowTone(status: string): WindowTone {
  const normalized = status.trim().toLowerCase();
  if (!normalized) return 'unknown';
  if (normalized === 'allowed') return 'ok';
  if (normalized.includes('warning')) return 'warning';
  if (normalized === 'rejected' || normalized.includes('limit') || normalized === 'exhausted') {
    return 'limited';
  }
  return 'unknown';
}
