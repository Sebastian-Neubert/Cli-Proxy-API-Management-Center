import { describe, expect, test } from 'bun:test';
import { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse as parseYaml } from 'yaml';
import { buildRoutingPlan, draftFromBoard } from '../src/features/routing/logic';
import { parseRoutingStrategy, useVisualConfig } from '../src/hooks/useVisualConfig';
import {
  buildRoutingBoard,
  buildRoutingConfigPatch,
  normalizeRoutingStrategy,
  readRoutingSettings,
} from '../src/services/api/routing';
import { ROUTING_STRATEGIES } from '../src/types/routing';

const ALIASES = ['soonest-reset', 'soonestreset', 'sr', ' Soonest-Reset '];

describe('soonest-reset routing strategy', () => {
  test('both parsers recognize the backend aliases', () => {
    for (const alias of ALIASES) {
      expect(parseRoutingStrategy(alias)).toBe('soonest-reset');
      expect(normalizeRoutingStrategy(alias)).toBe('soonest-reset');
    }
    expect(normalizeRoutingStrategy('soonest_reset')).toBe('soonest-reset');
    expect(ROUTING_STRATEGIES).toContain('soonest-reset');
  });

  test('visual config keeps soonest-reset when another field changes', () => {
    const yaml = 'routing:\n  strategy: soonest-reset\n  retry:\n    request-retry: 1\n';
    let output = '';
    let parsed = '';
    function Harness() {
      const visualConfig = useVisualConfig();
      const [phase, setPhase] = useState(0);
      if (phase === 0) {
        visualConfig.loadVisualValuesFromYaml(yaml);
        setPhase(1);
      } else if (phase === 1) {
        parsed = visualConfig.visualValues.routingStrategy;
        visualConfig.setVisualValues({ requestRetry: '4' });
        setPhase(2);
      } else {
        output = visualConfig.applyVisualChangesToYaml(yaml);
      }
      return null;
    }
    renderToStaticMarkup(createElement(Harness));
    expect(parsed).toBe('soonest-reset');
    expect(parseYaml(output)).toEqual({
      routing: { strategy: 'soonest-reset', retry: { 'request-retry': 4 } },
    });
  });

  test('visual config writes soonest-reset when selected', () => {
    let output = '';
    function Harness() {
      const visualConfig = useVisualConfig();
      const [phase, setPhase] = useState(0);
      if (phase === 0) {
        visualConfig.setVisualValues({ routingStrategy: 'soonest-reset' });
        setPhase(1);
      } else {
        output = visualConfig.applyVisualChangesToYaml('routing:\n  strategy: round-robin\n');
      }
      return null;
    }
    renderToStaticMarkup(createElement(Harness));
    expect(parseYaml(output)).toEqual({ routing: { strategy: 'soonest-reset' } });
  });

  test('routing page round-trips soonest-reset and only writes it when changed', () => {
    const raw = { routing: { strategy: 'soonest-reset', 'session-affinity': false } };
    expect(readRoutingSettings(raw).strategy).toBe('soonest-reset');

    const board = buildRoutingBoard(raw, []);
    const draft = draftFromBoard(board);
    draft.settings = { ...draft.settings, sessionAffinity: true };
    const plan = buildRoutingPlan(board, draft);
    expect(plan.settings).toEqual({ sessionAffinity: true });
    expect(buildRoutingConfigPatch(raw, board, plan)).toEqual({
      routing: { 'session-affinity': true },
    });

    const fromRoundRobin = buildRoutingBoard({ routing: { strategy: 'round-robin' } }, []);
    const select = draftFromBoard(fromRoundRobin);
    select.settings = { ...select.settings, strategy: 'soonest-reset' };
    expect(
      buildRoutingConfigPatch(
        { routing: { strategy: 'round-robin' } },
        fromRoundRobin,
        buildRoutingPlan(fromRoundRobin, select)
      )
    ).toEqual({ routing: { strategy: 'soonest-reset' } });
  });
});
