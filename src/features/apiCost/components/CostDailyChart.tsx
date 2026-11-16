/**
 * Daily estimated cost as stacked bars (plain SVG), one segment per top model plus
 * "other". Hovering a day (or moving with the arrow keys) shows the per-model split.
 * All aggregation lives in aggregate.ts.
 */

import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { formatCompactNumber } from '@/utils/format';
import { costAxis, formatUsd, formatUsdTick, type DailyCostModel } from '../aggregate';
import styles from '../ApiCostPage.module.scss';

export interface CostDailyChartProps {
  model: DailyCostModel;
  colors: readonly string[];
  /** Display name per series key. */
  seriesLabel: (key: string) => string;
  /** Accessible name of the chart. */
  label: string;
  /** Initial width before the first measurement (and for static rendering). */
  initialWidth?: number;
}

const HEIGHT = 260;
const MARGIN = { top: 14, right: 12, bottom: 28, left: 56 };
const SEGMENT_GAP = 2;
const BAR_RADIUS = 4;

function useElementWidth(initial: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(initial);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const next = Math.round(element.clientWidth);
      if (next > 0) setWidth(next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Rectangle with rounded top corners only (the data end of a bar). */
function topRoundedBar(x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.max(0, Math.min(radius, width / 2, height));
  const round = (value: number) => Math.round(value * 10) / 10;
  return [
    `M${round(x)} ${round(y + height)}`,
    `L${round(x)} ${round(y + r)}`,
    `Q${round(x)} ${round(y)} ${round(x + r)} ${round(y)}`,
    `L${round(x + width - r)} ${round(y)}`,
    `Q${round(x + width)} ${round(y)} ${round(x + width)} ${round(y + r)}`,
    `L${round(x + width)} ${round(y + height)}`,
    'Z',
  ].join('');
}

export function CostDailyChart({
  model,
  colors,
  seriesLabel,
  label,
  initialWidth = 960,
}: CostDailyChartProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const [containerRef, width] = useElementWidth(initialWidth);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const formats = useMemo(
    () => ({
      short: new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric' }),
      date: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }),
      long: new Intl.DateTimeFormat(locale, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      }),
    }),
    [locale]
  );

  const days = model.days;
  const plotWidth = Math.max(120, width - MARGIN.left - MARGIN.right);
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const baseline = MARGIN.top + plotHeight;
  const slot = plotWidth / Math.max(1, days.length);
  const barWidth = Math.max(2, Math.min(36, slot * 0.72));
  const { max: yMax, ticks: yTicks } = costAxis(model.maxCostUsd);
  const y = (value: number) => baseline - (Math.max(0, value) / yMax) * plotHeight;
  const xCenter = (index: number) => MARGIN.left + slot * (index + 0.5);
  const labelStride = Math.max(1, Math.ceil(58 / Math.max(1, slot)));
  const dayLabel = days.length <= 7 ? formats.short : formats.date;

  const bars = days.map((point, index) => {
    const x = xCenter(index) - barWidth / 2;
    const segments: Array<{ key: string; color: string; y: number; height: number }> = [];
    let cumulative = 0;
    point.values.forEach((value, seriesIndex) => {
      if (!(value > 0)) return;
      const bottom = y(cumulative);
      cumulative += value;
      const top = y(cumulative);
      // Keep a surface gap above every lower segment.
      const height = bottom - top - (segments.length > 0 ? SEGMENT_GAP : 0);
      if (height < 0.5) return;
      segments.push({
        key: model.series[seriesIndex]?.key ?? String(seriesIndex),
        color: colors[seriesIndex] ?? 'currentColor',
        y: top,
        height,
      });
    });
    return { dayMs: point.dayMs, x, segments };
  });

  const handlePointer = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!(rect.width > 0) || days.length === 0) return;
    const x = ((event.clientX - rect.left) / rect.width) * width;
    const index = Math.floor((x - MARGIN.left) / slot);
    setHoverIndex(index >= 0 && index < days.length ? index : null);
  };

  const handleKey = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key === 'Escape') {
      setHoverIndex(null);
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (days.length === 0) return;
    event.preventDefault();
    const step = event.key === 'ArrowLeft' ? -1 : 1;
    setHoverIndex((current) =>
      Math.min(days.length - 1, Math.max(0, (current ?? days.length) + step))
    );
  };

  const hovered = hoverIndex !== null ? days[hoverIndex] : undefined;
  const hoverX = hoverIndex !== null ? xCenter(hoverIndex) : 0;

  return (
    <div ref={containerRef} className={styles.chart}>
      <svg
        className={styles.chartSvg}
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="img"
        aria-label={label}
        tabIndex={0}
        onPointerMove={handlePointer}
        onPointerLeave={() => setHoverIndex(null)}
        onBlur={() => setHoverIndex(null)}
        onKeyDown={handleKey}
      >
        <g className={styles.chartGrid}>
          {yTicks.map((value) => (
            <g key={value}>
              <line x1={MARGIN.left} x2={MARGIN.left + plotWidth} y1={y(value)} y2={y(value)} />
              <text x={MARGIN.left - 8} y={y(value) + 4} textAnchor="end">
                {formatUsdTick(value)}
              </text>
            </g>
          ))}
          {days.map((point, index) =>
            (days.length - 1 - index) % labelStride === 0 ? (
              <text key={point.dayMs} x={xCenter(index)} y={HEIGHT - 8} textAnchor="middle">
                {dayLabel.format(new Date(point.dayMs))}
              </text>
            ) : null
          )}
        </g>

        {hoverIndex !== null && (
          <rect
            className={styles.chartHoverBand}
            x={MARGIN.left + slot * hoverIndex}
            y={MARGIN.top}
            width={slot}
            height={plotHeight}
            pointerEvents="none"
          />
        )}

        {bars.map((bar) => (
          <g key={bar.dayMs} data-day={bar.dayMs}>
            {bar.segments.map((segment, index) =>
              index === bar.segments.length - 1 ? (
                <path
                  key={segment.key}
                  d={topRoundedBar(bar.x, segment.y, barWidth, segment.height, BAR_RADIUS)}
                  fill={segment.color}
                />
              ) : (
                <rect
                  key={segment.key}
                  x={bar.x}
                  y={segment.y}
                  width={barWidth}
                  height={segment.height}
                  fill={segment.color}
                />
              )
            )}
          </g>
        ))}
      </svg>
      {hovered && (
        <div
          className={styles.chartTooltip}
          role="status"
          style={{
            left: hoverX,
            transform: hoverX > width / 2 ? 'translateX(calc(-100% - 14px))' : 'translateX(14px)',
          }}
        >
          <div className={styles.chartTooltipHead}>
            <span>{formats.long.format(new Date(hovered.dayMs))}</span>
            <strong>{formatUsd(hovered.totals.costUsd)}</strong>
          </div>
          <div className={styles.chartTooltipMeta}>
            {t('api_cost.requests_value', {
              value: formatCompactNumber(hovered.totals.requests),
            })}
          </div>
          {hovered.values.some((value) => value > 0) && (
            <ul className={styles.chartTooltipList}>
              {model.series.map((series, index) => {
                const value = hovered.values[index] ?? 0;
                if (!(value > 0)) return null;
                return (
                  <li key={series.key}>
                    <span className={styles.swatch} style={{ background: colors[index] }} />
                    <span className={styles.chartTooltipName}>{seriesLabel(series.key)}</span>
                    <span className={styles.chartTooltipValue}>{formatUsd(value)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
