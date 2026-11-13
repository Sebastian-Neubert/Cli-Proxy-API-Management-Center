/**
 * Pool-level figures for one provider: accounts, long-window usage, earliest long reset
 * and the pooled 24h cache-read share.
 */

import { useTranslation } from 'react-i18next';
import { formatPercent } from '@/utils/format';
import { buildResetDisplay } from '@/utils/quota/relativeTime';
import type { PoolSummary } from '../logic';
import styles from '../QuotaPoolPage.module.scss';

export interface PoolSummaryRowProps {
  summary: PoolSummary;
  nowMs: number;
}

export function PoolSummaryRow({ summary, nowMs }: PoolSummaryRowProps) {
  const { t, i18n } = useTranslation();
  const unknown = t('quota_pool.unknown');
  const percent = (value: number | null) => (value === null ? unknown : formatPercent(value, 1));
  const reset =
    summary.earliestLongResetMs !== null
      ? buildResetDisplay(null, summary.earliestLongResetMs, nowMs, i18n.resolvedLanguage)
      : null;

  const tiles: Array<{ key: string; label: string; value: string; detail?: string }> = [
    {
      key: 'accounts',
      label: t('quota_pool.summary_accounts'),
      value: t('quota_pool.summary_accounts_value', {
        enabled: summary.enabledCount,
        total: summary.accountCount,
      }),
    },
    {
      key: 'avg',
      label: t('quota_pool.summary_avg_long'),
      value: percent(summary.avgLongUsedPercent),
    },
    {
      key: 'max',
      label: t('quota_pool.summary_max_long'),
      value: percent(summary.maxLongUsedPercent),
    },
    {
      key: 'reset',
      label: t('quota_pool.summary_earliest_reset'),
      value: reset ? reset.absolute : unknown,
      detail: reset?.relative ?? undefined,
    },
    {
      key: 'unknown',
      label: t('quota_pool.summary_unknown_reset'),
      value: String(summary.unknownResetCount),
    },
    {
      key: 'cache',
      label: t('quota_pool.summary_cache_share'),
      value:
        summary.cacheReadShare24h === null
          ? unknown
          : formatPercent(summary.cacheReadShare24h * 100, 1),
    },
  ];

  return (
    <dl className={styles.summary}>
      {tiles.map((tile) => (
        <div key={tile.key} className={styles.summaryTile} data-summary={tile.key}>
          <dt className={styles.summaryLabel}>{tile.label}</dt>
          <dd className={styles.summaryValue}>
            {tile.value}
            {tile.detail && <span className={styles.summaryDetail}>{tile.detail}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
