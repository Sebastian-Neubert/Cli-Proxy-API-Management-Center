/**
 * Subscription usage overview: toolbar plus one pooled-quota chart card per provider.
 * History comes from `GET /quota/history`; without it only the current-state projection
 * is drawn.
 */

import { useId, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/Select';
import { IconEye, IconEyeOff } from '@/components/ui/icons';
import type { ResolvedTheme } from '@/types/quota';
import type { QuotaHistory } from '@/types/quotaPool';
import { TYPE_COLORS } from '@/utils/quota';
import { HOUR_MS } from '@/utils/time/durations';
import type { PoolAccount, PoolProvider } from '../logic';
import {
  BURN_WINDOWS_HOURS,
  buildOverviewAccounts,
  buildOverviewModel,
  overviewRange,
  type BurnWindowHours,
} from '../overview';
import type { FutureUsage } from '../projection';
import { PoolOverviewCard } from './PoolOverviewCard';
import type { OverviewView } from './PoolOverviewChart';
import styles from '../QuotaPoolPage.module.scss';

export type HistoryStatus = 'ok' | 'missing' | 'error' | 'loading';

export interface PoolOverviewProps {
  providers: readonly PoolProvider[];
  accountsByProvider: Record<PoolProvider, PoolAccount[]>;
  history: QuotaHistory | null;
  historyStatus: HistoryStatus;
  historyError?: string;
  nowMs: number;
  resolvedTheme: ResolvedTheme;
  labelFor: (provider: PoolProvider) => string;
  iconFor: (provider: PoolProvider) => ReactNode;
  /** Called with the earliest instant the visible range (plus burn window) needs. */
  onNeedHistorySince?: (sinceMs: number) => void;
  /** Initial chart width for static rendering. */
  initialWidth?: number;
}

const MAX_BURN_WINDOW_MS = Math.max(...BURN_WINDOWS_HOURS) * HOUR_MS;

/** Claude keeps its provider orange; Codex uses a blue tone so the two cards read apart. */
const providerColor = (provider: PoolProvider, theme: ResolvedTheme): string => {
  if (provider === 'codex') return theme === 'dark' ? '#7aa7ff' : '#2f6fdf';
  const colors = TYPE_COLORS[provider] ?? TYPE_COLORS.claude;
  return (colors?.[theme] ?? colors?.light)?.text ?? '#c05621';
};

export function PoolOverview({
  providers,
  accountsByProvider,
  history,
  historyStatus,
  historyError,
  nowMs,
  resolvedTheme,
  labelFor,
  iconFor,
  onNeedHistorySince,
  initialWidth,
}: PoolOverviewProps) {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<OverviewView>('remaining');
  const [burnWindowHours, setBurnWindowHours] = useState<BurnWindowHours>(3);
  const [futureUsage, setFutureUsage] = useState<FutureUsage>('same');
  const [showAccounts, setShowAccounts] = useState(false);
  const [showEmails, setShowEmails] = useState(false);
  const [offset, setOffset] = useState(0);

  const { startMs, endMs } = overviewRange(nowMs, offset);
  const hasHistory = historyStatus === 'ok' && history !== null;

  const burnLabelId = useId();

  /** Navigate by whole weeks; earlier ranges may need older history (plus a burn window). */
  const goTo = (nextOffset: number) => {
    setOffset(nextOffset);
    const next = overviewRange(nowMs, nextOffset);
    onNeedHistorySince?.(Math.min(next.startMs, nowMs) - MAX_BURN_WINDOW_MS);
  };

  const models = useMemo(
    () =>
      providers.map((provider) => {
        const historyProvider =
          history?.providers.find((item) => item.provider === provider) ?? null;
        const accounts = buildOverviewAccounts(
          accountsByProvider[provider],
          historyProvider,
          nowMs
        );
        return {
          provider,
          model: buildOverviewModel(accounts, {
            nowMs,
            startMs,
            endMs,
            burnWindowHours,
            futureUsage,
            hasHistory,
          }),
        };
      }),
    [
      providers,
      history,
      accountsByProvider,
      nowMs,
      startMs,
      endMs,
      burnWindowHours,
      futureUsage,
      hasHistory,
    ]
  );

  const dateFormat = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    month: 'short',
    day: 'numeric',
  });

  return (
    <section className={styles.overview} aria-label={t('quota_pool.overview_title')}>
      <div className={styles.overviewToolbar}>
        <div
          className={styles.segmented}
          role="group"
          aria-label={t('quota_pool.overview_view_label')}
        >
          {(['remaining', 'drain'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              onClick={() => setView(value)}
            >
              {t(`quota_pool.overview_view_${value}`)}
            </button>
          ))}
        </div>

        <div className={styles.toolbarGroup}>
          <span className={styles.toolbarLabel} id={burnLabelId}>
            {t('quota_pool.overview_burn_label')}
          </span>
          <div className={styles.segmented} role="group" aria-labelledby={burnLabelId}>
            {BURN_WINDOWS_HOURS.map((hours) => (
              <button
                key={hours}
                type="button"
                aria-pressed={burnWindowHours === hours}
                onClick={() => setBurnWindowHours(hours)}
              >
                {t('quota_pool.window_length_hour', { count: hours })}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.toolbarGroup}>
          <span className={styles.toolbarLabel}>{t('quota_pool.overview_future_label')}</span>
          <Select
            value={futureUsage}
            onChange={(value) => setFutureUsage(value === 'none' ? 'none' : 'same')}
            options={[
              { value: 'same', label: t('quota_pool.overview_future_same') },
              { value: 'none', label: t('quota_pool.overview_future_none') },
            ]}
            ariaLabel={t('quota_pool.overview_future_label')}
            size="sm"
            fullWidth={false}
          />
        </div>

        <div className={styles.segmented}>
          <button
            type="button"
            aria-pressed={showAccounts}
            onClick={() => setShowAccounts((value) => !value)}
          >
            {t('quota_pool.overview_accounts_toggle')}
          </button>
        </div>

        <div className={styles.segmented}>
          <button
            type="button"
            aria-pressed={showEmails}
            onClick={() => setShowEmails((value) => !value)}
          >
            {showEmails ? <IconEyeOff size={14} /> : <IconEye size={14} />}
            {t('quota_pool.overview_show_emails')}
          </button>
        </div>

        <div className={styles.toolbarRange}>
          <span className={styles.toolbarLabel}>
            {t('quota_pool.overview_range', {
              start: dateFormat.format(new Date(startMs)),
              end: dateFormat.format(new Date(endMs)),
            })}
          </span>
          <div className={styles.segmented}>
            <button
              type="button"
              onClick={() => goTo(offset - 1)}
              aria-label={t('quota_pool.overview_prev')}
            >
              ‹
            </button>
            <button type="button" onClick={() => goTo(0)} disabled={offset === 0}>
              {t('quota_pool.overview_today')}
            </button>
            <button
              type="button"
              onClick={() => goTo(offset + 1)}
              aria-label={t('quota_pool.overview_next')}
            >
              ›
            </button>
          </div>
        </div>
      </div>

      {historyStatus === 'missing' && (
        <p className={styles.hint}>{t('quota_pool.overview_history_missing')}</p>
      )}
      {historyStatus === 'error' && (
        <div className={styles.errorBanner} role="alert">
          {t('quota_pool.overview_history_error', { message: historyError ?? '' })}
        </div>
      )}

      {models.map(({ provider, model }) =>
        model.accounts.length === 0 ? null : (
          <PoolOverviewCard
            key={provider}
            label={labelFor(provider)}
            icon={iconFor(provider)}
            model={model}
            view={view}
            showAccounts={showAccounts}
            showEmails={showEmails}
            burnWindowHours={burnWindowHours}
            startMs={startMs}
            endMs={endMs}
            nowMs={nowMs}
            color={providerColor(provider, resolvedTheme)}
            initialWidth={initialWidth}
          />
        )
      )}
    </section>
  );
}
