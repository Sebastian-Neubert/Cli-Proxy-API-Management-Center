/**
 * Estimated API list-price cost (`GET /observability/usage/cost`).
 *
 * The proxy prices every request with ccusage's formula from LiteLLM model prices and
 * aggregates the results per UTC hour, model and credential. These are theoretical list
 * prices; subscription usage is not billed this way.
 */

/** One UTC hour of one model on one credential. Token buckets are mutually exclusive. */
export interface ApiCostBucket {
  /** Start of the UTC hour (epoch ms). */
  hourMs: number;
  model: string;
  /** '' when the backend did not report it. */
  provider: string;
  /** '' when the request was not attributed to a credential. */
  authId: string;
  requests: number;
  /** Requests whose model has no known price; their tokens are counted but cost 0. */
  unpricedRequests: number;
  /** Uncached input tokens (excludes cache reads and writes). */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** A credential that still exists; buckets may reference removed ones. */
export interface ApiCostAccount {
  id: string;
  name: string;
  email: string;
  provider: string;
  disabled: boolean;
}

export interface ApiCostPricing {
  /** `remote` (LiteLLM download) or `embedded` (built-in snapshot). */
  source: string;
  url: string;
  /** null when unknown. */
  loadedAtMs: number | null;
  models: number;
  /** Last refresh failure; '' when none. */
  lastError: string;
}

export interface ApiCostUnpricedModel {
  model: string;
  requests: number;
}

export interface ApiCostReport {
  generatedAtMs: number | null;
  sinceMs: number | null;
  retentionDays: number | null;
  pricing: ApiCostPricing;
  buckets: ApiCostBucket[];
  accounts: ApiCostAccount[];
  unpricedModels: ApiCostUnpricedModel[];
}
