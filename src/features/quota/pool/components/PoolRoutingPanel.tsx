/**
 * Which account soonest-reset routing prefers for a provider, and the full ranking.
 * When another strategy is active the same ranking is labelled as a preview.
 */

import { useTranslation } from 'react-i18next';
import type { RoutingPreference, RoutingPreferenceProvider } from '@/types/quotaPool';
import { buildResetDisplay } from '@/utils/quota/relativeTime';
import styles from '../QuotaPoolPage.module.scss';

export interface PoolRoutingPanelProps {
  preference: RoutingPreference;
  provider: RoutingPreferenceProvider | undefined;
  nowMs: number;
}

export function PoolRoutingPanel({ preference, provider, nowMs }: PoolRoutingPanelProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const candidates = provider?.candidates ?? [];
  const preferred = candidates.find((candidate) => candidate.preferred);

  return (
    <section className={styles.routing} aria-label={t('quota_pool.routing_title')}>
      <div className={styles.routingHead}>
        <span className={styles.routingTitle}>
          {preference.strategyActive
            ? t('quota_pool.routing_preferred')
            : t('quota_pool.routing_preview')}
        </span>
        <span className={styles.routingPreferred}>
          {preferred
            ? preferred.email
              ? `${preferred.name} · ${preferred.email}`
              : preferred.name
            : t('quota_pool.routing_preferred_none')}
        </span>
      </div>
      {candidates.length > 0 && (
        <ol className={styles.ranking} aria-label={t('quota_pool.routing_ranking')}>
          {candidates.map((candidate) => {
            const reset =
              candidate.resetAtMs !== null
                ? buildResetDisplay(null, candidate.resetAtMs, nowMs, locale)
                : null;
            return (
              <li
                key={candidate.id || candidate.name}
                className={`${styles.rankingItem} ${
                  candidate.preferred ? styles.rankingPreferred : ''
                } ${candidate.available ? '' : styles.rankingUnavailable}`}
              >
                <span className={styles.rank}>
                  {t('quota_pool.rank', { rank: candidate.rank })}
                </span>
                <span className={styles.rankingName} title={candidate.email || candidate.name}>
                  {candidate.name}
                </span>
                <span className={styles.rankingReset}>
                  {reset
                    ? `${candidate.window ? `${candidate.window} · ` : ''}${reset.absolute}${
                        reset.relative ? ` · ${reset.relative}` : ''
                      }`
                    : t('quota_pool.reset_unknown')}
                </span>
                <span className={styles.badges}>
                  {candidate.preferred && (
                    <span className={`${styles.badge} ${styles.badgePreferred}`}>
                      {t('quota_pool.badge_preferred')}
                    </span>
                  )}
                  {candidate.disabled ? (
                    <span className={styles.badge}>{t('quota_pool.badge_disabled')}</span>
                  ) : (
                    !candidate.available && (
                      <span className={`${styles.badge} ${styles.badgeWarning}`}>
                        {t('quota_pool.badge_unavailable')}
                      </span>
                    )
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
