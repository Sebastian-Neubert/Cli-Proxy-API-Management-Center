/**
 * One provider's pooled weekly quota: headline remaining, projected empty times, next
 * reset, burn rate, and the chart.
 */

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { OverviewModel } from '../overview';
import { formatBurnRate, formatPoolPercent, formatRestored } from '../projection';
import { formatDuration, maskIdentity } from '../overviewFormat';
import { PoolOverviewChart, type OverviewView } from './PoolOverviewChart';
import styles from '../QuotaPoolPage.module.scss';

export interface PoolOverviewCardProps {
  label: string;
  icon: ReactNode;
  model: OverviewModel;
  view: OverviewView;
  showAccounts: boolean;
  showEmails: boolean;
  burnWindowHours: number;
  startMs: number;
  endMs: number;
  nowMs: number;
  color: string;
  initialWidth?: number;
}

export function PoolOverviewCard({
  label,
  icon,
  model,
  view,
  showAccounts,
  showEmails,
  burnWindowHours,
  startMs,
  endMs,
  nowMs,
  color,
  initialWidth,
}: PoolOverviewCardProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const timeFormat = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
  const dateFormat = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
  const notBy = t('quota_pool.overview_not_by', {
    date: dateFormat.format(new Date(model.horizonEndMs)),
  });
  const relative = (tMs: number) =>
    tMs <= nowMs
      ? t('quota_pool.overview_now_lower')
      : t('quota_pool.overview_in', { duration: formatDuration(t, tMs - nowMs) });

  const { poolEmptyMs, firstEmpty } = model.projection;
  const firstAccount = firstEmpty ? model.accounts[firstEmpty.index] : null;
  const firstIdentity = firstAccount ? firstAccount.email || firstAccount.name : '';

  const stats: Array<{ key: string; label: string; value: ReactNode }> = [
    {
      key: 'pool-empty',
      label: t('quota_pool.overview_pool_empty'),
      value:
        poolEmptyMs === null
          ? notBy
          : poolEmptyMs <= nowMs
            ? t('quota_pool.overview_now_lower')
            : timeFormat.format(new Date(poolEmptyMs)),
    },
    {
      key: 'first-empty',
      label: t('quota_pool.overview_first_empty'),
      value: firstEmpty ? (
        <>
          {firstIdentity && (
            <span
              className={showEmails ? styles.overviewIdentity : styles.overviewIdentityMasked}
              title={showEmails ? firstIdentity : undefined}
            >
              {showEmails ? firstIdentity : maskIdentity(firstIdentity)}
            </span>
          )}
          {relative(firstEmpty.tMs)}
        </>
      ) : (
        notBy
      ),
    },
    {
      key: 'next-reset',
      label: t('quota_pool.overview_next_reset'),
      value: model.nextReset ? (
        <>
          <strong>{formatRestored(model.nextReset.amount)}</strong>{' '}
          {timeFormat.format(new Date(model.nextReset.tMs))}
        </>
      ) : (
        t('quota_pool.unknown')
      ),
    },
    {
      key: 'burn',
      label: t('quota_pool.overview_burn_stat', { hours: burnWindowHours }),
      value:
        model.burnPerHour === null ? t('quota_pool.unknown') : formatBurnRate(model.burnPerHour),
    },
  ];

  const chartLabel = t('quota_pool.overview_chart_label', {
    provider: label,
    remaining: formatPoolPercent(model.remaining),
    capacity: formatPoolPercent(model.capacity),
  });

  return (
    <article className={styles.overviewCard} aria-label={label} data-provider-overview={label}>
      <header className={styles.overviewHead}>
        <div className={styles.overviewTitleBlock}>
          <h3 className={styles.overviewTitle}>
            {icon}
            {label}
            <span className={styles.overviewCount}>
              {t('quota_pool.meta_accounts', { count: model.accounts.length })}
            </span>
          </h3>
          <p className={styles.overviewHeadline}>
            <span className={styles.overviewBig}>{formatPoolPercent(model.remaining)}</span>
            <span className={styles.overviewOf}>
              {t('quota_pool.overview_of_capacity', {
                capacity: formatPoolPercent(model.capacity),
              })}
            </span>
          </p>
        </div>
        <dl className={styles.overviewStats}>
          {stats.map((stat) => (
            <div key={stat.key} className={styles.overviewStat} data-stat={stat.key}>
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
      </header>

      <PoolOverviewChart
        model={model}
        view={view}
        showAccounts={showAccounts}
        startMs={startMs}
        endMs={endMs}
        nowMs={nowMs}
        color={color}
        label={chartLabel}
        initialWidth={initialWidth}
      />

      <footer className={styles.overviewLegend}>
        <span className={styles.overviewLegendTitle}>{t('quota_pool.overview_legend_pool')}</span>
        <span className={styles.overviewLegendItem}>
          <svg width="22" height="8" aria-hidden="true">
            <line x1="1" x2="21" y1="4" y2="4" stroke={color} strokeWidth="2" />
          </svg>
          {t('quota_pool.overview_legend_recorded')}
        </span>
        <span className={styles.overviewLegendItem}>
          <svg width="22" height="8" aria-hidden="true">
            <line
              x1="1"
              x2="21"
              y1="4"
              y2="4"
              stroke={color}
              strokeWidth="2"
              strokeDasharray="4 3"
            />
          </svg>
          {t('quota_pool.overview_legend_projected')}
        </span>
        {showAccounts && view === 'remaining' && (
          <span className={styles.overviewLegendItem}>
            <svg width="22" height="8" aria-hidden="true">
              <line x1="1" x2="21" y1="4" y2="4" stroke={color} strokeWidth="1" opacity="0.5" />
            </svg>
            {t('quota_pool.overview_legend_accounts')}
          </span>
        )}
        {model.unknownCount > 0 && (
          <span className={styles.overviewLegendNote}>
            {t('quota_pool.overview_unknown_accounts', { count: model.unknownCount })}
          </span>
        )}
      </footer>
    </article>
  );
}
