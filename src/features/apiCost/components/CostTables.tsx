/**
 * Per-model and per-credential cost tables for the selected range, most expensive first.
 */

import { useTranslation } from 'react-i18next';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { formatCompactNumber, formatPercent } from '@/utils/format';
import { getTypeLabel } from '@/features/authFiles/constants';
import { maskIdentity } from '@/features/quota/pool/overviewFormat';
import { formatUsd, totalTokens, type AccountRow, type ModelRow } from '../aggregate';
import styles from '../ApiCostPage.module.scss';

const formatShare = (share: number) =>
  formatPercent(share * 100, share > 0 && share < 0.01 ? 2 : 1);

export function CostModelTable({ rows }: { rows: readonly ModelRow[] }) {
  const { t } = useTranslation();
  return (
    <Table aria-label={t('api_cost.models_title')}>
      <TableHeader>
        <TableRow>
          <TableHead>{t('api_cost.col_model')}</TableHead>
          <TableHead alignRight>{t('api_cost.col_requests')}</TableHead>
          <TableHead alignRight>{t('api_cost.col_input')}</TableHead>
          <TableHead alignRight>{t('api_cost.col_cache_read')}</TableHead>
          <TableHead alignRight>{t('api_cost.col_cache_write')}</TableHead>
          <TableHead alignRight>{t('api_cost.col_output')}</TableHead>
          <TableHead alignRight>{t('api_cost.col_cost')}</TableHead>
          <TableHead alignRight>{t('api_cost.col_share')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.model} data-model={row.model}>
            <TableCell>
              <span className={styles.cellStack}>
                <span className={styles.modelName}>{row.model || t('api_cost.model_unknown')}</span>
                {row.totals.unpricedRequests > 0 && (
                  <span className={`${styles.badge} ${styles.badgeWarning}`}>
                    {t('api_cost.badge_unpriced')}
                  </span>
                )}
              </span>
            </TableCell>
            <TableCell alignRight className={styles.num}>
              {formatCompactNumber(row.totals.requests)}
            </TableCell>
            <TableCell alignRight className={styles.num}>
              {formatCompactNumber(row.totals.inputTokens)}
            </TableCell>
            <TableCell alignRight className={styles.num}>
              {formatCompactNumber(row.totals.cacheReadTokens)}
            </TableCell>
            <TableCell alignRight className={styles.num}>
              {formatCompactNumber(row.totals.cacheWriteTokens)}
            </TableCell>
            <TableCell alignRight className={styles.num}>
              {formatCompactNumber(row.totals.outputTokens)}
            </TableCell>
            <TableCell alignRight className={styles.numStrong}>
              {formatUsd(row.totals.costUsd)}
            </TableCell>
            <TableCell alignRight className={styles.num}>
              {formatShare(row.share)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export interface CostAccountTableProps {
  rows: readonly AccountRow[];
  showEmails: boolean;
}

export function CostAccountTable({ rows, showEmails }: CostAccountTableProps) {
  const { t } = useTranslation();
  return (
    <Table aria-label={t('api_cost.accounts_title')}>
      <TableHeader>
        <TableRow>
          <TableHead>{t('api_cost.col_account')}</TableHead>
          <TableHead>{t('api_cost.col_provider')}</TableHead>
          <TableHead alignRight>{t('api_cost.col_requests')}</TableHead>
          <TableHead alignRight>{t('api_cost.col_tokens')}</TableHead>
          <TableHead alignRight>{t('api_cost.col_cost')}</TableHead>
          <TableHead alignRight>{t('api_cost.col_share')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          // Credential file names often contain the email, so mask the name as well.
          const identity = row.email || row.name;
          const secondary = row.email && row.name !== row.email ? row.name : '';
          return (
            <TableRow key={row.id || '__unattributed__'}>
              <TableCell>
                <span className={styles.cellStack}>
                  {identity ? (
                    <span
                      className={showEmails ? styles.identity : styles.identityMasked}
                      title={showEmails ? identity : undefined}
                    >
                      {showEmails ? identity : maskIdentity(identity)}
                    </span>
                  ) : (
                    <span className={styles.identity}>{t('api_cost.account_unattributed')}</span>
                  )}
                  {row.id && !row.known && (
                    <span className={styles.badge}>{t('api_cost.account_removed')}</span>
                  )}
                  {row.disabled && (
                    <span className={styles.badge}>{t('api_cost.account_disabled')}</span>
                  )}
                </span>
                {showEmails && secondary && (
                  <span className={styles.identitySub} title={secondary}>
                    {secondary}
                  </span>
                )}
              </TableCell>
              <TableCell>{row.provider ? getTypeLabel(t, row.provider) : '—'}</TableCell>
              <TableCell alignRight className={styles.num}>
                {formatCompactNumber(row.totals.requests)}
              </TableCell>
              <TableCell alignRight className={styles.num}>
                {formatCompactNumber(totalTokens(row.totals))}
              </TableCell>
              <TableCell alignRight className={styles.numStrong}>
                {formatUsd(row.totals.costUsd)}
              </TableCell>
              <TableCell alignRight className={styles.num}>
                {formatShare(row.share)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
