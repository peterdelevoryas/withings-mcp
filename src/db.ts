import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const now = () => Math.floor(Date.now() / 1000);
export const randomToken = () => randomBytes(32).toString('base64url');
export const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export interface WithingsTokens {
  userid: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
}

export interface PendingAuth {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
}

export interface Grant {
  client_id: string;
  userid: string;
  scopes: string;
  resource: string | null;
  expires_at: number;
}

export type Db = ReturnType<typeof openDb>;

export function openDb(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS withings_tokens (
      userid TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      scope TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS clients (client_id TEXT PRIMARY KEY, info TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pending_auth (state TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      userid TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      scopes TEXT NOT NULL,
      resource TEXT,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tokens (
      token_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
      client_id TEXT NOT NULL,
      userid TEXT NOT NULL,
      scopes TEXT NOT NULL,
      resource TEXT,
      expires_at INTEGER NOT NULL
    );
  `);

  return {
    getMeta(key: string): string | undefined {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value;
    },
    setMeta(key: string, value: string) {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    },

    getWithingsTokens(userid: string): WithingsTokens | undefined {
      return db.prepare('SELECT * FROM withings_tokens WHERE userid = ?').get(userid) as WithingsTokens | undefined;
    },
    saveWithingsTokens(t: WithingsTokens) {
      db.prepare(
        `INSERT INTO withings_tokens (userid, access_token, refresh_token, expires_at, scope) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(userid) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at, scope = excluded.scope`,
      ).run(t.userid, t.access_token, t.refresh_token, t.expires_at, t.scope);
    },

    getClient(clientId: string): unknown {
      const row = db.prepare('SELECT info FROM clients WHERE client_id = ?').get(clientId) as { info: string } | undefined;
      return row && JSON.parse(row.info);
    },
    saveClient(clientId: string, info: unknown) {
      db.prepare('INSERT INTO clients (client_id, info) VALUES (?, ?)').run(clientId, JSON.stringify(info));
    },

    savePending(state: string, data: PendingAuth, ttl: number) {
      db.prepare('INSERT INTO pending_auth (state, data, expires_at) VALUES (?, ?, ?)').run(state, JSON.stringify(data), now() + ttl);
    },
    // Single use: the row is deleted on read.
    takePending(state: string): PendingAuth | undefined {
      const row = db.prepare('DELETE FROM pending_auth WHERE state = ? RETURNING data, expires_at').get(state) as
        | { data: string; expires_at: number }
        | undefined;
      if (!row || row.expires_at < now()) return undefined;
      return JSON.parse(row.data);
    },

    saveAuthCode(code: string, g: Grant & { code_challenge: string; redirect_uri: string }) {
      db.prepare(
        `INSERT INTO auth_codes (code_hash, client_id, userid, code_challenge, redirect_uri, scopes, resource, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(hash(code), g.client_id, g.userid, g.code_challenge, g.redirect_uri, g.scopes, g.resource, g.expires_at);
    },
    getAuthCode(code: string) {
      return db.prepare('SELECT * FROM auth_codes WHERE code_hash = ? AND expires_at >= ?').get(hash(code), now()) as
        | (Grant & { code_challenge: string; redirect_uri: string })
        | undefined;
    },
    takeAuthCode(code: string) {
      return db.prepare('DELETE FROM auth_codes WHERE code_hash = ? AND expires_at >= ? RETURNING *').get(hash(code), now()) as
        | (Grant & { code_challenge: string; redirect_uri: string })
        | undefined;
    },

    saveToken(token: string, kind: 'access' | 'refresh', g: Grant) {
      db.prepare(
        'INSERT INTO tokens (token_hash, kind, client_id, userid, scopes, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(hash(token), kind, g.client_id, g.userid, g.scopes, g.resource, g.expires_at);
    },
    getToken(token: string, kind: 'access' | 'refresh'): Grant | undefined {
      return db.prepare('SELECT * FROM tokens WHERE token_hash = ? AND kind = ? AND expires_at >= ?').get(hash(token), kind, now()) as
        | Grant
        | undefined;
    },
    takeToken(token: string, kind: 'access' | 'refresh'): Grant | undefined {
      return db
        .prepare('DELETE FROM tokens WHERE token_hash = ? AND kind = ? AND expires_at >= ? RETURNING *')
        .get(hash(token), kind, now()) as Grant | undefined;
    },
    deleteToken(token: string) {
      db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(hash(token));
    },

    purgeExpired() {
      const t = now();
      for (const table of ['pending_auth', 'auth_codes', 'tokens']) {
        db.prepare(`DELETE FROM ${table} WHERE expires_at < ?`).run(t);
      }
    },
  };
}
