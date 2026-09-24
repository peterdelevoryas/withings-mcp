import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.WITHINGS_CLIENT_ID ??= 'x';
process.env.WITHINGS_CLIENT_SECRET ??= 'x';
const { localize } = await import('../src/tools.js');

test('imperial converts weights, height, distances, and temperatures', () => {
  const out = localize(
    {
      range: '2026-09-01..2026-09-24',
      sessions: [{ time: '2026-09-24 06:22', weight_kg: 85.437, fat_ratio_pct: 21.5, height_m: 1.8, body_temperature_c: 37 }],
      days: [{ date: '2026-09-18', distance: 1731.19, steps: 2062 }],
      nights: [{ core_body_temperature_avg: 36.5, core_body_temperature_status: 'usual' }],
    },
    'imperial',
  );
  assert.deepEqual(out, {
    range: '2026-09-01..2026-09-24',
    sessions: [{ time: '2026-09-24 06:22', weight_lb: 188.4, fat_ratio_pct: 21.5, height_in: 70.9, body_temperature_f: 98.6 }],
    days: [{ date: '2026-09-18', distance_mi: 1.08, steps: 2062 }],
    nights: [{ core_body_temperature_avg_f: 97.7, core_body_temperature_status: 'usual' }],
  });
});

test('metric leaves values untouched', () => {
  const v = { weight_kg: 85.4, distance: 100 };
  assert.deepEqual(localize(v, 'metric'), v);
});
