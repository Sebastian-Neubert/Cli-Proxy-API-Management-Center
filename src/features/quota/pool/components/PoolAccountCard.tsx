/**
 * One Claude/Codex account in the pool: every quota window, routing rank, cache-read share
 * (the session-affinity indicator) and an inline enable switch.
 */

import { useTranslation } from 'react-i18next';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import type { TokenUsageTotals } from '@/types/quotaPool';
import { formatCompactNumber, formatPercent } from '@/utils/format';
import { buildResetDisplay } from '@/utils/quota/relativeTime';
import { isRuntimeOnlyAuthFile } from '@/features/authFiles/constants';
import { QuotaMeter } from '../../components/QuotaMeter';
import { QuotaResetLabel } from '../../components/QuotaResetLabel';
import type { QuotaClassMap } from '../../types';
import { cacheReadShare, windowLengthParts, windowTone, type PoolAccount } from '../logic';
import styles from '../QuotaPoolPage.module.scss';

export interface PoolAccountCardProps {
  account: PoolAccount;
  /** Quota row/meter classes shared with the quota cards (bound by the host page). */
  classes: QuotaClassMap;
  nowMs: number;
  pending: boolean;
  disableControls: boolean;
  onToggle: (account: PoolAccount, enabled: boolean) => void;
}

const formatShare = (share: number | null, unknown: string): string =>
  share === null ? unknown : formatPercent(share * 100, 1);

export function PoolAccountCard({
  account,
  classes: quotaClasses,
  nowMs,
  pending,
  disableControls,
  onToggle,
}: PoolAccountCardProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const { file, candidate, windows } = account;
  const enabled = file.disabled !== true;
  const unknown = t('quota_pool.unknown');
  const usage = file.tokenUsage;

  const usageColumn = (label: string, totals: TokenUsageTotals | undefined) => (
    <div className={styles.usageColumn}>
      <div className={styles.usageHead}>
        <span className={styles.usageLabel}>{label}</span>
        <span className={styles.usageShare}>{formatShare(cacheReadShare(totals), unknown)}</span>
      </div>
      {totals ? (
        <dl className={styles.usageList}>
          <dt>{t('quota_pool.usage_requests')}</dt>
          <dd>
            {formatCompactNumber(totals.requests)}
            {totals.failed > 0 && (
              <span className={styles.usageFailed}>
                {' '}
                {t('quota_pool.usage_failed', { count: totals.failed })}
              </span>
            )}
          </dd>
          <dt>{t('quota_pool.usage_input')}</dt>
          <dd>{formatCompactNumber(totals.inputTokens)}</dd>
          <dt>{t('quota_pool.usage_cache_read')}</dt>
          <dd>{formatCompactNumber(totals.cacheReadTokens)}</dd>
          <dt>{t('quota_pool.usage_cache_write')}</dt>
          <dd>{formatCompactNumber(totals.cacheWriteTokens)}</dd>
          <dt>{t('quota_pool.usage_output')}</dt>
          <dd>{formatCompactNumber(totals.outputTokens)}</dd>
        </dl>
      ) : null}
    </div>
  );

  return (
    <article
      className={`${styles.account} ${enabled ? '' : styles.accountDisabled}`}
      data-pool-account={account.key}
    >
      <header className={styles.accountHead}>
        <div className={styles.accountIdentity}>
          <span className={styles.accountName} title={file.name}>
            {candidate ? (
              <span className={styles.rank}>{t('quota_pool.rank', { rank: candidate.rank })}</span>
            ) : null}
            {file.name}
          </span>
          {file.email && <span className={styles.accountEmail}>{file.email}</span>}
          <span className={styles.badges}>
            {candidate?.preferred && (
              <span className={`${styles.badge} ${styles.badgePreferred}`}>
                {t('quota_pool.badge_preferred')}
              </span>
            )}
            {!enabled && <span className={styles.badge}>{t('quota_pool.badge_disabled')}</span>}
            {enabled && (file.unavailable === true || candidate?.available === false) && (
              <span className={`${styles.badge} ${styles.badgeWarning}`}>
                {t('quota_pool.badge_unavailable')}
              </span>
            )}
          </span>
        </div>
        {!isRuntimeOnlyAuthFile(file) && (
          <ToggleSwitch
            checked={enabled}
            disabled={disableControls || pending}
            onChange={(value) => onToggle(account, value)}
            ariaLabel={t('quota_pool.toggle_label', { name: file.name })}
          />
        )}
      </header>

      <section className={styles.windows} aria-label={t('quota_pool.windows_title')}>
        {windows.length === 0 ? (
          <p className={styles.muted}>{t('quota_pool.windows_empty')}</p>
        ) : (
          windows.map((window, index) => {
            const length = windowLengthParts(window.windowMinutes);
            const tone = windowTone(window.status);
            const reset =
              window.resetAtMs !== null
                ? buildResetDisplay(null, window.resetAtMs, nowMs, locale)
                : null;
            return (
              <div key={`${window.name}-${index}`} className={quotaClasses.quotaRow}>
                <div className={quotaClasses.quotaRowHeader}>
                  <span className={quotaClasses.quotaModel}>
                    {window.name || unknown}
                    {length && (
                      <span className={styles.windowLength}>
                        {t(`quota_pool.window_length_${length.unit}`, { count: length.value })}
                      </span>
                    )}
                  </span>
                  <div className={quotaClasses.quotaMeta}>
                    <span className={`${styles.status} ${styles[`status_${tone}`]}`}>
                      {t(`quota_pool.status_${tone}`)}
                    </span>
                    <span className={quotaClasses.quotaPercent}>
                      {window.usedPercent === null
                        ? unknown
                        : t('quota_pool.window_used', {
                            percent: formatPercent(window.usedPercent, 1),
                          })}
                    </span>
                  </div>
                </div>
                <QuotaMeter
                  percent={window.usedPercent === null ? null : 100 - window.usedPercent}
                  classes={quotaClasses}
                  index={index}
                />
                <div className={styles.windowReset}>
                  {reset ? (
                    <QuotaResetLabel display={reset} classes={quotaClasses} />
                  ) : (
                    <span className={quotaClasses.quotaReset}>
                      {t('quota_pool.window_reset_unknown')}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </section>

      <section className={styles.usage} aria-label={t('quota_pool.usage_title')}>
        <div className={styles.usageTitle}>{t('quota_pool.usage_title')}</div>
        {usage ? (
          <div className={styles.usageColumns}>
            {usageColumn(t('quota_pool.usage_hour'), usage.currentHour)}
            {usageColumn(t('quota_pool.usage_24h'), usage.last24h)}
          </div>
        ) : (
          <p className={styles.muted}>{t('quota_pool.usage_empty')}</p>
        )}
      </section>
    </article>
  );
}
