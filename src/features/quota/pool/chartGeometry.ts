/**
 * Chart helpers for the overview: range clipping, SVG paths, ticks and label placement.
 * Pure; the component only maps the results to SVG elements.
 */

import { DAY_MS } from '@/utils/time/durations';

export interface XYPoint {
  tMs: number;
  value: number | null;
}

/** Linear value of a series at `tMs`; uses the last point at a vertical step. */
export function interpolateAt(points: readonly XYPoint[], tMs: number): number | null {
  let before: XYPoint | null = null;
  for (const point of points) {
    if (point.value === null) continue;
    if (point.tMs <= tMs) {
      before = point;
      continue;
    }
    if (!before) return null;
    const span = point.tMs - before.tMs;
    const ratio = span > 0 ? (tMs - before.tMs) / span : 1;
    return (before.value as number) + ((point.value as number) - (before.value as number)) * ratio;
  }
  return before ? before.value : null;
}

/** Points inside [startMs, endMs], with interpolated end points where the series crosses. */
export function clipSeries<T extends XYPoint>(
  points: readonly T[],
  startMs: number,
  endMs: number
): XYPoint[] {
  const inside: XYPoint[] = points
    .filter((point) => point.tMs >= startMs && point.tMs <= endMs)
    .map((point) => ({ tMs: point.tMs, value: point.value }));
  if (points.length === 0) return inside;
  const first = points[0].tMs;
  const last = points[points.length - 1].tMs;
  if (first < startMs && last > startMs && (inside.length === 0 || inside[0].tMs > startMs)) {
    inside.unshift({ tMs: startMs, value: interpolateAt(points, startMs) });
  }
  if (
    last > endMs &&
    first < endMs &&
    (inside.length === 0 || inside[inside.length - 1].tMs < endMs)
  ) {
    inside.push({ tMs: endMs, value: interpolateAt(points, endMs) });
  }
  return inside;
}

export interface Scale {
  x: (tMs: number) => number;
  y: (value: number) => number;
}

const round = (value: number) => Math.round(value * 10) / 10;

/** Polyline path; null values break the line. */
export function linePath(points: readonly XYPoint[], scale: Scale): string {
  let path = '';
  let open = false;
  for (const point of points) {
    if (point.value === null) {
      open = false;
      continue;
    }
    path += `${open ? 'L' : 'M'}${round(scale.x(point.tMs))} ${round(scale.y(point.value))}`;
    open = true;
  }
  return path;
}

/** Closed area under a contiguous series down to `baseline`. */
export function areaPath(points: readonly XYPoint[], scale: Scale, baseline: number): string {
  const known = points.filter((point) => point.value !== null);
  if (known.length < 2) return '';
  const line = linePath(known, scale);
  const lastX = round(scale.x(known[known.length - 1].tMs));
  const firstX = round(scale.x(known[0].tMs));
  return `${line}L${lastX} ${round(baseline)}L${firstX} ${round(baseline)}Z`;
}

/** Local midnights strictly inside (startMs, endMs). */
export function dayTicks(startMs: number, endMs: number): number[] {
  const ticks: number[] = [];
  const cursor = new Date(startMs);
  cursor.setHours(0, 0, 0, 0);
  while (cursor.getTime() <= startMs) cursor.setDate(cursor.getDate() + 1);
  while (cursor.getTime() < endMs && ticks.length <= 62) {
    ticks.push(cursor.getTime());
    cursor.setDate(cursor.getDate() + 1);
  }
  return ticks;
}

/** Smallest of 1, 2, 2.5, 5 × 10^n that is >= value. */
export function niceCeil(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * power >= value - 1e-9) return step * power;
  }
  return 10 * power;
}

/** Drop labels that would overlap an already placed one (greedy, left to right). */
export function placeLabels<T extends { x: number; y: number }>(
  labels: readonly T[],
  minDx = 38,
  minDy = 14
): T[] {
  const placed: T[] = [];
  for (const label of [...labels].sort((left, right) => left.x - right.x)) {
    const clash = placed.some(
      (other) => Math.abs(other.x - label.x) < minDx && Math.abs(other.y - label.y) < minDy
    );
    if (!clash) placed.push(label);
  }
  return placed;
}

/** Every n-th tick label so labels stay at least `minPx` apart. */
export function tickStride(plotWidth: number, rangeMs: number, minPx = 46): number {
  const pxPerDay = (plotWidth * DAY_MS) / Math.max(1, rangeMs);
  return Math.max(1, Math.ceil(minPx / Math.max(1, pxPerDay)));
}
