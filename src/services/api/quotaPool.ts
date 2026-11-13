/**
 * Pooled quota windows, token usage and routing preference (v8 management API).
 *
 * `GET /credentials` entries may carry `quota_windows`, `quota_reset` and `token_usage`;
 * `GET /routing/preference` ranks Claude/Codex accounts the way soonest-reset routing does.
 * `GET /quota/history` returns recorded quota windows per Claude/Codex account.
 * Older backends omit the fields and answer the preference and history routes with 404.
 */

import { apiClient } from './client';
import { isRecord } from '@/utils/helpers';
import { parseTimestampMs } from '@/utils/timestamp';
import type {
  QuotaHistory,
  QuotaHistoryAccount,
  QuotaHistoryPoint,
  QuotaHistoryProvider,
  QuotaResetInfo,
  QuotaWindow,
  RoutingPreference,
  RoutingPreferenceCandidate,
  RoutingPreferenceProvider,
  TokenUsageSnapshot,
  TokenUsageTotals,
} from '@/types/quotaPool';

const readText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const readNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const readCount = (value: unknown): number => Math.max(0, readNumber(value) ?? 0);

const readInstantMs = (value: unknown): number | null => {
  const ms = parseTimestampMs(value);
  // Go zero times serialize as year 1; treat them (and anything non-positive) as unknown.
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};

const readMinutes = (value: unknown): number | null => {
  const minutes = readNumber(value);
  return minutes !== null && minutes > 0 ? minutes : null;
};

export function normalizeQuotaWindows(value: unknown): QuotaWindow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const windows = value.filter(isRecord).map<QuotaWindow>((item) => {
    const used = readNumber(item.used_percent ?? item.usedPercent);
    return {
      name: readText(item.name),
      windowMinutes: readMinutes(item.window_minutes ?? item.windowMinutes),
      resetAtMs: readInstantMs(item.reset_at ?? item.resetAt),
      status: readText(item.status),
      usedPercent: used === null ? null : Math.min(100, Math.max(0, used)),
    };
  });
  const named = windows.filter((window) => window.name || window.windowMinutes !== null);
  return named.length ? named : undefined;
}

export function normalizeQuotaReset(value: unknown): QuotaResetInfo | undefined {
  if (!isRecord(value)) return undefined;
  const resetAtMs = readInstantMs(value.reset_at ?? value.resetAt);
  if (resetAtMs === null) return undefined;
  return {
    resetAtMs,
    window: readText(value.window),
    windowMinutes: readMinutes(value.window_minutes ?? value.windowMinutes),
    observedAtMs: readInstantMs(value.observed_at ?? value.observedAt),
  };
}

const normalizeTotals = (value: unknown): TokenUsageTotals => {
  const source = isRecord(value) ? value : {};
  return {
    requests: readCount(source.requests),
    failed: readCount(source.failed),
    inputTokens: readCount(source.input_tokens),
    cacheReadTokens: readCount(source.cache_read_tokens),
    cacheWriteTokens: readCount(source.cache_write_tokens),
    outputTokens: readCount(source.output_tokens),
  };
};

export function normalizeTokenUsage(value: unknown): TokenUsageSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  if (!isRecord(value.current_hour) && !isRecord(value.last_24h)) return undefined;
  return {
    currentHour: normalizeTotals(value.current_hour),
    last24h: normalizeTotals(value.last_24h),
  };
}

const normalizeCandidate = (
  value: Record<string, unknown>,
  index: number
): RoutingPreferenceCandidate => {
  const rank = readNumber(value.rank);
  const resetAtMs = readInstantMs(value.reset_at);
  return {
    rank: rank !== null && rank > 0 ? Math.trunc(rank) : index + 1,
    id: readText(value.id),
    authIndex: readText(value.auth_index) || (readNumber(value.auth_index)?.toString() ?? ''),
    name: readText(value.name),
    available: value.available === true,
    disabled: value.disabled === true,
    preferred: value.preferred === true,
    email: readText(value.email),
    resetAtMs,
    window: resetAtMs === null ? '' : readText(value.window),
  };
};

const normalizeProvider = (value: Record<string, unknown>): RoutingPreferenceProvider | null => {
  const provider = readText(value.provider).toLowerCase();
  if (!provider) return null;
  const preferredId = readText(value.preferred_id);
  const candidates = (Array.isArray(value.candidates) ? value.candidates : [])
    .filter(isRecord)
    .map(normalizeCandidate)
    .sort((left, right) => left.rank - right.rank)
    .map((candidate) => ({
      ...candidate,
      // The preferred id is authoritative; keep the flag consistent with it.
      preferred: preferredId ? candidate.id === preferredId : false,
    }));
  return { provider, preferredId, candidates };
};

export function normalizeRoutingPreference(value: unknown): RoutingPreference {
  const source = isRecord(value) ? value : {};
  const strategy = readText(source.strategy).toLowerCase() || 'round-robin';
  return {
    strategy,
    strategyActive:
      typeof source.strategy_active === 'boolean'
        ? source.strategy_active
        : strategy === 'soonest-reset',
    sessionAffinity: source.session_affinity === true,
    sessionAffinityRebindOn: readText(source.session_affinity_rebind_on).toLowerCase(),
    generatedAtMs: readInstantMs(source.generated_at),
    providers: (Array.isArray(source.providers) ? source.providers : [])
      .filter(isRecord)
      .map(normalizeProvider)
      .filter((provider): provider is RoutingPreferenceProvider => provider !== null),
  };
}

const normalizeHistoryPoint = (value: Record<string, unknown>): QuotaHistoryPoint | null => {
  const tMs = readInstantMs(value.t ?? value.observed_at);
  if (tMs === null) return null;
  return { tMs, windows: normalizeQuotaWindows(value.windows) ?? [] };
};

const normalizeHistoryAccount = (value: Record<string, unknown>): QuotaHistoryAccount | null => {
  const id = readText(value.id);
  const authIndex = readText(value.auth_index) || (readNumber(value.auth_index)?.toString() ?? '');
  const name = readText(value.name);
  if (!id && !authIndex && !name) return null;
  const points = (Array.isArray(value.points) ? value.points : [])
    .filter(isRecord)
    .map(normalizeHistoryPoint)
    .filter((point): point is QuotaHistoryPoint => point !== null)
    .sort((left, right) => left.tMs - right.tMs);
  return {
    id,
    authIndex,
    name,
    email: readText(value.email),
    disabled: value.disabled === true,
    points,
  };
};

const normalizeHistoryProvider = (value: Record<string, unknown>): QuotaHistoryProvider | null => {
  const provider = readText(value.provider).toLowerCase();
  if (!provider) return null;
  return {
    provider,
    accounts: (Array.isArray(value.accounts) ? value.accounts : [])
      .filter(isRecord)
      .map(normalizeHistoryAccount)
      .filter((account): account is QuotaHistoryAccount => account !== null),
  };
};

export function normalizeQuotaHistory(value: unknown): QuotaHistory {
  const source = isRecord(value) ? value : {};
  const retention = readNumber(source.retention_hours);
  return {
    generatedAtMs: readInstantMs(source.generated_at),
    retentionHours: retention !== null && retention > 0 ? retention : null,
    providers: (Array.isArray(source.providers) ? source.providers : [])
      .filter(isRecord)
      .map(normalizeHistoryProvider)
      .filter((provider): provider is QuotaHistoryProvider => provider !== null),
  };
}

const isNotFound = (error: unknown): boolean =>
  isRecord(error) && (error as { status?: unknown }).status === 404;

export const quotaPoolApi = {
  /** Resolves null when the backend predates the preference route (404). */
  async getRoutingPreference(): Promise<RoutingPreference | null> {
    try {
      return normalizeRoutingPreference(await apiClient.get<unknown>('/routing/preference'));
    } catch (error: unknown) {
      if (isNotFound(error)) return null;
      throw error;
    }
  },

  /**
   * Recorded quota windows since `sinceMs` (the backend defaults to 14 days back).
   * Resolves null when the backend predates the history route (404).
   */
  async getQuotaHistory(sinceMs?: number | null): Promise<QuotaHistory | null> {
    const params =
      sinceMs !== undefined && sinceMs !== null && Number.isFinite(sinceMs)
        ? { since: new Date(sinceMs).toISOString() }
        : undefined;
    try {
      return normalizeQuotaHistory(
        await apiClient.get<unknown>('/quota/history', params ? { params } : undefined)
      );
    } catch (error: unknown) {
      if (isNotFound(error)) return null;
      throw error;
    }
  },
};
