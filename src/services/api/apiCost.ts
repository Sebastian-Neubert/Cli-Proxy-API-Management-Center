/**
 * Estimated API list-price cost (v8 management API).
 *
 * `GET /observability/usage/cost?since=<RFC3339>` returns hourly cost buckets per model and
 * credential (default since: 30 days back). Older backends answer with 404.
 */

import { apiClient } from './client';
import { isRecord } from '@/utils/helpers';
import { parseTimestampMs } from '@/utils/timestamp';
import type {
  ApiCostAccount,
  ApiCostBucket,
  ApiCostPricing,
  ApiCostReport,
  ApiCostUnpricedModel,
} from '@/types/apiCost';

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

const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const normalizeBucket = (value: Record<string, unknown>): ApiCostBucket | null => {
  const hourMs = readInstantMs(value.hour);
  if (hourMs === null) return null;
  return {
    hourMs,
    model: readText(value.model),
    provider: readText(value.provider).toLowerCase(),
    authId: readText(value.auth_id),
    requests: readCount(value.requests),
    unpricedRequests: readCount(value.unpriced_requests),
    inputTokens: readCount(value.input_tokens),
    cacheReadTokens: readCount(value.cache_read_tokens),
    cacheWriteTokens: readCount(value.cache_write_tokens),
    outputTokens: readCount(value.output_tokens),
    costUsd: readCount(value.cost_usd),
  };
};

const normalizeAccount = (value: Record<string, unknown>): ApiCostAccount | null => {
  const id = readText(value.id);
  if (!id) return null;
  return {
    id,
    name: readText(value.name) || id,
    email: readText(value.email),
    provider: readText(value.provider).toLowerCase(),
    disabled: value.disabled === true,
  };
};

const normalizePricing = (value: unknown): ApiCostPricing => {
  const source = isRecord(value) ? value : {};
  return {
    source: readText(source.source).toLowerCase(),
    url: readText(source.url),
    loadedAtMs: readInstantMs(source.loaded_at),
    models: readCount(source.models),
    lastError: readText(source.last_error),
  };
};

export function normalizeApiCostReport(value: unknown): ApiCostReport {
  const source = isRecord(value) ? value : {};
  const retention = readNumber(source.retention_days);
  return {
    generatedAtMs: readInstantMs(source.generated_at),
    sinceMs: readInstantMs(source.since),
    retentionDays: retention !== null && retention > 0 ? retention : null,
    pricing: normalizePricing(source.pricing),
    buckets: records(source.buckets)
      .map(normalizeBucket)
      .filter((bucket): bucket is ApiCostBucket => bucket !== null),
    accounts: records(source.accounts)
      .map(normalizeAccount)
      .filter((account): account is ApiCostAccount => account !== null),
    unpricedModels: records(source.unpriced_models)
      .map<ApiCostUnpricedModel>((item) => ({
        model: readText(item.model),
        requests: readCount(item.requests),
      }))
      .filter((item) => item.model)
      .sort(
        (left, right) => right.requests - left.requests || left.model.localeCompare(right.model)
      ),
  };
}

const isNotFound = (error: unknown): boolean =>
  isRecord(error) && (error as { status?: unknown }).status === 404;

export const apiCostApi = {
  /**
   * Hourly cost buckets since `sinceMs` (the backend defaults to 30 days back).
   * Resolves null when the backend predates the cost route (404).
   */
  async getUsageCost(sinceMs?: number | null): Promise<ApiCostReport | null> {
    const params =
      sinceMs !== undefined && sinceMs !== null && Number.isFinite(sinceMs)
        ? { since: new Date(sinceMs).toISOString() }
        : undefined;
    try {
      return normalizeApiCostReport(
        await apiClient.get<unknown>('/observability/usage/cost', params ? { params } : undefined)
      );
    } catch (error: unknown) {
      if (isNotFound(error)) return null;
      throw error;
    }
  },
};
