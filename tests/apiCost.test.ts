import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { apiClient } from '@/services/api/client';
import { apiCostApi, normalizeApiCostReport } from '@/services/api/apiCost';
import type { ApiCostAccount, ApiCostBucket, ApiCostReport } from '@/types/apiCost';
import {
  OTHER_SERIES,
  addLocalDays,
  buildDailyCost,
  bucketsSince,
  costAxis,
  formatUsd,
  formatUsdTick,
  localDayStart,
  sumSince,
  totalTokens,
  totalsByAccount,
  totalsByModel,
  unpricedModels,
  windowStartMs,
  windowSummaries,
} from '@/features/apiCost/aggregate';
import { ApiCostOverview } from '@/features/apiCost/components/ApiCostOverview';

// Local wall-clock instants so day grouping is deterministic in any timezone.
const local = (day: number, hour = 0) => new Date(2026, 10, day, hour, 0, 0, 0).getTime();
const NOW = local(16, 12);

const bucket = (overrides: Partial<ApiCostBucket> & { hourMs: number }): ApiCostBucket => ({
  model: 'claude-opus-5-5',
  provider: 'claude',
  authId: 'claude-a.json',
  requests: 1,
  unpricedRequests: 0,
  inputTokens: 10,
  cacheReadTokens: 100,
  cacheWriteTokens: 20,
  outputTokens: 5,
  costUsd: 1,
  ...overrides,
});

const PAYLOAD = {
  generated_at: '2026-11-16T12:00:00Z',
  since: '2026-10-17T12:00:00Z',
  retention_days: 90,
  pricing: {
    source: 'remote',
    url: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
    loaded_at: '2026-11-16T08:00:00Z',
    models: 5994,
    last_error: '',
  },
  buckets: [
    {
      hour: '2026-11-16T10:00:00Z',
      model: 'claude-opus-5-5',
      provider: 'Claude',
      auth_id: 'claude-a.json',
      requests: 42,
      unpriced_requests: 0,
      input_tokens: 12000,
      cache_read_tokens: 3400000,
      cache_write_tokens: 150000,
      output_tokens: 80000,
      cost_usd: 4.71,
    },
    { hour: '2026-11-16T09:00:00Z', model: 'gpt-6', requests: '3', cost_usd: 0.2 },
    { hour: '0001-01-01T00:00:00Z', model: 'broken', requests: 1 },
    { model: 'no-hour', requests: 1 },
    'nope',
  ],
  accounts: [
    {
      id: 'claude-a.json',
      name: 'claude-a.json',
      email: 'a@example.com',
      provider: 'claude',
      disabled: false,
    },
    { name: 'missing-id' },
  ],
  unpriced_models: [
    { model: 'some-new-model', requests: 3 },
    { model: 'another-model', requests: 9 },
    { requests: 1 },
  ],
};

describe('api cost normalization', () => {
  test('normalizes the documented payload', () => {
    const report = normalizeApiCostReport(PAYLOAD);
    expect(report.generatedAtMs).toBe(Date.parse('2026-11-16T12:00:00Z'));
    expect(report.sinceMs).toBe(Date.parse('2026-10-17T12:00:00Z'));
    expect(report.retentionDays).toBe(90);
    expect(report.pricing).toEqual({
      source: 'remote',
      url: PAYLOAD.pricing.url,
      loadedAtMs: Date.parse('2026-11-16T08:00:00Z'),
      models: 5994,
      lastError: '',
    });
    expect(report.buckets).toHaveLength(2);
    expect(report.buckets[0]).toEqual({
      hourMs: Date.parse('2026-11-16T10:00:00Z'),
      model: 'claude-opus-5-5',
      provider: 'claude',
      authId: 'claude-a.json',
      requests: 42,
      unpricedRequests: 0,
      inputTokens: 12000,
      cacheReadTokens: 3400000,
      cacheWriteTokens: 150000,
      outputTokens: 80000,
      costUsd: 4.71,
    });
    // Optional fields default to empty / zero.
    expect(report.buckets[1]).toMatchObject({
      model: 'gpt-6',
      provider: '',
      authId: '',
      requests: 3,
      unpricedRequests: 0,
      inputTokens: 0,
    });
    expect(report.accounts).toEqual([
      {
        id: 'claude-a.json',
        name: 'claude-a.json',
        email: 'a@example.com',
        provider: 'claude',
        disabled: false,
      },
    ]);
    expect(report.unpricedModels).toEqual([
      { model: 'another-model', requests: 9 },
      { model: 'some-new-model', requests: 3 },
    ]);
  });

  test('tolerates empty, null and malformed payloads', () => {
    expect(normalizeApiCostReport(null)).toEqual({
      generatedAtMs: null,
      sinceMs: null,
      retentionDays: null,
      pricing: { source: '', url: '', loadedAtMs: null, models: 0, lastError: '' },
      buckets: [],
      accounts: [],
      unpricedModels: [],
    });
    const report = normalizeApiCostReport({
      buckets: null,
      retention_days: -1,
      pricing: { source: 'Embedded', loaded_at: '0001-01-01T00:00:00Z', last_error: ' boom ' },
    });
    expect(report.buckets).toEqual([]);
    expect(report.retentionDays).toBeNull();
    expect(report.pricing).toMatchObject({
      source: 'embedded',
      loadedAtMs: null,
      lastError: 'boom',
    });
  });
});

describe('api cost API', () => {
  afterEach(() => {
    (apiClient.get as unknown as { mockRestore?: () => void }).mockRestore?.();
  });

  test('omits since by default and normalizes the payload', async () => {
    const calls: unknown[][] = [];
    spyOn(apiClient, 'get').mockImplementation((async (...args: unknown[]) => {
      calls.push(args);
      return PAYLOAD;
    }) as typeof apiClient.get);
    const report = await apiCostApi.getUsageCost();
    expect(calls[0]).toEqual(['/observability/usage/cost', undefined]);
    expect(report?.buckets).toHaveLength(2);
  });

  test('passes since as RFC3339 and resolves null on 404', async () => {
    const calls: unknown[][] = [];
    spyOn(apiClient, 'get').mockImplementation((async (...args: unknown[]) => {
      calls.push(args);
      throw Object.assign(new Error('not found'), { status: 404 });
    }) as typeof apiClient.get);
    const since = Date.parse('2026-08-18T00:00:00Z');
    expect(await apiCostApi.getUsageCost(since)).toBeNull();
    expect(calls[0]).toEqual([
      '/observability/usage/cost',
      { params: { since: '2026-08-18T00:00:00.000Z' } },
    ]);
  });

  test('rethrows other failures', async () => {
    spyOn(apiClient, 'get').mockImplementation((async () => {
      throw Object.assign(new Error('boom'), { status: 500 });
    }) as typeof apiClient.get);
    await expect(apiCostApi.getUsageCost()).rejects.toThrow('boom');
  });

  test('the page never reads the destructive usage queue', () => {
    [
      'src/services/api/apiCost.ts',
      'src/features/apiCost/aggregate.ts',
      'src/features/apiCost/ApiCostPage.tsx',
      'src/features/apiCost/components/ApiCostOverview.tsx',
      'src/features/apiCost/components/CostDailyChart.tsx',
      'src/features/apiCost/components/CostTables.tsx',
    ]
      .map((path) => readFileSync(path, 'utf8'))
      .forEach((source) => expect(source).not.toContain('usage/queue'));
  });
});

describe('local days and windows', () => {
  test('local day helpers step calendar days', () => {
    expect(localDayStart(NOW)).toBe(local(16));
    expect(localDayStart(local(16, 23))).toBe(local(16));
    expect(addLocalDays(NOW, -1)).toBe(local(15));
    expect(addLocalDays(local(16, 5), 3)).toBe(local(19));
    expect(windowStartMs(NOW, 1)).toBe(local(16));
    expect(windowStartMs(NOW, 7)).toBe(local(10));
    expect(windowStartMs(NOW, 30)).toBe(new Date(2026, 9, 18).getTime());
  });

  test('window sums include today and count every token bucket', () => {
    const buckets = [
      bucket({ hourMs: local(16, 1), costUsd: 2, requests: 3 }),
      bucket({ hourMs: local(15, 23), costUsd: 1.5 }),
      bucket({ hourMs: local(10, 0), costUsd: 4 }),
      bucket({ hourMs: local(9, 23), costUsd: 8 }),
      bucket({ hourMs: new Date(2026, 9, 18, 0).getTime(), costUsd: 16 }),
      bucket({ hourMs: new Date(2026, 9, 17, 23).getTime(), costUsd: 32 }),
    ];
    const summary = windowSummaries(buckets, NOW);
    expect(summary.today.costUsd).toBe(2);
    expect(summary.today.requests).toBe(3);
    expect(summary.last7.costUsd).toBe(7.5);
    expect(summary.last30.costUsd).toBe(31.5);
    expect(totalTokens(summary.today)).toBe(135);
    expect(sumSince([], NOW).costUsd).toBe(0);
    expect(bucketsSince(buckets, local(10))).toHaveLength(3);
  });
});

describe('daily cost series', () => {
  const models = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'];
  const buckets = [
    ...models.map((model, index) =>
      bucket({ hourMs: local(16, 2), model, costUsd: 10 - index, requests: 1 })
    ),
    bucket({ hourMs: local(14, 5), model: 'm1', costUsd: 5 }),
    bucket({ hourMs: local(14, 6), model: 'm8', costUsd: 0.5 }),
    // Outside the 7-day range.
    bucket({ hourMs: local(9, 5), model: 'old', costUsd: 100 }),
  ];

  test('stacks the top six models of the range and folds the rest into other', () => {
    const daily = buildDailyCost(buckets, NOW, 7);
    expect(daily.series.map((series) => series.key)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
      'm6',
      OTHER_SERIES,
    ]);
    expect(daily.series[0].costUsd).toBe(15);
    // m7 (4) + m8 (3 + 0.5)
    expect(daily.series[6].costUsd).toBe(7.5);
    expect(daily.days.map((day) => day.dayMs)).toEqual(
      [10, 11, 12, 13, 14, 15, 16].map((day) => local(day))
    );
    const today = daily.days[6];
    expect(today.values).toEqual([10, 9, 8, 7, 6, 5, 7]);
    expect(today.totals.costUsd).toBe(52);
    expect(today.totals.requests).toBe(8);
    expect(daily.days[4].values).toEqual([5, 0, 0, 0, 0, 0, 0.5]);
    expect(daily.days[0].values.every((value) => value === 0)).toBe(true);
    expect(daily.maxCostUsd).toBe(52);
  });

  test('omits the other series when nothing is folded and handles empty data', () => {
    const daily = buildDailyCost(buckets.slice(0, 2), NOW, 7, 6);
    expect(daily.series.map((series) => series.key)).toEqual(['m1', 'm2']);
    const empty = buildDailyCost([], NOW, 30);
    expect(empty.series).toEqual([]);
    expect(empty.days).toHaveLength(30);
    expect(empty.maxCostUsd).toBe(0);
  });
});

describe('per-model and per-account totals', () => {
  const accounts: ApiCostAccount[] = [
    {
      id: 'claude-a.json',
      name: 'Claude A',
      email: 'a@example.com',
      provider: 'claude',
      disabled: true,
    },
  ];
  const buckets = [
    bucket({ hourMs: local(16, 1), model: 'cheap', costUsd: 1, authId: 'claude-a.json' }),
    bucket({ hourMs: local(16, 2), model: 'pricey', costUsd: 3, authId: 'removed.json' }),
    bucket({
      hourMs: local(16, 3),
      model: 'free',
      costUsd: 0,
      requests: 4,
      unpricedRequests: 4,
      authId: '',
      provider: 'codex',
    }),
    bucket({ hourMs: local(16, 4), model: 'zero', costUsd: 0, requests: 1, authId: '' }),
  ];

  test('sorts models by cost with share of the total', () => {
    const rows = totalsByModel(buckets);
    expect(rows.map((row) => row.model)).toEqual(['pricey', 'cheap', 'free', 'zero']);
    expect(rows[0].share).toBe(0.75);
    expect(rows[2].totals.unpricedRequests).toBe(4);
    expect(rows[2].share).toBe(0);
    expect(totalsByModel([bucket({ hourMs: NOW, costUsd: 0 })])[0].share).toBe(0);
  });

  test('lists unpriced models of the rows only', () => {
    const rows = totalsByModel([
      ...buckets,
      bucket({ hourMs: local(16, 5), model: 'new', costUsd: 0, requests: 9, unpricedRequests: 9 }),
    ]);
    expect(unpricedModels(rows)).toEqual([
      { model: 'new', requests: 9 },
      { model: 'free', requests: 4 },
    ]);
    expect(unpricedModels(totalsByModel(buckets.slice(0, 2)))).toEqual([]);
  });

  test('labels known, removed and unattributed credentials', () => {
    const rows = totalsByAccount(buckets, accounts);
    expect(rows.map((row) => row.id)).toEqual(['removed.json', 'claude-a.json', '']);
    expect(rows[0]).toMatchObject({ name: 'removed.json', known: false, email: '' });
    expect(rows[1]).toMatchObject({
      name: 'Claude A',
      email: 'a@example.com',
      known: true,
      disabled: true,
      share: 0.25,
    });
    expect(rows[2]).toMatchObject({ name: '', known: false, provider: 'codex' });
    expect(rows[2].totals.requests).toBe(5);
  });
});

describe('formatting', () => {
  test('formats USD amounts', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(-1)).toBe('$0.00');
    expect(formatUsd(Number.NaN)).toBe('$0.00');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(0.01)).toBe('$0.01');
    expect(formatUsd(4.71)).toBe('$4.71');
    expect(formatUsd(1234.567)).toBe('$1,234.57');
  });

  test('formats axis ticks compactly', () => {
    expect(formatUsdTick(0)).toBe('$0');
    expect(formatUsdTick(0.25)).toBe('$0.25');
    expect(formatUsdTick(2.5)).toBe('$2.5');
    expect(formatUsdTick(40)).toBe('$40');
    expect(formatUsdTick(1250)).toBe('$1.3K');
    expect(formatUsdTick(250000)).toBe('$250K');
  });

  test('picks a tight cost axis with at most three intervals', () => {
    expect(costAxis(560)).toEqual({ max: 600, ticks: [0, 200, 400, 600] });
    expect(costAxis(100)).toEqual({ max: 100, ticks: [0, 50, 100] });
    expect(costAxis(4.71)).toEqual({ max: 6, ticks: [0, 2, 4, 6] });
    expect(costAxis(0)).toEqual({ max: 0.03, ticks: [0, 0.01, 0.02, 0.03] });
    expect(costAxis(Number.NaN).max).toBe(0.03);
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

  const report: ApiCostReport = {
    generatedAtMs: NOW,
    sinceMs: NOW - 30 * 86_400_000,
    retentionDays: 90,
    pricing: {
      source: 'embedded',
      url: '',
      loadedAtMs: null,
      models: 5994,
      lastError: 'fetch failed',
    },
    buckets: [
      bucket({ hourMs: local(16, 1), costUsd: 4.71, requests: 42, authId: 'claude-a.json' }),
      bucket({ hourMs: local(12, 1), model: 'gpt-6', costUsd: 1234.5, authId: 'gone.json' }),
      bucket({
        hourMs: local(12, 2),
        model: 'some-new-model',
        costUsd: 0,
        requests: 3,
        unpricedRequests: 3,
      }),
      bucket({
        hourMs: local(2, 2),
        model: 'old-unpriced-model',
        costUsd: 0,
        requests: 5,
        unpricedRequests: 5,
      }),
    ],
    accounts: [
      {
        id: 'claude-a.json',
        name: 'claude-a.json',
        email: 'alice@example.com',
        provider: 'claude',
        disabled: false,
      },
    ],
    unpricedModels: [{ model: 'some-new-model', requests: 3 }],
  };

  const render = (rangeDays: 7 | 30 = 30) =>
    renderToStaticMarkup(
      createElement(ApiCostOverview, {
        report,
        nowMs: NOW,
        rangeDays,
        onRangeChange: () => {},
        resolvedTheme: 'light',
        initialWidth: 900,
      })
    );

  test('renders tiles, chart, tables and warnings with masked identities', () => {
    const html = render();
    expect(html).toContain('Today');
    expect(html).toContain('Last 7 days');
    expect(html).toContain('$4.71');
    expect(html).toContain('$1,239.21');
    expect(html).toContain('42 requests');
    expect(html).toContain('<svg');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('By model');
    expect(html).toContain('By credential');
    expect(html).toContain('gpt-6');
    expect(html).toContain('removed');
    expect(html).toContain('built-in snapshot');
    expect(html).toContain('fetch failed');
    expect(html).toContain('some-new-model');
    expect(html).toContain('5,994 models');
    expect(html).toContain('al•••');
    expect(html).not.toContain('alice@example.com');
    expect(html).toContain('go•••');
    expect(html).not.toContain('gone.json');
  });

  test('lists only the unpriced models of the selected range', () => {
    expect(render(30)).toContain('old-unpriced-model');
    const html = render(7);
    expect(html).toContain('some-new-model');
    expect(html).not.toContain('old-unpriced-model');
  });
});
