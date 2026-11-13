/** Display helpers for the pooled-quota overview cards. */

import type { TFunction } from 'i18next';
import { durationParts } from './projection';

/** Keep the first two characters; hide the rest of an identity. */
export function maskIdentity(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return `${trimmed.slice(0, 2)}•••`;
}

/** Two largest duration units, e.g. "15h 49m". */
export function formatDuration(t: TFunction, ms: number): string {
  return durationParts(ms)
    .map((part) => t(`quota_pool.window_length_${part.unit}`, { count: part.value }))
    .join(' ');
}
