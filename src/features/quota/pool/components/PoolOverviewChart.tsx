/**
 * Pooled weekly quota chart (plain SVG): recorded pool remaining (solid + area), the
 * projection (dashed), reset jumps, the "Now" marker and the projected empty point.
 * The drain-rate view plots the recorded trailing burn instead. All maths lives in
 * projection.ts / chartGeometry.ts.
 */

import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { HOUR_MS } from '@/utils/time/durations';
import {
  areaPath,
  clipSeries,
  dayTicks,
  interpolateAt,
  linePath,
  niceCeil,
  placeLabels,
  tickStride,
  type Scale,
  type XYPoint,
} from '../chartGeometry';
import type { OverviewModel } from '../overview';
import { formatBurnRate, formatPoolPercent, formatRestored } from '../projection';
import styles from '../QuotaPoolPage.module.scss';

export type OverviewView = 'remaining' | 'drain';

export interface PoolOverviewChartProps {
  model: OverviewModel;
  view: OverviewView;
  showAccounts: boolean;
  startMs: number;
  endMs: number;
  nowMs: number;
  color: string;
  /** Accessible name of the chart. */
  label: string;
  /** Initial width before the first measurement (and for static rendering). */
  initialWidth?: number;
}

const HEIGHT = 300;
const MARGIN = { top: 34, right: 14, bottom: 28, left: 52 };

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

/** Nearest point by time (values only). */
function nearest(points: readonly XYPoint[], tMs: number): XYPoint | null {
  let best: XYPoint | null = null;
  for (const point of points) {
    if (point.value === null) continue;
    if (!best || Math.abs(point.tMs - tMs) < Math.abs(best.tMs - tMs)) best = point;
  }
  return best;
}

export function PoolOverviewChart({
  model,
  view,
  showAccounts,
  startMs,
  endMs,
  nowMs,
  color,
  label,
  initialWidth = 960,
}: PoolOverviewChartProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const [containerRef, width] = useElementWidth(initialWidth);
  const [hoverMs, setHoverMs] = useState<number | null>(null);
  const gradientId = `pool-area-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const formats = useMemo(
    () => ({
      time: new Intl.DateTimeFormat(locale, {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      }),
      weekday: new Intl.DateTimeFormat(locale, { weekday: 'short' }),
      dayOfMonth: new Intl.DateTimeFormat(locale, { day: 'numeric' }),
    }),
    [locale]
  );

  const plotWidth = Math.max(120, width - MARGIN.left - MARGIN.right);
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const rangeMs = Math.max(1, endMs - startMs);
  const isDrain = view === 'drain';
  const burn = model.burnPerHour ?? 0;

  const recorded: XYPoint[] = useMemo(
    () =>
      isDrain
        ? model.drain.map((point) => ({ tMs: point.tMs, value: point.value }))
        : model.recorded.points.map((point) => ({ tMs: point.tMs, value: point.value })),
    [isDrain, model]
  );
  const projected: XYPoint[] = useMemo(() => {
    if (isDrain) {
      const from = Math.max(nowMs, startMs);
      if (from >= endMs || model.burnPerHour === null) return [];
      return [
        { tMs: from, value: burn },
        { tMs: endMs, value: burn },
      ];
    }
    return clipSeries(model.projection.points, startMs, endMs);
  }, [isDrain, nowMs, startMs, endMs, model, burn]);

  const yMax = isDrain
    ? niceCeil(Math.max(1, burn, ...recorded.map((point) => point.value ?? 0)) * 1.15)
    : Math.max(100, model.capacity);

  const scale: Scale = {
    x: (tMs) => MARGIN.left + ((tMs - startMs) / rangeMs) * plotWidth,
    y: (value) => MARGIN.top + plotHeight * (1 - Math.min(1, Math.max(0, value / yMax))),
  };
  const baseline = scale.y(0);
  const formatValue = (value: number) =>
    isDrain ? formatBurnRate(value) : formatPoolPercent(value);

  const ticks = dayTicks(startMs, endMs);
  const stride = tickStride(plotWidth, rangeMs);

  const accountLines = useMemo(() => {
    if (!showAccounts || isDrain) return [];
    return model.accounts.map((account, index) => ({
      key: account.key,
      recorded: model.recorded.points.map((point) => ({
        tMs: point.tMs,
        value: point.perAccount[index] ?? null,
      })),
      projected: clipSeries(
        model.projection.points.map((point) => ({
          tMs: point.tMs,
          value: point.perAccount[index] ?? null,
        })),
        startMs,
        endMs
      ),
    }));
  }, [showAccounts, isDrain, model, startMs, endMs]);

  const annotations = isDrain
    ? []
    : placeLabels(
        [
          ...model.recorded.resets.map((reset) => ({ reset, points: model.recorded.points })),
          ...model.projection.resets.map((reset) => ({ reset, points: model.projection.points })),
        ]
          .filter(({ reset }) => reset.tMs >= startMs && reset.tMs <= endMs)
          .map(({ reset, points }) => ({
            key: `${reset.tMs}-${reset.amount}`,
            x: scale.x(reset.tMs),
            y: scale.y(interpolateAt(points, reset.tMs) ?? 0) - 8,
            text: formatRestored(reset.amount),
          }))
      );

  const nowVisible = nowMs >= startMs && nowMs <= endMs;
  const emptyMs = model.projection.poolEmptyMs;
  const emptyVisible =
    !isDrain && emptyMs !== null && emptyMs >= startMs && emptyMs <= endMs && burn > 0;

  // Hover: recorded before now, projected after.
  let hover: { x: number; y: number; text: string } | null = null;
  if (hoverMs !== null) {
    const isRecorded = hoverMs <= nowMs && recorded.length > 0;
    const point = isRecorded
      ? nearest(recorded, hoverMs)
      : { tMs: hoverMs, value: interpolateAt(projected, hoverMs) };
    if (point && point.value !== null) {
      const time = formats.time.format(new Date(point.tMs));
      const kind = isRecorded
        ? t('quota_pool.overview_recorded')
        : t('quota_pool.overview_projected');
      const value = formatValue(point.value);
      hover = {
        x: scale.x(point.tMs),
        y: scale.y(point.value),
        text: isDrain
          ? t('quota_pool.overview_tooltip_rate', { time, value, kind })
          : t('quota_pool.overview_tooltip_left', { time, value, kind }),
      };
    }
  }

  const handlePointer = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    const x = ((event.clientX - rect.left) / rect.width) * width;
    const ratio = (x - MARGIN.left) / plotWidth;
    if (ratio < 0 || ratio > 1) {
      setHoverMs(null);
      return;
    }
    setHoverMs(startMs + ratio * rangeMs);
  };

  const handleKey = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key === 'Escape') {
      setHoverMs(null);
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = (event.key === 'ArrowLeft' ? -1 : 1) * 3 * HOUR_MS;
    setHoverMs((current) =>
      Math.min(
        endMs,
        Math.max(startMs, (current ?? Math.min(Math.max(nowMs, startMs), endMs)) + step)
      )
    );
  };

  const yTicks = [0, yMax / 2, yMax];

  return (
    <div ref={containerRef} className={styles.overviewChart}>
      <svg
        className={styles.overviewSvg}
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="img"
        aria-label={label}
        tabIndex={0}
        onPointerMove={handlePointer}
        onPointerLeave={() => setHoverMs(null)}
        onBlur={() => setHoverMs(null)}
        onKeyDown={handleKey}
        style={{ color }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity={0.32} />
            <stop offset="100%" stopColor="currentColor" stopOpacity={0.02} />
          </linearGradient>
        </defs>

        <g className={styles.overviewGrid}>
          {yTicks.map((value) => (
            <g key={value}>
              <line
                x1={MARGIN.left}
                x2={MARGIN.left + plotWidth}
                y1={scale.y(value)}
                y2={scale.y(value)}
              />
              <text x={MARGIN.left - 8} y={scale.y(value) + 4} textAnchor="end">
                {formatValue(value)}
              </text>
            </g>
          ))}
          {ticks.map((tick, index) => (
            <g key={tick}>
              <line
                x1={scale.x(tick)}
                x2={scale.x(tick)}
                y1={MARGIN.top}
                y2={baseline}
                className={styles.overviewDayLine}
              />
              {index % stride === 0 && scale.x(tick) + 22 < MARGIN.left + plotWidth && (
                <text x={scale.x(tick) + 4} y={HEIGHT - 8}>
                  {`${formats.weekday.format(new Date(tick))} ${formats.dayOfMonth.format(new Date(tick))}`}
                </text>
              )}
            </g>
          ))}
        </g>

        {recorded.length > 1 && (
          <path d={areaPath(recorded, scale, baseline)} fill={`url(#${gradientId})`} />
        )}
        {projected.length > 1 && (
          <path
            d={areaPath(projected, scale, baseline)}
            fill={`url(#${gradientId})`}
            opacity={0.45}
          />
        )}

        {accountLines.map((line) => (
          <g key={line.key} className={styles.overviewAccountLine}>
            <path d={linePath(line.recorded, scale)} />
            <path d={linePath(line.projected, scale)} strokeDasharray="4 4" />
          </g>
        ))}

        {recorded.length > 0 && (
          <path
            d={linePath(recorded, scale)}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinejoin="round"
          />
        )}
        {projected.length > 0 && (
          <path
            d={linePath(projected, scale)}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeDasharray="6 5"
            strokeLinejoin="round"
          />
        )}

        {annotations.map((item) => (
          <text
            key={item.key}
            x={item.x}
            y={Math.max(MARGIN.top - 4, item.y)}
            textAnchor="middle"
            className={styles.overviewAnnotation}
          >
            {item.text}
          </text>
        ))}

        {nowVisible && (
          <g className={styles.overviewNow}>
            <line x1={scale.x(nowMs)} x2={scale.x(nowMs)} y1={MARGIN.top - 8} y2={baseline} />
            <text x={scale.x(nowMs)} y={MARGIN.top - 14} textAnchor="middle">
              {t('quota_pool.overview_now')}
            </text>
            {!isDrain && (
              <circle
                cx={scale.x(nowMs)}
                cy={scale.y(model.remaining)}
                r={3.5}
                fill="currentColor"
              />
            )}
          </g>
        )}

        {emptyVisible && emptyMs !== null && (
          <g className={styles.overviewEmpty}>
            <circle cx={scale.x(emptyMs)} cy={baseline} r={5} style={{ stroke: color }} />
            <text
              x={scale.x(emptyMs)}
              y={baseline - 12}
              textAnchor={scale.x(emptyMs) > MARGIN.left + plotWidth - 80 ? 'end' : 'middle'}
            >
              {t('quota_pool.overview_empty_marker', {
                time: formats.time.format(new Date(emptyMs)),
              })}
            </text>
          </g>
        )}

        {hover && (
          <g className={styles.overviewHover} pointerEvents="none">
            <line x1={hover.x} x2={hover.x} y1={MARGIN.top} y2={baseline} />
            <circle cx={hover.x} cy={hover.y} r={4} fill="currentColor" />
          </g>
        )}
      </svg>
      {hover && (
        <div
          className={styles.overviewTooltip}
          role="status"
          style={{
            left: hover.x,
            transform: hover.x > width / 2 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
          }}
        >
          {hover.text}
        </div>
      )}
    </div>
  );
}
