/**
 * Quota pool: pooled limits, routing preference and cache affinity for Claude/Codex
 * subscription accounts. Read-only apart from the inline enable switch, which reuses
 * `PATCH /credentials/status`. Never touches the usage queue.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconRefreshCw } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { apiClient } from '@/services/api/client';
import { authFilesApi } from '@/services/api/authFiles';
import { quotaPoolApi } from '@/services/api/quotaPool';
import { useAuthStore, useNotificationStore, useThemeStore } from '@/stores';
import type { AuthFileItem } from '@/types/authFile';
import type { QuotaHistory, RoutingPreference } from '@/types/quotaPool';
import { DAY_MS } from '@/utils/time/durations';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import bodyStyles from '../components/QuotaBody.module.scss';
import headerStyles from '../components/QuotaHeader.module.scss';
import { bindQuotaClasses } from '../types';
import { PoolAccountCard } from './components/PoolAccountCard';
import { PoolOverview, type HistoryStatus } from './components/PoolOverview';
import { PoolRoutingPanel } from './components/PoolRoutingPanel';
import { PoolSummaryRow } from './components/PoolSummaryRow';
import {
  POOL_PROVIDERS,
  buildPoolAccounts,
  summarizePool,
  type PoolAccount,
  type PoolProvider,
} from './logic';
import styles from './QuotaPoolPage.module.scss';

/** Bind the quota-page row styles to the shared rendering contract. */
const quotaClasses = bindQuotaClasses(bodyStyles, 'QuotaBody.module.scss');

/** The backend defaults `since` to 14 days back; only ask explicitly for older data. */
const DEFAULT_HISTORY_SPAN_MS = 14 * DAY_MS;

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

export function QuotaPoolPage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const nowMs = useNow();

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [preference, setPreference] = useState<RoutingPreference | null>(null);
  const [preferenceMissing, setPreferenceMissing] = useState(false);
  const [preferenceError, setPreferenceError] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [history, setHistory] = useState<QuotaHistory | null>(null);
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus>('loading');
  const [historyError, setHistoryError] = useState('');
  const requestRef = useRef(0);
  const historyRequestRef = useRef(0);
  /** Explicit `since` once the user navigated beyond the default span; null = default. */
  const historySinceRef = useRef<number | null>(null);

  const connected = connectionStatus === 'connected';

  const loadHistory = useCallback(async () => {
    const requestId = ++historyRequestRef.current;
    const revision = apiClient.getConnectionRevision();
    const isCurrent = () =>
      requestId === historyRequestRef.current && revision === apiClient.getConnectionRevision();
    if (!connected) {
      setHistory(null);
      setHistoryStatus('loading');
      return;
    }
    try {
      const result = await quotaPoolApi.getQuotaHistory(historySinceRef.current);
      if (!isCurrent()) return;
      setHistory(result);
      setHistoryStatus(result === null ? 'missing' : 'ok');
      setHistoryError('');
    } catch (err: unknown) {
      if (!isCurrent()) return;
      setHistory(null);
      setHistoryStatus('error');
      setHistoryError(errorMessage(err, t('common.unknown_error')));
    }
  }, [connected, t]);

  const handleNeedHistorySince = useCallback(
    (sinceMs: number) => {
      const loadedSince = historySinceRef.current ?? Date.now() - DEFAULT_HISTORY_SPAN_MS;
      if (sinceMs >= loadedSince) return;
      historySinceRef.current = sinceMs;
      void loadHistory();
    },
    [loadHistory]
  );

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    const revision = apiClient.getConnectionRevision();
    const isCurrent = () =>
      requestId === requestRef.current && revision === apiClient.getConnectionRevision();
    if (!connected) {
      setFiles([]);
      setPreference(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    const [filesResult, preferenceResult] = await Promise.allSettled([
      authFilesApi.list(),
      quotaPoolApi.getRoutingPreference(),
      loadHistory(),
    ]);
    if (!isCurrent()) return;
    if (filesResult.status === 'fulfilled') {
      setFiles(filesResult.value?.files ?? []);
    } else {
      setError(errorMessage(filesResult.reason, t('notification.refresh_failed')));
    }
    if (preferenceResult.status === 'fulfilled') {
      setPreference(preferenceResult.value);
      setPreferenceMissing(preferenceResult.value === null);
      setPreferenceError('');
    } else {
      setPreference(null);
      setPreferenceMissing(false);
      setPreferenceError(errorMessage(preferenceResult.reason, t('common.unknown_error')));
    }
    setLoading(false);
  }, [connected, loadHistory, t]);

  useHeaderRefresh(load);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
      historyRequestRef.current += 1;
    };
  }, [load]);

  const handleToggle = useCallback(
    async (account: PoolAccount, enabled: boolean) => {
      const { file, key } = account;
      if (pending.has(key)) return;
      const revision = apiClient.getConnectionRevision();
      setPending((previous) => new Set(previous).add(key));
      try {
        await authFilesApi.setStatus(
          file.name,
          !enabled,
          String(file.authIndex ?? '').trim() || undefined
        );
        if (revision !== apiClient.getConnectionRevision()) return;
        showNotification(
          enabled
            ? t('auth_files.status_enabled_success', { name: file.name })
            : t('auth_files.status_disabled_success', { name: file.name }),
          'success'
        );
      } catch (err: unknown) {
        if (revision !== apiClient.getConnectionRevision()) return;
        showNotification(
          t('quota_pool.toggle_failed', {
            name: file.name,
            message: errorMessage(err, t('common.unknown_error')),
          }),
          'error'
        );
      } finally {
        setPending((previous) => {
          const next = new Set(previous);
          next.delete(key);
          return next;
        });
      }
      if (revision === apiClient.getConnectionRevision()) await load();
    },
    [load, pending, showNotification, t]
  );

  const accountsByProvider = useMemo(
    () => buildPoolAccounts(files, preference),
    [files, preference]
  );
  const visibleProviders = POOL_PROVIDERS.filter(
    (provider) => accountsByProvider[provider].length > 0
  );
  const totalAccounts = visibleProviders.reduce(
    (sum, provider) => sum + accountsByProvider[provider].length,
    0
  );

  const rebindMode = preference?.sessionAffinityRebindOn || 'any';

  const renderProviderIcon = (provider: PoolProvider) => {
    const iconSrc = getAuthFileIcon(provider, resolvedTheme);
    return (
      <span
        className={styles.providerIcon}
        style={
          isThemeSurfaceIconProvider(provider)
            ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
            : undefined
        }
      >
        {iconSrc ? <img src={iconSrc} alt="" /> : getTypeLabel(t, provider).slice(0, 1)}
      </span>
    );
  };

  return (
    <div className={styles.page}>
      <header className={headerStyles.header}>
        <div className={headerStyles.copy}>
          <h1 className={headerStyles.title}>{t('quota_pool.title')}</h1>
          <p className={headerStyles.meta}>
            <span className={headerStyles.metaTotal}>
              {t('quota_pool.meta_accounts', { count: totalAccounts })}
            </span>
            {preference && (
              <>
                <span className={headerStyles.metaDot} aria-hidden="true">
                  ·
                </span>
                <span
                  className={
                    preference.strategyActive ? headerStyles.metaLoaded : headerStyles.metaMuted
                  }
                >
                  {t('quota_pool.meta_strategy', { strategy: preference.strategy })}
                </span>
                <span className={headerStyles.metaDot} aria-hidden="true">
                  ·
                </span>
                <span className={headerStyles.metaMuted}>
                  {preference.sessionAffinity
                    ? t('quota_pool.meta_affinity_on', {
                        mode: t(`quota_pool.rebind_${rebindMode}`, { defaultValue: rebindMode }),
                      })
                    : t('quota_pool.meta_affinity_off')}
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
            {t('quota_pool.refresh')}
          </button>
        </div>
      </header>

      <p className={styles.note}>{t('quota_pool.in_memory_note')}</p>
      {preference && !preference.strategyActive && (
        <p className={styles.note}>
          {t('quota_pool.strategy_inactive_note', { strategy: preference.strategy })}
        </p>
      )}
      {preferenceMissing && <p className={styles.note}>{t('quota_pool.routing_unavailable')}</p>}
      {preferenceError && (
        <div className={styles.errorBanner} role="alert">
          {t('quota_pool.routing_error', { message: preferenceError })}
        </div>
      )}
      {error && (
        <div className={styles.errorBanner} role="alert">
          {error}
        </div>
      )}

      {loading && files.length === 0 ? (
        <div className={styles.accounts} aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} height={220} rounded={14} />
          ))}
        </div>
      ) : visibleProviders.length === 0 ? (
        !error && (
          <EmptyState
            title={t('quota_pool.empty_title')}
            description={t('quota_pool.empty_desc')}
          />
        )
      ) : (
        <>
          <PoolOverview
            providers={visibleProviders}
            accountsByProvider={accountsByProvider}
            history={history}
            historyStatus={historyStatus}
            historyError={historyError}
            nowMs={nowMs}
            resolvedTheme={resolvedTheme}
            labelFor={(provider) => getTypeLabel(t, provider)}
            iconFor={renderProviderIcon}
            onNeedHistorySince={handleNeedHistorySince}
          />
          {visibleProviders.map((provider) => {
            const accounts = accountsByProvider[provider];
            const label = getTypeLabel(t, provider);
            return (
              <section key={provider} className={styles.provider} aria-label={label}>
                <h2 className={styles.providerTitle}>
                  {renderProviderIcon(provider)}
                  {label}
                </h2>
                <PoolSummaryRow summary={summarizePool(accounts, nowMs)} nowMs={nowMs} />
                {preference && (
                  <PoolRoutingPanel
                    preference={preference}
                    provider={preference.providers.find((item) => item.provider === provider)}
                    nowMs={nowMs}
                  />
                )}
                <p className={styles.hint}>{t('quota_pool.usage_hint')}</p>
                <div className={styles.accounts}>
                  {accounts.map((account) => (
                    <PoolAccountCard
                      key={account.key}
                      account={account}
                      classes={quotaClasses}
                      nowMs={nowMs}
                      pending={pending.has(account.key)}
                      disableControls={!connected}
                      onToggle={(target, enabled) => void handleToggle(target, enabled)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
