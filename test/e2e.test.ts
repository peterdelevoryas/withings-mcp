// End-to-end: a fake Withings API + the real server as a child process, driven through the
// same OAuth + MCP flow Claude uses (DCR → authorize → Withings consent → token → tools/call).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const OWNER = '4242';
let nextUser = OWNER;
let validAccessToken = '';
let tokenSerial = 0;
const refreshTokens = new Set<string>();
const calls: string[] = [];

const fake = express();
fake.use(express.urlencoded({ extended: false }));
fake.get('/authorize', (req, res) => {
  const url = new URL(String(req.query.redirect_uri));
  url.searchParams.set('code', `code-for-${nextUser}`);
  url.searchParams.set('state', String(req.query.state));
  res.redirect(url.href);
});
fake.post('/v2/oauth2', (req, res) => {
  const b = req.body;
  if (b.action !== 'requesttoken' || b.client_id !== 'cid' || b.client_secret !== 'csecret') return res.json({ status: 503 });
  let userid: string;
  if (b.grant_type === 'authorization_code') userid = String(b.code).replace('code-for-', '');
  else if (b.grant_type === 'refresh_token' && refreshTokens.delete(b.refresh_token)) userid = OWNER;
  else return res.json({ status: 503, error: 'invalid refresh token' });
  tokenSerial++;
  validAccessToken = `at-${tokenSerial}`;
  const refresh = `rt-${tokenSerial}`;
  refreshTokens.add(refresh);
  calls.push(`token:${b.grant_type}`);
  res.json({ status: 0, body: { userid: Number(userid), access_token: validAccessToken, refresh_token: refresh, expires_in: 10800, scope: 'user.metrics', token_type: 'Bearer' } });
});
const authed = (handler: (body: Record<string, string>) => unknown): express.RequestHandler => (req, res) => {
  if (req.headers.authorization !== `Bearer ${validAccessToken}`) return res.json({ status: 401, error: 'invalid_token' });
  calls.push(`${req.path}:${req.body.action}`);
  res.json({ status: 0, body: handler(req.body) });
};
fake.post('/measure', authed(b => {
  // Two pages to exercise pagination.
  if (!b.offset) {
    return { more: 1, offset: 1, measuregrps: [{ date: 1758700800, timezone: 'America/Los_Angeles', attrib: 0, category: 1, measures: [{ value: 80123, unit: -3, type: 1 }, { value: 2150, unit: -2, type: 6 }] }] };
  }
  return { more: 0, offset: 0, measuregrps: [{ date: 1758614400, timezone: 'America/Los_Angeles', attrib: 2, category: 1, measures: [{ value: 120, unit: 0, type: 10 }, { value: 80, unit: 0, type: 9 }] }] };
}));
fake.post('/v2/sleep', authed(b => {
  assert.match(b.startdateymd, /^\d{4}-\d{2}-\d{2}$/);
  return { more: false, offset: 0, series: [{ date: '2026-09-24', startdate: 1758690000, enddate: 1758718800, timezone: 'America/Los_Angeles', model: 'Sleep Analyzer', data: { sleep_score: 82, total_sleep_time: 25200, deepsleepduration: 5400, hr_average: 55, apnea_hypopnea_index: null } }] };
}));
fake.post('/v2/measure', authed(b => {
  if (b.action === 'getactivity') return { more: false, offset: 0, activities: [{ date: '2026-09-23', timezone: 'America/Los_Angeles', deviceid: 'x', brand: 1, is_tracker: true, steps: 9876, distance: 7100.5, active: 3600 }] };
  if (b.action === 'getworkouts') return { more: false, offset: 0, series: [{ category: 2, startdate: 1758650000, enddate: 1758652700, timezone: 'America/Los_Angeles', data: { calories: 320, hr_average: 150, steps: 5000 } }] };
  throw new Error(`unexpected action ${b.action}`);
}));
fake.post('/v2/heart', authed(() => ({ more: false, offset: 0, series: [{ timestamp: 1758700000, timezone: 'America/Los_Angeles', heart_rate: 62, ecg: { signalid: 1, afib: 0 } }] })));
fake.post('/v2/user', authed(() => ({ devices: [{ type: 'Scale', model: 'Body Scan', battery: 'high', last_session_date: 1758700000, timezone: 'America/Los_Angeles' }] })));

const STATIC_TOKEN = 'static-test-token';
const staticTokensFile = join(mkdtempSync(join(tmpdir(), 'withings-mcp-')), 'tokens');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

let fakeServer: ReturnType<typeof fake.listen>;
let app: ChildProcess;
let base = '';

before(async () => {
  writeFileSync(staticTokensFile, `# comment\n${sha256(STATIC_TOKEN)} agent ${OWNER}\n`);
  fakeServer = fake.listen(0, '127.0.0.1');
  await new Promise(r => fakeServer.once('listening', r));
  const fakeBase = `http://127.0.0.1:${(fakeServer.address() as AddressInfo).port}`;
  const port = 30000 + Math.floor(Math.random() * 10000);
  base = `http://localhost:${port}`;
  app = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_URL: base,
      DB_PATH: ':memory:',
      WITHINGS_CLIENT_ID: 'cid',
      WITHINGS_CLIENT_SECRET: 'csecret',
      WITHINGS_AUTHORIZE_URL: `${fakeBase}/authorize`,
      WITHINGS_API_BASE: fakeBase,
      STATIC_TOKENS_FILE: staticTokensFile,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    app.stdout!.on('data', d => String(d).includes('listening') && resolve());
    app.once('exit', code => reject(new Error(`server exited ${code}`)));
  });
});

after(() => {
  app?.kill();
  fakeServer?.close();
});

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

async function connect(asUser: string) {
  nextUser = asUser;
  // 401 advertises the protected resource metadata.
  const unauth = await fetch(`${base}/mcp`, { method: 'POST' });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate') ?? '', /resource_metadata=/);

  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${base}/mcp`);
  const asMeta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();

  const reg = await (await fetch(asMeta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'test', token_endpoint_auth_method: 'client_secret_post' }),
  })).json();

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authUrl = new URL(asMeta.authorization_endpoint);
  authUrl.search = new URLSearchParams({
    response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'client-state', resource: `${base}/mcp`,
  }).toString();

  // /authorize → fake Withings → /withings/callback → client redirect
  let url = authUrl.href;
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { redirect: 'manual' });
    assert.equal(r.status, 302, `hop ${i} from ${url}`);
    url = r.headers.get('location')!;
  }
  const final = new URL(url);
  assert.equal(final.origin + final.pathname, REDIRECT);
  assert.equal(final.searchParams.get('state'), 'client-state');
  return { final, reg, verifier };
}

async function tokenRequest(reg: { client_id: string; client_secret: string }, params: Record<string, string>) {
  const r = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: reg.client_id, client_secret: reg.client_secret, ...params }),
  });
  return { status: r.status, body: await r.json() };
}

async function rpc(token: string, method: string, params: unknown = {}) {
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  assert.equal(r.status, 200);
  return (await r.json()).result;
}

async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const result = await rpc(token, 'tools/call', { name, arguments: args });
  assert.ok(!result.isError, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

let accessToken = '';
let refreshToken = '';
let client: { client_id: string; client_secret: string };

test('first Withings account to connect becomes the owner and gets tokens', async () => {
  const { final, reg, verifier } = await connect(OWNER);
  const code = final.searchParams.get('code')!;
  assert.ok(code);

  const bad = await tokenRequest(reg, { grant_type: 'authorization_code', code, code_verifier: 'wrong'.repeat(10), redirect_uri: REDIRECT });
  assert.equal(bad.status, 400);

  const ok = await tokenRequest(reg, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  accessToken = ok.body.access_token;
  refreshToken = ok.body.refresh_token;
  client = reg;

  const replay = await tokenRequest(reg, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT });
  assert.equal(replay.status, 400, 'codes are single-use');
});

test('a different Withings account is rejected', async () => {
  const { final } = await connect('9999');
  assert.equal(final.searchParams.get('error'), 'access_denied');
  assert.equal(final.searchParams.get('code'), null);
});

test('tools/list exposes all tools', async () => {
  const { tools } = await rpc(accessToken, 'tools/list');
  assert.deepEqual(tools.map((t: { name: string }) => t.name).sort(), [
    'get_activity', 'get_devices', 'get_heart_recordings', 'get_measurements', 'get_sleep', 'get_workouts',
  ]);
});

test('get_measurements converts values and follows pagination', async () => {
  const r = await callTool(accessToken, 'get_measurements', { start_date: '2026-09-01', end_date: '2026-09-24' });
  assert.equal(r.count, 2);
  assert.equal(r.sessions[0].weight_kg, 80.123);
  assert.equal(r.sessions[0].fat_ratio_pct, 21.5);
  assert.equal(r.sessions[1].systolic_bp_mmhg, 120);
  assert.equal(r.sessions[1].manual_entry, true);
});

test('sleep, activity, workouts, heart, devices', async () => {
  const sleep = await callTool(accessToken, 'get_sleep');
  assert.equal(sleep.nights[0].sleep_score, 82);
  assert.equal(sleep.nights[0].total_sleep_time_min, 420);
  assert.equal(sleep.nights[0].deepsleepduration_min, 90);
  assert.ok(!('apnea_hypopnea_index' in sleep.nights[0]), 'nulls dropped');

  const activity = await callTool(accessToken, 'get_activity');
  assert.deepEqual(activity.days[0], { date: '2026-09-23', steps: 9876, distance: 7100.5, active_min: 60 });

  const workouts = await callTool(accessToken, 'get_workouts');
  assert.equal(workouts.workouts[0].type, 'Run');
  assert.equal(workouts.workouts[0].duration_min, 45);

  const heart = await callTool(accessToken, 'get_heart_recordings');
  assert.equal(heart.recordings[0].afib, 'negative');

  const devices = await callTool(accessToken, 'get_devices');
  assert.equal(devices[0].model, 'Body Scan');
});

test('an expired Withings access token is refreshed transparently', async () => {
  validAccessToken = 'rotated-server-side';
  calls.length = 0;
  const devices = await callTool(accessToken, 'get_devices');
  assert.equal(devices[0].model, 'Body Scan');
  assert.deepEqual(calls, ['token:refresh_token', '/v2/user:getdevice']);
});

test('bad dates return a tool error, not a crash', async () => {
  const result = await rpc(accessToken, 'tools/call', { name: 'get_sleep', arguments: { start_date: 'yesterday' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /YYYY-MM-DD/);
});

test('MCP refresh tokens rotate', async () => {
  const r = await tokenRequest(client, { grant_type: 'refresh_token', refresh_token: refreshToken });
  assert.equal(r.status, 200);
  assert.notEqual(r.body.access_token, accessToken);
  await rpc(r.body.access_token, 'tools/list');
  const reuse = await tokenRequest(client, { grant_type: 'refresh_token', refresh_token: refreshToken });
  assert.equal(reuse.status, 400);
});

test('a static bearer token acts as its Withings user, and removing its line revokes it', async () => {
  const tools = await rpc(STATIC_TOKEN, 'tools/list');
  assert.ok(tools.tools.length > 0);
  await callTool(STATIC_TOKEN, 'get_sleep');
  writeFileSync(staticTokensFile, '');
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${STATIC_TOKEN}` } });
  assert.equal(r.status, 401);
});

test('garbage bearer tokens are rejected', async () => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer nope' } });
  assert.equal(r.status, 401);
});
