/**
 * Pooled quota and routing preference types.
 *
 * The proxy derives these from real upstream responses held in memory; every
 * field is optional on the wire and absent on older backends.
 */

/** One upstream rate-limit window (Claude `5h`/`7d`, Codex `primary`/`secondary`). */
export interface QuotaWindow {
  name: string;
  /** Window length in minutes; null when the upstream did not report it. */
  windowMinutes: number | null;
  /** Reset instant (epoch ms); null when unknown. */
  resetAtMs: number | null;
  /** Raw upstream status such as `allowed`, `allowed_warning` or `rejected`; '' when unknown. */
  status: string;
  /** Used share of the window, 0-100; null when unknown. */
  usedPercent: number | null;
}

/** The long (>= 24h) window reset that soonest-reset routing ranks on. */
export interface QuotaResetInfo {
  resetAtMs: number;
  window: string;
  windowMinutes: number | null;
  observedAtMs: number | null;
}

/** Mutually exclusive token buckets: input tokens exclude cache reads and writes. */
export interface TokenUsageTotals {
  requests: number;
  failed: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface TokenUsageSnapshot {
  currentHour: TokenUsageTotals;
  last24h: TokenUsageTotals;
}

export interface RoutingPreferenceCandidate {
  rank: number;
  id: string;
  authIndex: string;
  name: string;
  available: boolean;
  disabled: boolean;
  preferred: boolean;
  email: string;
  resetAtMs: number | null;
  window: string;
}

export interface RoutingPreferenceProvider {
  provider: string;
  /** '' when no available account has a known reset (routing round-robins among unknowns). */
  preferredId: string;
  candidates: RoutingPreferenceCandidate[];
}

export interface RoutingPreference {
  strategy: string;
  strategyActive: boolean;
  sessionAffinity: boolean;
  sessionAffinityRebindOn: string;
  generatedAtMs: number | null;
  providers: RoutingPreferenceProvider[];
}
