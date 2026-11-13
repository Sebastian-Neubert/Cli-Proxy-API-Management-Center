import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { normalizeAuthFilesResponse } from '@/services/api/authFiles';
import { apiClient } from '@/services/api/client';
import {
  normalizeQuotaReset,
  normalizeQuotaWindows,
  normalizeRoutingPreference,
  normalizeTokenUsage,
  quotaPoolApi,
} from '@/services/api/quotaPool';
import {
  buildPoolAccounts,
  cacheReadShare,
  longWindowOf,
  summarizePool,
  windowLengthParts,
  windowTone,
} from '@/features/quota/pool/logic';
import { PoolAccountCard } from '@/features/quota/pool/components/PoolAccountCard';
import { PoolRoutingPanel } from '@/features/quota/pool/components/PoolRoutingPanel';
import { QUOTA_CLASS_KEYS, bindQuotaClasses } from '@/features/quota/types';
import type { AuthFilesResponse } from '@/types/authFile';

const NOW = Date.parse('2026-11-13T12:00:00Z');

const CLAUDE_A = {
  id: 'claude-a.json',
  auth_index: 'idx-a',
  name: 'claude-a.json',
  type: 'claude',
  provider: 'claude',
  email: 'a@example.com',
  disabled: false,
  quota_windows: [
    {
      name: '5h',
      window_minutes: 300,
      reset_at: '2026-11-13T15:00:00Z',
      status: 'allowed',
      used_percent: 25,
    },
    {
      name: '7d',
      window_minutes: 10080,
      reset_at: '2026-11-15T09:00:00Z',
      status: 'allowed_warning',
      used_percent: 60,
    },
  ],
  quota_reset: {
    reset_at: '2026-11-15T09:00:00Z',
    window: '7d',
    window_minutes: 10080,
    observed_at: '2026-11-13T12:00:00Z',
  },
  token_usage: {
    current_hour: {
      requests: 3,
      failed: 0,
      input_tokens: 120,
      cache_read_tokens: 9000,
      cache_write_tokens: 500,
      output_tokens: 300,
    },
    last_24h: {
      requests: 40,
      failed: 1,
      input_tokens: 1500,
      cache_read_tokens: 120000,
      cache_write_tokens: 8000,
      output_tokens: 4000,
    },
  },
};

const CLAUDE_B = {
  id: 'claude-b.json',
  auth_index: 'idx-b',
  name: 'claude-b.json',
  type: 'claude',
  disabled: true,
};

const CODEX_C = {
  id: 'codex-c.json',
  auth_index: 'idx-c',
  name: 'codex-c.json',
  type: 'codex',
  // Codex reports the weekly window as `primary` here; only the length tells them apart.
  quota_windows: [
    { name: 'primary', window_minutes: 10080, used_percent: 80 },
    { name: 'secondary', window_minutes: 300, reset_at: '2026-11-13T13:00:00Z' },
  ],
};

const LEGACY = { name: 'legacy.json', type: 'claude', auth_index: 'idx-l' };

const PREFERENCE_PAYLOAD = {
  strategy: 'soonest-reset',
  strategy_active: true,
  session_affinity: true,
  session_affinity_rebind_on: 'quota',
  generated_at: '2026-11-13T12:00:00Z',
  providers: [
    {
      provider: 'claude',
      preferred_id: 'claude-a.json',
      candidates: [
        {
          rank: 2,
          id: 'claude-b.json',
          auth_index: 'idx-b',
          name: 'claude-b.json',
          available: false,
          disabled: true,
          preferred: false,
        },
        {
          rank: 1,
          id: 'claude-a.json',
          auth_index: 'idx-a',
          name: 'claude-a.json',
          available: true,
          disabled: false,
          preferred: true,
          email: 'a@example.com',
          reset_at: '2026-11-15T09:00:00Z',
          window: '7d',
        },
      ],
    },
  ],
};

const normalizedFiles = () =>
  normalizeAuthFilesResponse({
    files: [CLAUDE_A, CLAUDE_B, CODEX_C, LEGACY],
  } as unknown as AuthFilesResponse).files;

describe('credential quota fields normalization', () => {
  test('maps quota_windows, quota_reset and token_usage to camelCase fields', () => {
    const file = normalizedFiles().find((item) => item.name === 'claude-a.json');
    expect(file?.quotaWindows).toEqual([
      {
        name: '5h',
        windowMinutes: 300,
        resetAtMs: Date.parse('2026-11-13T15:00:00Z'),
        status: 'allowed',
        usedPercent: 25,
      },
      {
        name: '7d',
        windowMinutes: 10080,
        resetAtMs: Date.parse('2026-11-15T09:00:00Z'),
        status: 'allowed_warning',
        usedPercent: 60,
      },
    ]);
    expect(file?.quotaReset).toEqual({
      resetAtMs: Date.parse('2026-11-15T09:00:00Z'),
      window: '7d',
      windowMinutes: 10080,
      observedAtMs: NOW,
    });
    expect(file?.tokenUsage?.last24h).toEqual({
      requests: 40,
      failed: 1,
      inputTokens: 1500,
      cacheReadTokens: 120000,
      cacheWriteTokens: 8000,
      outputTokens: 4000,
    });
  });

  test('legacy entries without the new fields stay unchanged', () => {
    const file = normalizedFiles().find((item) => item.name === 'legacy.json');
    expect(file?.quotaWindows).toBeUndefined();
    expect(file?.quotaReset).toBeUndefined();
    expect(file?.tokenUsage).toBeUndefined();
  });

  test('missing window fields normalize to null or empty', () => {
    expect(normalizeQuotaWindows([{ name: 'secondary' }, 'junk', {}])).toEqual([
      { name: 'secondary', windowMinutes: null, resetAtMs: null, status: '', usedPercent: null },
    ]);
    expect(normalizeQuotaWindows([{ name: '5h', used_percent: 140 }])?.[0].usedPercent).toBe(100);
    expect(normalizeQuotaWindows([])).toBeUndefined();
    expect(normalizeQuotaWindows(null)).toBeUndefined();
  });

  test('quota_reset without a usable instant is unknown', () => {
    expect(normalizeQuotaReset({ window: '7d' })).toBeUndefined();
    expect(normalizeQuotaReset({ reset_at: '0001-01-01T00:00:00Z' })).toBeUndefined();
    expect(normalizeQuotaReset('2026-11-15T09:00:00Z')).toBeUndefined();
  });

  test('token_usage fills missing buckets with zero', () => {
    expect(normalizeTokenUsage({ last_24h: { requests: '5', input_tokens: -3 } })).toEqual({
      currentHour: {
        requests: 0,
        failed: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      },
      last24h: {
        requests: 5,
        failed: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      },
    });
    expect(normalizeTokenUsage({})).toBeUndefined();
  });
});

describe('routing preference normalization', () => {
  test('sorts candidates by rank and keeps preferred consistent with preferred_id', () => {
    const preference = normalizeRoutingPreference(PREFERENCE_PAYLOAD);
    expect(preference.strategy).toBe('soonest-reset');
    expect(preference.strategyActive).toBe(true);
    expect(preference.sessionAffinity).toBe(true);
    expect(preference.sessionAffinityRebindOn).toBe('quota');
    expect(preference.generatedAtMs).toBe(NOW);
    const claude = preference.providers[0];
    expect(claude.preferredId).toBe('claude-a.json');
    expect(claude.candidates.map((item) => [item.rank, item.id, item.preferred])).toEqual([
      [1, 'claude-a.json', true],
      [2, 'claude-b.json', false],
    ]);
    expect(claude.candidates[0].resetAtMs).toBe(Date.parse('2026-11-15T09:00:00Z'));
    expect(claude.candidates[1].resetAtMs).toBeNull();
    expect(claude.candidates[1].window).toBe('');
  });

  test('an empty preferred_id marks no candidate as preferred', () => {
    const preference = normalizeRoutingPreference({
      strategy: 'round-robin',
      providers: [
        {
          provider: 'codex',
          preferred_id: '',
          candidates: [{ id: 'x', preferred: true }, { id: 'y' }],
        },
        { candidates: [] },
      ],
    });
    expect(preference.strategyActive).toBe(false);
    expect(preference.providers).toHaveLength(1);
    expect(preference.providers[0].candidates.map((item) => [item.rank, item.preferred])).toEqual([
      [1, false],
      [2, false],
    ]);
  });
});

describe('routing preference API', () => {
  const restores: Array<{ mockRestore: () => void }> = [];
  afterEach(() => restores.splice(0).forEach((spy) => spy.mockRestore()));

  test('reads /routing/preference and resolves null on 404', async () => {
    const get = spyOn(apiClient, 'get').mockImplementation((async () => {
      throw Object.assign(new Error('not found'), { status: 404 });
    }) as never);
    restores.push(get);
    expect(await quotaPoolApi.getRoutingPreference()).toBeNull();
    expect(get).toHaveBeenCalledWith('/routing/preference');
  });

  test('rethrows other failures', async () => {
    const get = spyOn(apiClient, 'get').mockImplementation((async () => {
      throw Object.assign(new Error('boom'), { status: 500 });
    }) as never);
    restores.push(get);
    await expect(quotaPoolApi.getRoutingPreference()).rejects.toThrow('boom');
  });

  test('the pool view never reads the destructive usage queue', () => {
    const sources = [
      'src/services/api/quotaPool.ts',
      'src/features/quota/pool/QuotaPoolPage.tsx',
      'src/features/quota/pool/logic.ts',
    ].map((path) => readFileSync(path, 'utf8'));
    sources.forEach((source) => expect(source).not.toContain('usage/queue'));
  });
});

describe('pool logic', () => {
  test('cache read share uses input + cache read + cache write as the denominator', () => {
    const share = cacheReadShare({
      requests: 3,
      failed: 0,
      inputTokens: 120,
      cacheReadTokens: 9000,
      cacheWriteTokens: 500,
      outputTokens: 300,
    });
    expect(share).toBeCloseTo(9000 / 9620, 10);
    expect(
      cacheReadShare({
        requests: 1,
        failed: 1,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 50,
      })
    ).toBeNull();
    expect(cacheReadShare(undefined)).toBeNull();
  });

  test('long window is chosen by length, not by name', () => {
    const codex = normalizedFiles().find((item) => item.name === 'codex-c.json');
    expect(longWindowOf(codex?.quotaWindows ?? [])?.name).toBe('primary');
    expect(
      longWindowOf([
        { name: '7d', windowMinutes: null, resetAtMs: null, status: '', usedPercent: 10 },
      ])?.name
    ).toBe('7d');
    expect(
      longWindowOf([
        { name: '5h', windowMinutes: 300, resetAtMs: null, status: '', usedPercent: 10 },
      ])
    ).toBeNull();
  });

  test('accounts are grouped per provider, matched by auth index and ordered by rank', () => {
    const preference = normalizeRoutingPreference(PREFERENCE_PAYLOAD);
    const pool = buildPoolAccounts(normalizedFiles(), preference);
    expect(pool.claude.map((account) => account.file.name)).toEqual([
      'claude-a.json',
      'claude-b.json',
      'legacy.json',
    ]);
    expect(pool.claude[0].candidate?.preferred).toBe(true);
    expect(pool.claude[2].candidate).toBeNull();
    expect(pool.codex.map((account) => account.file.name)).toEqual(['codex-c.json']);
  });

  test('summary covers enabled accounts and counts unknown resets', () => {
    const pool = buildPoolAccounts(normalizedFiles(), null);
    const claude = summarizePool(pool.claude, NOW);
    expect(claude.accountCount).toBe(3);
    expect(claude.enabledCount).toBe(2);
    expect(claude.avgLongUsedPercent).toBe(60);
    expect(claude.maxLongUsedPercent).toBe(60);
    expect(claude.earliestLongResetMs).toBe(Date.parse('2026-11-15T09:00:00Z'));
    // legacy.json is enabled but has never served a request since the restart.
    expect(claude.unknownResetCount).toBe(1);
    expect(claude.cacheReadShare24h).toBeCloseTo(120000 / 129500, 10);

    const codex = summarizePool(pool.codex, NOW);
    expect(codex.avgLongUsedPercent).toBe(80);
    expect(codex.earliestLongResetMs).toBeNull();
    expect(codex.unknownResetCount).toBe(1);
    expect(codex.cacheReadShare24h).toBeNull();
  });

  test('past resets do not count as the earliest upcoming reset', () => {
    const pool = buildPoolAccounts(normalizedFiles(), null);
    const later = Date.parse('2026-11-16T00:00:00Z');
    expect(summarizePool(pool.claude, later).earliestLongResetMs).toBeNull();
  });

  test('window lengths and statuses', () => {
    expect(windowLengthParts(300)).toEqual({ value: 5, unit: 'hour' });
    expect(windowLengthParts(10080)).toEqual({ value: 7, unit: 'day' });
    expect(windowLengthParts(90)).toEqual({ value: 90, unit: 'minute' });
    expect(windowLengthParts(null)).toBeNull();
    expect(windowTone('allowed')).toBe('ok');
    expect(windowTone('allowed_warning')).toBe('warning');
    expect(windowTone('rejected')).toBe('limited');
    expect(windowTone('')).toBe('unknown');
  });
});

describe('pool rendering', () => {
  const initialLanguage = i18n.language;
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });
  afterAll(async () => {
    await i18n.changeLanguage(initialLanguage);
  });

  const classes = bindQuotaClasses(
    Object.fromEntries(QUOTA_CLASS_KEYS.map((key) => [key, key])),
    'test-host'
  );

  test('account card shows windows, cache share and unknown reset', () => {
    const pool = buildPoolAccounts(
      normalizedFiles(),
      normalizeRoutingPreference(PREFERENCE_PAYLOAD)
    );
    const html = renderToStaticMarkup(
      createElement(PoolAccountCard, {
        account: pool.codex[0],
        classes,
        nowMs: NOW,
        pending: false,
        disableControls: false,
        onToggle: () => {},
      })
    );
    expect(html).toContain('primary');
    expect(html).toContain('7d');
    expect(html).toContain('80% used');
    expect(html).toContain('reset unknown');
    expect(html).toContain('No token usage recorded yet.');
    expect(html).toContain('aria-label="Enable codex-c.json"');

    const preferred = renderToStaticMarkup(
      createElement(PoolAccountCard, {
        account: pool.claude[0],
        classes,
        nowMs: NOW,
        pending: false,
        disableControls: false,
        onToggle: () => {},
      })
    );
    expect(preferred).toContain('Preferred');
    expect(preferred).toContain('#1');
    expect(preferred).toContain('93.6%');
  });

  test('routing panel labels the ranking as a preview when soonest-reset is inactive', () => {
    const preference = normalizeRoutingPreference({
      ...PREFERENCE_PAYLOAD,
      strategy: 'round-robin',
      strategy_active: false,
    });
    const html = renderToStaticMarkup(
      createElement(PoolRoutingPanel, {
        preference,
        provider: preference.providers[0],
        nowMs: NOW,
      })
    );
    expect(html).toContain('What soonest-reset would pick');
    expect(html).toContain('claude-a.json · a@example.com');
    expect(html).toContain('reset unknown');

    const active = normalizeRoutingPreference(PREFERENCE_PAYLOAD);
    expect(
      renderToStaticMarkup(
        createElement(PoolRoutingPanel, {
          preference: active,
          provider: active.providers[0],
          nowMs: NOW,
        })
      )
    ).toContain('Preferred account');
  });
});
