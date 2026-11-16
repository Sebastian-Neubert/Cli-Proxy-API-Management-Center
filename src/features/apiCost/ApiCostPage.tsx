/**
 * API cost: what the proxied traffic would cost at public API list prices, computed by
 * the proxy like ccusage from LiteLLM prices (`GET /observability/usage/cost`).
 * Read-only; never touches the usage queue.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconRefreshCw } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { apiClient } from '@/services/api/client';
import { apiCostApi } from '@/services/api/apiCost';
import { useAuthStore, useThemeStore } from '@/stores';
import type { ApiCostReport } from '@/types/apiCost';
import { formatCompactNumber } from '@/utils/format';
import headerStyles from '@/features/quota/components/QuotaHeader.module.scss';
import { sumSince, windowStartMs, type RangeDays } from './aggregate';
import { ApiCostOverview } from './components/ApiCostOverview';
import styles from './ApiCostPage.module.scss';

/** The backend defaults `since` to 30 days back; only ask explicitly for longer ranges. */
const DEFAULT_SPAN_DAYS = 30;
const MAX_RANGE_DAYS: RangeDays = 90;

type LoadStatus = 'loading' | 'ok' | 'missing' | 'error';

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

export function ApiCostPage() {
  const { t, i18n } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const nowMs = useNow();

  const [report, setReport] = useState<ApiCostReport | null>(null);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rangeDays, setRangeDays] = useState<RangeDays>(30);
  const requestRef = useRef(0);
  /** Explicit `since` once a range beyond the default span was selected; null = default. */
  const sinceRef = useRef<number | null>(null);

  const connected = connectionStatus === 'connected';

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    const revision = apiClient.getConnectionRevision();
    const isCurrent = () =>
      requestId === requestRef.current && revision === apiClient.getConnectionRevision();
    if (!connected) {
      setReport(null);
      setStatus('loading');
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      let result = await apiCostApi.getUsageCost(sinceRef.current, isCurrent);
      if (!isCurrent()) return;
      if (result && result.buckets.length === 0 && sinceRef.current === null) {
        // Nothing in the default window: look at the longest range before showing the empty
        // state, so usage retained from 31-90 days ago stays reachable.
        sinceRef.current = windowStartMs(Date.now(), MAX_RANGE_DAYS);
        result = await apiCostApi.getUsageCost(sinceRef.current, isCurrent);
        if (!isCurrent()) return;
        if (result && result.buckets.length > 0) setRangeDays(MAX_RANGE_DAYS);
      }
      setReport(result);
      setStatus(result === null ? 'missing' : 'ok');
      setError('');
    } catch (err: unknown) {
      if (!isCurrent()) return;
      setStatus('error');
      setError(errorMessage(err, t('common.unknown_error')));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [connected, t]);

  useHeaderRefresh(load);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  const handleRangeChange = useCallback(
    (days: RangeDays) => {
      setRangeDays(days);
      if (days <= DEFAULT_SPAN_DAYS) return;
      const sinceMs = windowStartMs(Date.now(), days);
      if (sinceRef.current !== null && sinceRef.current <= sinceMs) return;
      sinceRef.current = sinceMs;
      void load();
    },
    [load]
  );

  const last30 = report ? sumSince(report.buckets, windowStartMs(nowMs, 30)) : null;
  const generatedFormat = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <div className={styles.page}>
      <header className={headerStyles.header}>
        <div className={headerStyles.copy}>
          <h1 className={headerStyles.title}>{t('api_cost.title')}</h1>
          <p className={headerStyles.meta}>
            <span className={headerStyles.metaTotal}>
              {t('api_cost.meta_requests', {
                value: formatCompactNumber(last30?.requests ?? 0),
              })}
            </span>
            {report?.generatedAtMs != null && (
              <>
                <span className={headerStyles.metaDot} aria-hidden="true">
                  ·
                </span>
                <span className={headerStyles.metaMuted}>
                  {t('api_cost.meta_generated', {
                    time: generatedFormat.format(new Date(report.generatedAtMs)),
                  })}
                </span>
              </>
            )}
          </p>
        </div>
        <div className={headerStyles.actions}>
          <button
            type="button"
            className={headerStyles.primaryAction}
            onClick={() => void load()}
            disabled={!connected || loading}
          >
            <IconRefreshCw size={14} className={loading ? headerStyles.spinning : undefined} />
            {t('api_cost.refresh')}
          </button>
        </div>
      </header>

      {status === 'missing' && <p className={styles.note}>{t('api_cost.missing')}</p>}
      {status === 'error' && (
        <div className={styles.errorBanner} role="alert">
          {t('api_cost.load_error', { message: error })}
        </div>
      )}

      {report === null ? (
        status === 'loading' || (loading && status !== 'missing') ? (
          <div className={styles.overview} aria-hidden="true">
            <Skeleton height={96} rounded={14} />
            <Skeleton height={320} rounded={14} />
            <Skeleton height={220} rounded={14} />
          </div>
        ) : null
      ) : report.buckets.length === 0 ? (
        <>
          <p className={styles.note}>{t('api_cost.note')}</p>
          <EmptyState
            title={t('api_cost.empty_title')}
            description={t('api_cost.empty_desc', {
              days: report.retentionDays ?? 90,
            })}
          />
        </>
      ) : (
        <ApiCostOverview
          report={report}
          nowMs={nowMs}
          rangeDays={rangeDays}
          onRangeChange={handleRangeChange}
          resolvedTheme={resolvedTheme}
        />
      )}
    </div>
  );
}
