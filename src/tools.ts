import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { config } from './config.js';
import { formatTs, resolveRange } from './time.js';
import type { Withings } from './withings.js';

// Withings measure type codes → output field names (unit in the suffix).
const MEASURE_TYPES = {
  weight_kg: 1,
  height_m: 4,
  fat_free_mass_kg: 5,
  fat_ratio_pct: 6,
  fat_mass_kg: 8,
  diastolic_bp_mmhg: 9,
  systolic_bp_mmhg: 10,
  heart_rate_bpm: 11,
  temperature_c: 12,
  spo2_pct: 54,
  body_temperature_c: 71,
  skin_temperature_c: 73,
  muscle_mass_kg: 76,
  hydration_kg: 77,
  bone_mass_kg: 88,
  pulse_wave_velocity_m_s: 91,
  vo2_max: 123,
  afib_result: 130,
  qrs_interval_ms: 135,
  pr_interval_ms: 136,
  qt_interval_ms: 137,
  qtc_interval_ms: 138,
  afib_ppg_result: 139,
  vascular_age: 155,
  nerve_health_score: 167,
  extracellular_water_kg: 168,
  intracellular_water_kg: 169,
  visceral_fat: 170,
  basal_metabolic_rate_kcal: 226,
  metabolic_age: 227,
  electrodermal_activity: 229,
} as const;
type MeasureName = keyof typeof MEASURE_TYPES;
const MEASURE_NAMES = Object.keys(MEASURE_TYPES) as [MeasureName, ...MeasureName[]];
const MEASURE_BY_CODE = new Map<number, string>(Object.entries(MEASURE_TYPES).map(([k, v]) => [v, k]));

const WORKOUT_CATEGORIES: Record<number, string> = {
  1: 'Walk', 2: 'Run', 3: 'Hiking', 4: 'Skating', 5: 'BMX', 6: 'Bicycling', 7: 'Swimming', 8: 'Surfing',
  9: 'Kitesurfing', 10: 'Windsurfing', 11: 'Bodyboard', 12: 'Tennis', 13: 'Table tennis', 14: 'Squash',
  15: 'Badminton', 16: 'Lift weights', 17: 'Fitness', 18: 'Elliptical', 19: 'Pilates', 20: 'Basketball',
  21: 'Soccer', 22: 'Football', 23: 'Rugby', 24: 'Volleyball', 25: 'Waterpolo', 26: 'Horse riding', 27: 'Golf',
  28: 'Yoga', 29: 'Dancing', 30: 'Boxing', 31: 'Fencing', 32: 'Wrestling', 33: 'Martial arts', 34: 'Skiing',
  35: 'Snowboarding', 36: 'Other', 128: 'No activity', 187: 'Rowing', 188: 'Zumba', 191: 'Baseball',
  192: 'Handball', 193: 'Hockey', 194: 'Ice hockey', 195: 'Climbing', 196: 'Ice skating', 272: 'Multi-sport',
  306: 'Indoor walk', 307: 'Indoor running', 308: 'Indoor cycling', 455: 'Standup paddleboarding', 456: 'Padel',
  491: 'Stair stepper', 494: 'Kayaking', 498: 'Trail running', 523: 'Mountain biking', 524: 'Gravel biking',
  525: 'E-biking', 530: 'Nordic skiing', 546: 'Crossfit', 547: 'Spin class', 550: 'HIIT', 551: 'Meditation',
  552: 'Stretching', 559: 'Dog walking', 560: 'Breathing exercises', 566: 'Nordic walking',
};

const SLEEP_FIELDS = [
  'sleep_score', 'total_timeinbed', 'total_sleep_time', 'asleepduration', 'lightsleepduration', 'remsleepduration',
  'deepsleepduration', 'sleep_efficiency', 'sleep_latency', 'wakeup_latency', 'wakeupduration', 'wakeupcount', 'waso',
  'nb_rem_episodes', 'out_of_bed_count', 'hr_average', 'hr_min', 'hr_max', 'rr_average', 'rr_min', 'rr_max',
  'rmssd_start_avg', 'rmssd_end_avg', 'snoring', 'snoringepisodecount', 'breathing_disturbances_intensity',
  'apnea_hypopnea_index', 'core_body_temperature_avg', 'core_body_temperature_status',
];
const SLEEP_SECONDS = new Set([
  'total_timeinbed', 'total_sleep_time', 'asleepduration', 'lightsleepduration', 'remsleepduration', 'deepsleepduration',
  'sleep_latency', 'wakeup_latency', 'wakeupduration', 'waso', 'snoring',
]);

const ACTIVITY_FIELDS = [
  'steps', 'distance', 'elevation', 'soft', 'moderate', 'intense', 'active', 'calories', 'totalcalories',
  'hr_average', 'hr_min', 'hr_max', 'hr_zone_0', 'hr_zone_1', 'hr_zone_2', 'hr_zone_3',
];
const ACTIVITY_SECONDS = new Set(['soft', 'moderate', 'intense', 'active', 'hr_zone_0', 'hr_zone_1', 'hr_zone_2', 'hr_zone_3']);

const WORKOUT_FIELDS = [
  'calories', 'intensity', 'manual_distance', 'manual_calories', 'hr_average', 'hr_min', 'hr_max', 'hr_zone_0',
  'hr_zone_1', 'hr_zone_2', 'hr_zone_3', 'pause_duration', 'spo2_average', 'steps', 'distance', 'elevation',
  'pool_laps', 'strokes', 'pool_length',
];
const WORKOUT_SECONDS = new Set(['hr_zone_0', 'hr_zone_1', 'hr_zone_2', 'hr_zone_3', 'pause_duration']);

const AFIB = ['negative', 'positive', 'inconclusive'];

/** Drops null fields and converts second-valued fields to rounded minutes with a `_min` suffix. */
function tidy(data: Record<string, unknown>, seconds: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) continue;
    if (seconds.has(k) && typeof v === 'number') out[`${k}_min`] = Math.round(v / 6) / 10;
    else out[k] = v;
  }
  return out;
}

const round = (v: number, digits: number) => +v.toFixed(digits);
const toF = (c: number) => round((c * 9) / 5 + 32, 1);

// Withings reports SI units. In imperial mode, rename and convert unit-bearing fields
// (identified by key) anywhere in a tool result.
const IMPERIAL: [RegExp, (k: string) => string, (v: number) => number][] = [
  [/_kg$/, k => k.replace(/_kg$/, '_lb'), v => round(v * 2.20462, 1)],
  [/^height_m$/, () => 'height_in', v => round(v * 39.3701, 1)],
  [/_c$/, k => k.replace(/_c$/, '_f'), toF],
  [/^core_body_temperature_(avg|min|max)$/, k => `${k}_f`, toF],
  [/^(manual_)?distance$/, k => `${k}_mi`, v => round(v / 1609.344, 2)],
];

export function localize(value: unknown, units = config.units): unknown {
  if (units !== 'imperial') return value;
  if (Array.isArray(value)) return value.map(v => localize(v, units));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const rule = typeof v === 'number' ? IMPERIAL.find(([re]) => re.test(k)) : undefined;
    if (rule) out[rule[1](k)] = rule[2](v as number);
    else out[k] = localize(v, units);
  }
  return out;
}

const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(localize(value)) }] });

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return json(await fn());
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
  }
}

const dateArgs = (defaultDays: number) => ({
  start_date: z.string().optional().describe(`First day to include, YYYY-MM-DD. Defaults to ${defaultDays - 1} days before end_date.`),
  end_date: z.string().optional().describe('Last day to include (inclusive), YYYY-MM-DD. Defaults to today.'),
});

export function buildServer(withings: Withings, userid: string): McpServer {
  const server = new McpServer(
    { name: 'withings', version: '0.1.0' },
    {
      instructions:
        `Health data from the user's Withings account (scale, sleep tracker, watch, blood pressure monitor). ` +
        `Dates are interpreted in ${config.timezone} unless a record carries its own timezone. ` +
        `Durations are reported in minutes (fields ending in _min). ` +
        (config.units === 'imperial'
          ? 'Weights are in pounds (_lb), height in inches (_in), distances in miles (_mi), temperatures in °F (_f).'
          : 'Weights are in kg, height and distances in meters, temperatures in °C.'),
    },
  );
  const tz = config.timezone;
  const readOnly = { readOnlyHint: true, openWorldHint: true };

  server.registerTool(
    'get_measurements',
    {
      title: 'Body measurements',
      description:
        'Body measurements from Withings scales, blood pressure monitors, thermometers, and watches: weight, body composition ' +
        '(fat, muscle, bone, water, visceral fat), blood pressure, heart rate, SpO2, temperature, VO2 max, ECG intervals, and more. ' +
        'Each entry is one measurement session (e.g. one weigh-in) with all values taken together. Newest first.',
      inputSchema: {
        ...dateArgs(30),
        types: z.array(z.enum(MEASURE_NAMES)).optional().describe('Limit to these measure types (named in metric units; results follow the server unit setting). Omit for all.'),
        limit: z.number().int().min(1).max(1000).optional().describe('Maximum number of sessions to return (default 200).'),
      },
      annotations: readOnly,
    },
    ({ start_date, end_date, types, limit }) =>
      run(async () => {
        const range = resolveRange(start_date, end_date, 30, tz);
        const codes = (types ?? MEASURE_NAMES).map(t => MEASURE_TYPES[t]);
        const groups = await withings.callPaged<{
          date: number;
          timezone?: string;
          attrib: number;
          measures: { value: number; unit: number; type: number }[];
        }>(userid, '/measure', {
          action: 'getmeas',
          meastypes: codes.join(','),
          category: 1,
          startdate: range.startTs,
          enddate: range.endTs,
        }, 'measuregrps');
        const sessions = groups
          .filter(g => g.measures.length > 0)
          .sort((a, b) => b.date - a.date)
          .slice(0, limit ?? 200)
          .map(g => {
            const entry: Record<string, unknown> = { time: formatTs(g.date, g.timezone ?? tz) };
            for (const m of g.measures) {
              entry[MEASURE_BY_CODE.get(m.type) ?? `type_${m.type}`] = +(m.value * 10 ** m.unit).toPrecision(6);
            }
            // attrib 2/4: entered manually; attrib 1: device could not tell which user stepped on.
            if (g.attrib === 2 || g.attrib === 4) entry.manual_entry = true;
            if (g.attrib === 1) entry.ambiguous_user = true;
            return entry;
          });
        return { range: `${range.startYmd}..${range.endYmd}`, count: sessions.length, sessions };
      }),
  );

  server.registerTool(
    'get_sleep',
    {
      title: 'Sleep summaries',
      description:
        'Nightly sleep summaries: sleep score, time in bed, total sleep, light/deep/REM durations, efficiency, latency, wake-ups, ' +
        'heart rate, respiration rate, HRV (rmssd), snoring, and breathing disturbances. One entry per sleep session, oldest first. ' +
        'The `date` of a night is the day the user woke up.',
      inputSchema: dateArgs(7),
      annotations: readOnly,
    },
    ({ start_date, end_date }) =>
      run(async () => {
        const range = resolveRange(start_date, end_date, 7, tz);
        const series = await withings.callPaged<{
          date: string;
          startdate: number;
          enddate: number;
          timezone?: string;
          model?: string;
          data: Record<string, unknown>;
        }>(userid, '/v2/sleep', {
          action: 'getsummary',
          startdateymd: range.startYmd,
          enddateymd: range.endYmd,
          data_fields: SLEEP_FIELDS.join(','),
        }, 'series');
        const nights = series
          .sort((a, b) => a.startdate - b.startdate)
          .map(s => ({
            date: s.date,
            bedtime: formatTs(s.startdate, s.timezone ?? tz),
            wake_time: formatTs(s.enddate, s.timezone ?? tz),
            device: s.model,
            ...tidy(s.data, SLEEP_SECONDS),
          }));
        return { range: `${range.startYmd}..${range.endYmd}`, count: nights.length, nights };
      }),
  );

  server.registerTool(
    'get_activity',
    {
      title: 'Daily activity',
      description:
        'Daily activity totals: steps, distance, floors climbed, soft/moderate/intense activity minutes, active and total calories, ' +
        'daily heart rate stats and heart rate zone minutes. One entry per day, oldest first.',
      inputSchema: dateArgs(7),
      annotations: readOnly,
    },
    ({ start_date, end_date }) =>
      run(async () => {
        const range = resolveRange(start_date, end_date, 7, tz);
        const activities = await withings.callPaged<Record<string, unknown> & { date: string }>(userid, '/v2/measure', {
          action: 'getactivity',
          startdateymd: range.startYmd,
          enddateymd: range.endYmd,
          data_fields: ACTIVITY_FIELDS.join(','),
        }, 'activities');
        const days = activities
          .sort((a, b) => a.date.localeCompare(b.date))
          .map(({ date, timezone: _tz, deviceid: _d, hash_deviceid: _h, brand: _b, is_tracker: _t, ...rest }) => ({
            date,
            ...tidy(rest, ACTIVITY_SECONDS),
          }));
        return { range: `${range.startYmd}..${range.endYmd}`, count: days.length, days };
      }),
  );

  server.registerTool(
    'get_workouts',
    {
      title: 'Workouts',
      description:
        'Workouts recorded by Withings watches or entered in the Withings app: type, start/end time, duration, calories, ' +
        'heart rate and zones, distance, steps, swim laps. Oldest first.',
      inputSchema: dateArgs(30),
      annotations: readOnly,
    },
    ({ start_date, end_date }) =>
      run(async () => {
        const range = resolveRange(start_date, end_date, 30, tz);
        const series = await withings.callPaged<{
          category: number;
          startdate: number;
          enddate: number;
          timezone?: string;
          data: Record<string, unknown>;
        }>(userid, '/v2/measure', {
          action: 'getworkouts',
          startdateymd: range.startYmd,
          enddateymd: range.endYmd,
          data_fields: WORKOUT_FIELDS.join(','),
        }, 'series');
        const workouts = series
          .sort((a, b) => a.startdate - b.startdate)
          .map(w => ({
            type: WORKOUT_CATEGORIES[w.category] ?? `category_${w.category}`,
            start: formatTs(w.startdate, w.timezone ?? tz),
            end: formatTs(w.enddate, w.timezone ?? tz),
            duration_min: Math.round((w.enddate - w.startdate) / 6) / 10,
            ...tidy(w.data, WORKOUT_SECONDS),
          }));
        return { range: `${range.startYmd}..${range.endYmd}`, count: workouts.length, workouts };
      }),
  );

  server.registerTool(
    'get_heart_recordings',
    {
      title: 'ECG and heart recordings',
      description:
        'ECG recordings (atrial fibrillation classification), plus any blood pressure and heart rate taken during the same ' +
        'recording, from ScanWatch, BPM Core, or Move ECG. Newest first.',
      inputSchema: dateArgs(90),
      annotations: readOnly,
    },
    ({ start_date, end_date }) =>
      run(async () => {
        const range = resolveRange(start_date, end_date, 90, tz);
        const series = await withings.callPaged<{
          timestamp: number;
          timezone?: string;
          model?: number;
          heart_rate?: number;
          ecg?: { afib?: number };
          bloodpressure?: { systole?: number; diastole?: number };
        }>(userid, '/v2/heart', { action: 'list', startdate: range.startTs, enddate: range.endTs }, 'series');
        const recordings = series
          .sort((a, b) => b.timestamp - a.timestamp)
          .map(r => ({
            time: formatTs(r.timestamp, r.timezone ?? tz),
            heart_rate_bpm: r.heart_rate,
            afib: r.ecg?.afib !== undefined ? (AFIB[r.ecg.afib] ?? r.ecg.afib) : undefined,
            systolic_bp_mmhg: r.bloodpressure?.systole,
            diastolic_bp_mmhg: r.bloodpressure?.diastole,
          }));
        return { range: `${range.startYmd}..${range.endYmd}`, count: recordings.length, recordings };
      }),
  );

  server.registerTool(
    'get_devices',
    {
      title: 'Devices',
      description: 'Withings devices linked to the account, with model, battery level, and last sync time.',
      inputSchema: {},
      annotations: readOnly,
    },
    () =>
      run(async () => {
        const body = await withings.call<{
          devices: { type: string; model: string; battery?: string; last_session_date?: number; timezone?: string; first_session_date?: number }[];
        }>(userid, '/v2/user', { action: 'getdevice' });
        return body.devices.map(d => ({
          type: d.type,
          model: d.model,
          battery: d.battery,
          last_sync: d.last_session_date ? formatTs(d.last_session_date, d.timezone ?? tz) : undefined,
        }));
      }),
  );

  return server;
}
