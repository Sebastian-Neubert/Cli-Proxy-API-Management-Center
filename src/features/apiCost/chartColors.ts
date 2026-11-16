/** Chart colors for the daily cost stack. */

import type { ResolvedTheme } from '@/types/quota';
import { OTHER_SERIES, type DailyCostModel } from './aggregate';

/** Categorical slots (fixed order, validated for CVD separation) per theme; gray = other. */
const SERIES_COLORS: Record<ResolvedTheme, { slots: string[]; other: string }> = {
  light: {
    slots: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'],
    other: '#a8a6a0',
  },
  dark: {
    slots: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c'],
    other: '#6b6963',
  },
};

/** Colors aligned with `model.series`; "other" is always gray. */
export function seriesColors(model: DailyCostModel, theme: ResolvedTheme): string[] {
  const palette = SERIES_COLORS[theme] ?? SERIES_COLORS.light;
  let slot = 0;
  return model.series.map((series) =>
    series.key === OTHER_SERIES
      ? palette.other
      : (palette.slots[slot++ % palette.slots.length] as string)
  );
}
