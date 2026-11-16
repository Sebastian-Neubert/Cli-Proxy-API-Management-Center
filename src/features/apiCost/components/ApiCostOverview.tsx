/**
 * API cost overview for a loaded report: pricing note, window tiles, daily stacked chart
 * and the per-model / per-credential tables for the selected range.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconEye, IconEyeOff } from '@/components/ui/icons';
import type { ResolvedTheme } from '@/types/quota';
import type { ApiCostReport } from '@/types/apiCost';
import { formatCompactNumber } from '@/utils/format';
import {
  OTHER_SERIES,
  RANGE_DAYS,
  buildDailyCost,
  bucketsSince,
  formatUsd,
  totalTokens,
  totalsByAccount,
  totalsByModel,
  unpricedModels,
  windowStartMs,
  windowSummaries,
  type CostTotals,
  type RangeDays,
} from '../aggregate';
import { seriesColors } from '../chartColors';
import { CostDailyChart } from './CostDailyChart';
import { CostAccountTable, CostModelTable } from './CostTables';
import styles from '../ApiCostPage.module.scss';

export interface ApiCostOverviewProps {
  report: ApiCostReport;
  nowMs: number;
  rangeDays: RangeDays;
  onRangeChange: (days: RangeDays) => void;
  resolvedTheme: ResolvedTheme;
  /** Initial chart width for static rendering. */
  initialWidth?: number;
}

export function ApiCostOverview({
  report,
  nowMs,
  rangeDays,
  onRangeChange,
  resolvedTheme,
  initialWidth,
}: ApiCostOverviewProps) {
  const { t, i18n } = useTranslation();
  const [showEmails, setShowEmails] = useState(false);

  const { buckets, accounts, pricing } = report;
  const summaries = useMemo(() => windowSummaries(buckets, nowMs), [buckets, nowMs]);
  const daily = useMemo(
    () => buildDailyCost(buckets, nowMs, rangeDays),
    [buckets, nowMs, rangeDays]
  );
  const rangeBuckets = useMemo(
    () => bucketsSince(buckets, windowStartMs(nowMs, rangeDays)),
    [buckets, nowMs, rangeDays]
  );
  const modelRows = useMemo(() => totalsByModel(rangeBuckets), [rangeBuckets]);
  const accountRows = useMemo(
    () => totalsByAccount(rangeBuckets, accounts),
    [rangeBuckets, accounts]
  );
  const unpriced = useMemo(() => unpricedModels(modelRows), [modelRows]);
  const colors = seriesColors(daily, resolvedTheme);
  const rangeTotal = daily.series.reduce((sum, series) => sum + series.costUsd, 0);

  const dateTimeFormat = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const sourceLabel =
    pricing.source === 'remote' || pricing.source === 'embedded'
      ? t(`api_cost.source_${pricing.source}`)
      : pricing.source || t('api_cost.unknown');
  const seriesLabel = (key: string) =>
    key === OTHER_SERIES ? t('api_cost.other_models') : key || t('api_cost.model_unknown');
  const rangeText = t('api_cost.range_days', { count: rangeDays });

  const tiles: Array<{ key: string; label: string; totals: CostTotals }> = [
    { key: 'today', label: t('api_cost.tile_today'), totals: summaries.today },
    { key: '7d', label: t('api_cost.tile_7d'), totals: summaries.last7 },
    { key: '30d', label: t('api_cost.tile_30d'), totals: summaries.last30 },
  ];

  return (
    <div className={styles.overview}>
      <p className={styles.note}>{t('api_cost.note')}</p>
      <p className={styles.pricingMeta}>
        {t('api_cost.pricing_info', {
          source: sourceLabel,
          loaded:
            pricing.loadedAtMs === null
              ? t('api_cost.unknown')
              : dateTimeFormat.format(new Date(pricing.loadedAtMs)),
          models: pricing.models.toLocaleString(i18n.resolvedLanguage),
        })}
      </p>
      {pricing.source === 'embedded' && (
        <div className={styles.warning} role="note">
          {t('api_cost.pricing_embedded_warning')}
        </div>
      )}
      {pricing.lastError && (
        <div className={styles.warning} role="note">
          {t('api_cost.pricing_error_warning', { message: pricing.lastError })}
        </div>
      )}

      <dl className={styles.summary}>
        {tiles.map((tile) => (
          <div key={tile.key} className={styles.summaryTile} data-window={tile.key}>
            <dt>{tile.label}</dt>
            <dd>
              <span className={styles.summaryValue}>{formatUsd(tile.totals.costUsd)}</span>
              <span className={styles.summaryDetail}>
                {t('api_cost.tile_detail', {
                  requests: formatCompactNumber(tile.totals.requests),
                  tokens: formatCompactNumber(totalTokens(tile.totals)),
                })}
              </span>
            </dd>
          </div>
        ))}
      </dl>

      <section className={styles.card} aria-label={t('api_cost.chart_title')}>
        <header className={styles.cardHead}>
          <h2 className={styles.cardTitle}>
            {t('api_cost.chart_title')}
            <span className={styles.cardCount}>
              {t('api_cost.range_total', { total: formatUsd(rangeTotal), range: rangeText })}
            </span>
          </h2>
          <div className={styles.segmented} role="group" aria-label={t('api_cost.range_label')}>
            {RANGE_DAYS.map((days) => (
              <button
                key={days}
                type="button"
                aria-pressed={rangeDays === days}
                onClick={() => onRangeChange(days)}
              >
                {t('api_cost.range_days', { count: days })}
              </button>
            ))}
          </div>
        </header>
        <CostDailyChart
          model={daily}
          colors={colors}
          seriesLabel={seriesLabel}
          label={t('api_cost.chart_label', { range: rangeText, total: formatUsd(rangeTotal) })}
          initialWidth={initialWidth}
        />
        {daily.series.length > 0 && (
          <ul className={styles.legend} aria-label={t('api_cost.legend_label')}>
            {daily.series.map((series, index) => (
              <li key={series.key} className={styles.legendItem}>
                <span className={styles.swatch} style={{ background: colors[index] }} />
                {seriesLabel(series.key)}
                <span className={styles.legendValue}>{formatUsd(series.costUsd)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {unpriced.length > 0 && (
        <div className={styles.warning} role="note">
          <span className={styles.warningTitle}>{t('api_cost.unpriced_title')}</span>
          <span>{t('api_cost.unpriced_desc')}</span>
          <ul className={styles.unpricedList}>
            {unpriced.map((item) => (
              <li key={item.model}>
                {item.model}{' '}
                <span>
                  {t('api_cost.requests_value', {
                    value: formatCompactNumber(item.requests),
                  })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className={styles.card} aria-label={t('api_cost.models_title')}>
        <header className={styles.cardHead}>
          <h2 className={styles.cardTitle}>
            {t('api_cost.models_title')}
            <span className={styles.cardCount}>{rangeText}</span>
          </h2>
        </header>
        {modelRows.length > 0 ? (
          <CostModelTable rows={modelRows} />
        ) : (
          <p className={styles.hint}>{t('api_cost.table_empty')}</p>
        )}
      </section>

      <section className={styles.card} aria-label={t('api_cost.accounts_title')}>
        <header className={styles.cardHead}>
          <h2 className={styles.cardTitle}>
            {t('api_cost.accounts_title')}
            <span className={styles.cardCount}>{rangeText}</span>
          </h2>
          <div className={styles.segmented}>
            <button
              type="button"
              aria-pressed={showEmails}
              onClick={() => setShowEmails((value) => !value)}
            >
              {showEmails ? <IconEyeOff size={14} /> : <IconEye size={14} />}
              {t('api_cost.show_emails')}
            </button>
          </div>
        </header>
        {accountRows.length > 0 ? (
          <CostAccountTable rows={accountRows} showEmails={showEmails} />
        ) : (
          <p className={styles.hint}>{t('api_cost.table_empty')}</p>
        )}
      </section>
    </div>
  );
}
