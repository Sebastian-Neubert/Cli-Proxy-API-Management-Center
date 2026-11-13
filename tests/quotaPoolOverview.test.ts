import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { apiClient } from '@/services/api/client';
import { normalizeQuotaHistory, quotaPoolApi } from '@/services/api/quotaPool';
import type { AuthFileItem } from '@/types/authFile';
import type { QuotaHistory } from '@/types/quotaPool';
import { buildPoolAccounts } from '@/features/quota/pool/logic';
import {
  accountSamples,
  buildOverviewAccounts,
  buildOverviewModel,
  overviewRange,
} from '@/features/quota/pool/overview';
import {
  accountBurnRate,
  accountStateAt,
  buildDrainSeries,
  buildRecordedSeries,
  durationParts,
  formatBurnRate,
  formatPoolPercent,
  formatRestored,
  gridInstants,
  poolBurnRate,
  simulateProjection,
  valueAt,
  weeklySampleFromWindows,
  type AccountState,
  type OverviewAccount,
  type WeeklySample,
} from '@/features/quota/pool/projection';
import { clipSeries, niceCeil, placeLabels } from '@/features/quota/pool/chartGeometry';
import { formatDuration, maskIdentity } from '@/features/quota/pool/overviewFormat';
import { PoolOverview } from '@/features/quota/pool/components/PoolOverview';

const H = 3_600_000;
const M = 60_000;
const NOW = Date.parse('2026-11-13T12:00:00Z');
const WEEK_MIN = 10080;

const sample = (
  tMs: number,
  remaining: number,
  resetAtMs: number | null = null,
  windowMinutes: number | null = WEEK_MIN
): WeeklySample => ({ tMs, remaining, resetAtMs, windowMinutes });

const account = (key: string, samples: WeeklySample[]): OverviewAccount => ({
  key,
  name: `${key}.json`,
  email: `${key}@example.com`,
  samples,
});

const state = (
  remaining: number,
  resetAtMs: number | null,
  windowMinutes: number | null = WEEK_MIN
): AccountState => ({ remaining, resetAtMs, windowMinutes, unknown: false });

const HISTORY_PAYLOAD = {
  generated_at: '2026-11-13T12:00:00Z',
  retention_hours: 672,
  providers: [
    {
      provider: 'Claude',
      accounts: [
        {
          id: 'claude-a.json',
          auth_index: 'idx-a',
          name: 'claude-a.json',
          email: 'a@example.com',
          disabled: false,
          points: [
            {
              t: '2026-11-13T11:00:00Z',
              windows: [
                { name: '5h', window_minutes: 300, used_percent: 12 },
                {
                  name: '7d',
                  window_minutes: 10080,
                  used_percent: 41,
                  reset_at: '2026-11-17T09:00:00Z',
                },
              ],
            },
            { t: '2026-11-13T10:00:00Z', windows: [{ name: '7d', window_minutes: 10080 }] },
            { windows: [] },
            { t: 'not a time', windows: [] },
          ],
        },
        { email: 'nobody@example.com' },
        { id: 'claude-b.json' },
      ],
    },
    { accounts: [] },
  ],
};

describe('quota history normalization', () => {
  test('normalizes providers, accounts and points; drops unusable entries', () => {
    const history = normalizeQuotaHistory(HISTORY_PAYLOAD);
    expect(history.generatedAtMs).toBe(NOW);
    expect(history.retentionHours).toBe(672);
    expect(history.providers).toHaveLength(1);
    const claude = history.providers[0];
    expect(claude.provider).toBe('claude');
    expect(claude.accounts.map((item) => item.id)).toEqual(['claude-a.json', 'claude-b.json']);
    const a = claude.accounts[0];
    expect(a.authIndex).toBe('idx-a');
    expect(a.points.map((point) => point.tMs)).toEqual([
      Date.parse('2026-11-13T10:00:00Z'),
      Date.parse('2026-11-13T11:00:00Z'),
    ]);
    expect(a.points[0].windows[0].usedPercent).toBeNull();
    expect(a.points[0].windows[0].resetAtMs).toBeNull();
    expect(a.points[1].windows[1]).toEqual({
      name: '7d',
      windowMinutes: 10080,
      resetAtMs: Date.parse('2026-11-17T09:00:00Z'),
      status: '',
      usedPercent: 41,
    });
    const b = claude.accounts[1];
    expect(b).toEqual({
      id: 'claude-b.json',
      authIndex: '',
      name: '',
      email: '',
      disabled: false,
      points: [],
    });
  });

  test('garbage payloads normalize to an empty history', () => {
    expect(normalizeQuotaHistory(null)).toEqual({
      generatedAtMs: null,
      retentionHours: null,
      providers: [],
    });
    expect(normalizeQuotaHistory({ providers: 'x', retention_hours: -1 }).retentionHours).toBe(
      null
    );
  });
});

describe('quota history API', () => {
  afterEach(() => {
    (apiClient.get as unknown as { mockRestore?: () => void }).mockRestore?.();
  });

  test('passes since as RFC3339 and resolves null on 404', async () => {
    const calls: unknown[][] = [];
    spyOn(apiClient, 'get').mockImplementation((async (...args: unknown[]) => {
      calls.push(args);
      throw Object.assign(new Error('not found'), { status: 404 });
    }) as typeof apiClient.get);
    expect(await quotaPoolApi.getQuotaHistory(NOW)).toBeNull();
    expect(calls[0][0]).toBe('/quota/history');
    expect(calls[0][1]).toEqual({ params: { since: '2026-11-13T12:00:00.000Z' } });
  });

  test('omits since by default and normalizes the payload', async () => {
    const calls: unknown[][] = [];
    spyOn(apiClient, 'get').mockImplementation((async (...args: unknown[]) => {
      calls.push(args);
      return HISTORY_PAYLOAD;
    }) as typeof apiClient.get);
    const history = await quotaPoolApi.getQuotaHistory();
    expect(calls[0]).toEqual(['/quota/history', undefined]);
    expect(history?.providers[0].accounts).toHaveLength(2);
  });

  test('rethrows other failures', async () => {
    spyOn(apiClient, 'get').mockImplementation((async () => {
      throw Object.assign(new Error('boom'), { status: 500 });
    }) as typeof apiClient.get);
    await expect(quotaPoolApi.getQuotaHistory()).rejects.toThrow('boom');
  });

  test('the overview never reads the destructive usage queue', () => {
    [
      'src/features/quota/pool/projection.ts',
      'src/features/quota/pool/overview.ts',
      'src/features/quota/pool/components/PoolOverview.tsx',
      'src/features/quota/pool/components/PoolOverviewCard.tsx',
      'src/features/quota/pool/components/PoolOverviewChart.tsx',
    ]
      .map((path) => readFileSync(path, 'utf8'))
      .forEach((source) => expect(source).not.toContain('usage/queue'));
  });
});

describe('weekly samples and recorded series', () => {
  test('picks the longest >= 24h window and converts used to remaining', () => {
    expect(
      weeklySampleFromWindows(NOW, [
        { name: 'primary', windowMinutes: 300, resetAtMs: null, status: '', usedPercent: 90 },
        {
          name: 'secondary',
          windowMinutes: WEEK_MIN,
          resetAtMs: NOW + H,
          status: '',
          usedPercent: 30,
        },
      ])
    ).toEqual(sample(NOW, 70, NOW + H));
    expect(
      weeklySampleFromWindows(NOW, [
        { name: '7d', windowMinutes: WEEK_MIN, resetAtMs: null, status: '', usedPercent: null },
      ])
    ).toBeNull();
  });

  test('carries the last value forward and refills after a recorded reset', () => {
    const samples = [sample(NOW - 4 * H, 60, NOW - 2 * H), sample(NOW - H, 90, NOW + 100 * H)];
    expect(valueAt(samples, NOW - 5 * H)).toBeNull();
    expect(valueAt(samples, NOW - 3 * H)).toBe(60);
    expect(valueAt(samples, NOW - 2 * H)).toBe(100);
    expect(valueAt(samples, NOW)).toBe(90);
  });

  test('grid keeps both ends and aligns inner points to the step', () => {
    const start = NOW - 20 * M;
    expect(gridInstants(start, NOW, 15 * M)).toEqual([start, NOW - 15 * M, NOW]);
  });

  test('pool sums accounts, counts accounts without data as 100% and annotates resets', () => {
    const a = account('a', [sample(NOW - 3 * H, 40, NOW - H), sample(NOW - 30 * M, 95)]);
    const b = account('b', [sample(NOW - H, 50)]);
    const series = buildRecordedSeries([a, b], NOW - 4 * H, NOW, H);
    expect(series.points.map((point) => [point.tMs, point.value])).toEqual([
      [NOW - 3 * H, 140],
      [NOW - 2 * H, 140],
      [NOW - H, 150],
      [NOW, 145],
    ]);
    expect(series.points[0].perAccount).toEqual([40, null]);
    expect(series.resets).toEqual([{ tMs: NOW - H, amount: 60 }]);
  });
});

describe('burn rate', () => {
  test('sums decreases and ignores reset jumps', () => {
    const samples = [
      sample(NOW - 4 * H, 50, NOW - 2 * H),
      sample(NOW - 3 * H, 45, NOW - 2 * H),
      // reset at NOW-2h refills to 100, then consumption resumes
      sample(NOW - H, 97, NOW + 100 * H),
      sample(NOW - 30 * M, 94, NOW + 100 * H),
    ];
    // window [NOW-3h, NOW]: baseline 45 -> (reset) 100 -> 97 -> 94 = 6 over 3h
    expect(accountBurnRate(samples, NOW - 3 * H, NOW)).toBeCloseTo(2, 9);
    // a raw increase without a recorded reset is not consumption either
    const noReset = [sample(NOW - 2 * H, 30), sample(NOW - H, 80), sample(NOW, 77)];
    expect(accountBurnRate(noReset, NOW - 3 * H, NOW)).toBeCloseTo(1, 9);
  });

  test('pool burn sums accounts; the drain series starts at the first sample', () => {
    const a = account('a', [sample(NOW - 2 * H, 80), sample(NOW, 74)]);
    const b = account('b', [sample(NOW - 2 * H, 50), sample(NOW - H, 47)]);
    expect(poolBurnRate([a, b], NOW, 3 * H)).toBeCloseTo(3, 9);
    const drain = buildDrainSeries([a, b], NOW - 4 * H, NOW, 3 * H, H);
    expect(drain[0].tMs).toBe(NOW - 2 * H);
    expect(drain.at(-1)?.value).toBeCloseTo(3, 9);
  });
});

describe('projection', () => {
  test('current state rolls a passed reset forward by the window', () => {
    const passed = accountStateAt([sample(NOW - 10 * H, 20, NOW - H)], NOW);
    expect(passed).toEqual(state(100, NOW - H + WEEK_MIN * M));
    expect(accountStateAt([], NOW)).toEqual({
      remaining: 100,
      resetAtMs: null,
      windowMinutes: null,
      unknown: true,
    });
    expect(accountStateAt([sample(NOW - H, 20, NOW - 1, null)], NOW).resetAtMs).toBeNull();
  });

  test('drains in soonest-reset order and spills into the next account', () => {
    const projection = simulateProjection({
      // index 0 resets later than index 1, so index 1 is drained first
      states: [state(50, NOW + 100 * H), state(10, NOW + 50 * H), state(100, null)],
      nowMs: NOW,
      endMs: NOW + 4 * H,
      burnPerHour: 5,
      futureUsage: 'same',
      stepMs: H,
    });
    const last = projection.points.at(-1);
    // 20% demand: 10 from index 1, 10 spilled into index 0; the unknown-reset account last
    expect(last?.perAccount).toEqual([40, 0, 100]);
    expect(projection.firstEmpty).toEqual({ tMs: NOW + 2 * H, index: 1 });
    expect(projection.poolEmptyMs).toBeNull();
  });

  test('a reset refills the account and schedules the next cycle', () => {
    const projection = simulateProjection({
      states: [state(30, NOW + 90 * M, 120)],
      nowMs: NOW,
      endMs: NOW + 4 * H,
      burnPerHour: 0,
      futureUsage: 'same',
      stepMs: H,
    });
    expect(projection.resets).toEqual([{ tMs: NOW + 90 * M, amount: 70 }]);
    const atReset = projection.points.filter((point) => point.tMs === NOW + 90 * M);
    expect(atReset.map((point) => point.value)).toEqual([30, 100]);
    expect(projection.points.at(-1)?.value).toBe(100);
  });

  test('pool empty and first empty are exact; the pool stays empty until a reset', () => {
    const projection = simulateProjection({
      states: [state(10, NOW + 10 * H), state(20, null)],
      nowMs: NOW,
      endMs: NOW + 12 * H,
      burnPerHour: 10,
      futureUsage: 'same',
      stepMs: H,
    });
    expect(projection.firstEmpty).toEqual({ tMs: NOW + H, index: 0 });
    expect(projection.poolEmptyMs).toBe(NOW + 3 * H);
    expect(projection.points.find((point) => point.tMs === NOW + 3 * H)?.value).toBe(0);
    expect(projection.resets).toEqual([{ tMs: NOW + 10 * H, amount: 100 }]);
    // after the reset, demand drains the refilled account again: 2h × 10%/h
    expect(projection.points.at(-1)?.perAccount).toEqual([80, 0]);
  });

  test('"None" means no consumption, only resets', () => {
    const projection = simulateProjection({
      states: [state(40, NOW + 2 * H)],
      nowMs: NOW,
      endMs: NOW + 4 * H,
      burnPerHour: 25,
      futureUsage: 'none',
      stepMs: H,
    });
    expect(
      projection.points.filter((point) => point.tMs < NOW + 2 * H).every((p) => p.value === 40)
    ).toBe(true);
    expect(projection.poolEmptyMs).toBeNull();
    expect(projection.firstEmpty).toBeNull();
    expect(projection.resets).toEqual([{ tMs: NOW + 2 * H, amount: 60 }]);
  });

  test('an exhausted pool is empty now even without burn', () => {
    const projection = simulateProjection({
      states: [state(0, NOW + 2 * H), state(0, null)],
      nowMs: NOW,
      endMs: NOW + 4 * H,
      burnPerHour: 0,
      futureUsage: 'same',
      stepMs: H,
    });
    expect(projection.poolEmptyMs).toBe(NOW);
  });
});

describe('overview model', () => {
  const file = (overrides: Partial<AuthFileItem>): AuthFileItem =>
    ({
      name: 'claude-a.json',
      type: 'claude',
      provider: 'claude',
      authIndex: 'idx-a',
      ...overrides,
    }) as AuthFileItem;

  test('the credential snapshot is used only when fresher than recorded history', () => {
    const history = normalizeQuotaHistory(HISTORY_PAYLOAD).providers[0].accounts[0];
    const windows = [
      {
        name: '7d',
        windowMinutes: WEEK_MIN,
        resetAtMs: Date.parse('2026-11-17T09:00:00Z'),
        status: 'allowed',
        usedPercent: 45,
      },
    ];
    const stale = buildPoolAccounts(
      [
        file({
          quotaWindows: windows,
          quotaReset: {
            resetAtMs: windows[0].resetAtMs,
            window: '7d',
            windowMinutes: WEEK_MIN,
            observedAtMs: NOW - 2 * H,
          },
        }),
      ],
      null
    ).claude[0];
    expect(accountSamples(stale, history, NOW).map((item) => item.remaining)).toEqual([59]);

    const freshReset = {
      resetAtMs: windows[0].resetAtMs,
      window: '7d',
      windowMinutes: WEEK_MIN,
      observedAtMs: NOW - M,
    };
    const fresh = { ...stale, file: { ...stale.file, quotaReset: freshReset } };
    expect(accountSamples(fresh, history, NOW).map((item) => item.remaining)).toEqual([59, 55]);

    // no history and no observation time: the snapshot counts as observed now
    const bare = { ...stale, file: { ...stale.file, quotaReset: undefined } };
    expect(accountSamples(bare, null, NOW)).toEqual([sample(NOW, 55, windows[0].resetAtMs)]);
  });

  test('disabled accounts are excluded from the pool; unknown ones count as 100%', () => {
    const accounts = buildPoolAccounts(
      [
        file({ name: 'a.json', authIndex: 'a' }),
        file({ name: 'b.json', authIndex: 'b', disabled: true }),
      ],
      null
    ).claude;
    const overview = buildOverviewAccounts(accounts, null, NOW);
    expect(overview.map((item) => item.name)).toEqual(['a.json']);
    const range = overviewRange(NOW, 0);
    expect(range).toEqual({ startMs: NOW - 7 * 24 * H, endMs: NOW + 7 * 24 * H });
    const model = buildOverviewModel(overview, {
      nowMs: NOW,
      ...range,
      burnWindowHours: 3,
      futureUsage: 'same',
      hasHistory: false,
    });
    expect(model.capacity).toBe(100);
    expect(model.remaining).toBe(100);
    expect(model.unknownCount).toBe(1);
    expect(model.burnPerHour).toBeNull();
    expect(model.recorded.points).toEqual([]);
    expect(model.projectedBurnPerHour).toBeNull();
    const none = buildOverviewModel(overview, {
      nowMs: NOW,
      ...range,
      burnWindowHours: 3,
      futureUsage: 'none',
      hasHistory: false,
    });
    expect(none.projectedBurnPerHour).toBe(0);
  });
});

describe('formatting and geometry', () => {
  test('stats formatting', () => {
    expect(formatPoolPercent(555.4)).toBe('555%');
    expect(formatBurnRate(3.66)).toBe('3.7%/h');
    expect(formatBurnRate(0)).toBe('0.0%/h');
    expect(formatRestored(100)).toBe('+100%');
    expect(durationParts(15 * H + 49 * M + 30_000)).toEqual([
      { value: 15, unit: 'hour' },
      { value: 49, unit: 'minute' },
    ]);
    expect(durationParts(2 * 24 * H + 18 * H + 5 * M)).toEqual([
      { value: 2, unit: 'day' },
      { value: 18, unit: 'hour' },
    ]);
    expect(durationParts(3 * 24 * H)).toEqual([{ value: 3, unit: 'day' }]);
    expect(durationParts(-5)).toEqual([{ value: 0, unit: 'minute' }]);
    expect(maskIdentity('alice@example.com')).toBe('al•••');
    expect(maskIdentity('  ')).toBe('');
  });

  test('clipping interpolates the range edges; labels do not overlap', () => {
    const clipped = clipSeries(
      [
        { tMs: 0, value: 0 },
        { tMs: 10, value: 100 },
      ],
      5,
      8
    );
    expect(clipped).toEqual([
      { tMs: 5, value: 50 },
      { tMs: 8, value: 80 },
    ]);
    expect(niceCeil(3.2)).toBe(5);
    expect(niceCeil(0)).toBe(1);
    expect(
      placeLabels([
        { x: 10, y: 10 },
        { x: 20, y: 12 },
        { x: 20, y: 60 },
      ])
    ).toEqual([
      { x: 10, y: 10 },
      { x: 20, y: 60 },
    ]);
  });
});

describe('overview rendering', () => {
  const initialLanguage = i18n.language;
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });
  afterAll(async () => {
    await i18n.changeLanguage(initialLanguage);
  });

  const files: AuthFileItem[] = [
    {
      name: 'claude-a.json',
      type: 'claude',
      provider: 'claude',
      authIndex: 'idx-a',
      email: 'alice@example.com',
      quotaWindows: [
        {
          name: '7d',
          windowMinutes: WEEK_MIN,
          resetAtMs: NOW + 30 * H,
          status: 'allowed',
          usedPercent: 40,
        },
      ],
    } as AuthFileItem,
    {
      name: 'claude-b.json',
      type: 'claude',
      provider: 'claude',
      authIndex: 'idx-b',
      quotaWindows: [
        {
          name: '7d',
          windowMinutes: WEEK_MIN,
          resetAtMs: NOW + 50 * H,
          status: 'allowed',
          usedPercent: 5,
        },
      ],
    } as AuthFileItem,
  ];

  const history: QuotaHistory = normalizeQuotaHistory({
    providers: [
      {
        provider: 'claude',
        accounts: [
          {
            id: 'claude-a.json',
            auth_index: 'idx-a',
            points: [
              {
                t: new Date(NOW - 3 * H).toISOString(),
                windows: [
                  {
                    name: '7d',
                    window_minutes: WEEK_MIN,
                    used_percent: 31,
                    reset_at: new Date(NOW + 30 * H).toISOString(),
                  },
                ],
              },
              {
                t: new Date(NOW - 10 * M).toISOString(),
                windows: [
                  {
                    name: '7d',
                    window_minutes: WEEK_MIN,
                    used_percent: 40,
                    reset_at: new Date(NOW + 30 * H).toISOString(),
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

  const render = (overrides: Partial<Parameters<typeof PoolOverview>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(PoolOverview, {
        providers: ['claude'],
        accountsByProvider: buildPoolAccounts(files, null),
        history,
        historyStatus: 'ok',
        nowMs: NOW,
        resolvedTheme: 'dark',
        labelFor: () => 'Claude',
        iconFor: () => null,
        ...overrides,
      })
    );

  test('renders the headline, stats, chart and legend with masked emails', () => {
    const html = render();
    expect(html).toContain('155%');
    expect(html).toContain('of 200%');
    expect(html).toContain('2 accounts');
    expect(html).toContain('Pool empty');
    expect(html).toContain('First empty');
    expect(html).toContain('Burn, last 3h');
    expect(html).toContain('3.0%/h');
    expect(html).toContain('+100%');
    expect(html).toContain('Recorded');
    expect(html).toContain('Projected');
    expect(html).toContain('Now');
    expect(html).toContain('<svg');
    expect(html).toContain('al•••');
    expect(html).not.toContain('alice@example.com');
    expect(html).toContain('in 20h');
  });

  test('a missing history route keeps the projection and shows a hint', () => {
    const html = render({ history: null, historyStatus: 'missing' });
    expect(html).toContain('does not record quota history');
    expect(html).toContain('155%');
    expect(html).toContain('Not by');
  });

  test('duration labels come from the locale', () => {
    expect(formatDuration(i18n.t.bind(i18n), 15 * H + 49 * M)).toBe('15h 49m');
  });
});
