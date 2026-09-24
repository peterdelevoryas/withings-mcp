import { config, withingsRedirectUri } from './config.js';
import { type Db, now } from './db.js';

export class WithingsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Withings returns HTTP 200 with a status code in the body; 100-102, 200 and 401 are auth failures.
const isAuthFailure = (status: number) => status === 401 || status === 200 || (status >= 100 && status <= 102);

interface TokenBody {
  userid: string | number;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}

export class Withings {
  // One in-flight refresh per user: Withings rotates refresh tokens, so concurrent refreshes would race.
  private refreshes = new Map<string, Promise<string>>();

  constructor(private db: Db) {}

  authorizeUrl(state: string): string {
    const url = new URL(config.withings.authorizeUrl);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: config.withings.clientId,
      scope: config.withings.scopes,
      redirect_uri: withingsRedirectUri,
      state,
    }).toString();
    return url.href;
  }

  /**
   * Exchanges an authorization code. Tokens are only persisted once the caller invokes `save`,
   * so accounts that fail the allowlist check leave nothing behind.
   */
  async exchangeCode(code: string): Promise<{ userid: string; save: () => void }> {
    const body = await this.post<TokenBody>('/v2/oauth2', {
      action: 'requesttoken',
      grant_type: 'authorization_code',
      client_id: config.withings.clientId,
      client_secret: config.withings.clientSecret,
      code,
      redirect_uri: withingsRedirectUri,
    });
    return { userid: String(body.userid), save: () => this.store(body) };
  }

  private store(body: TokenBody) {
    this.db.saveWithingsTokens({
      userid: String(body.userid),
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: now() + body.expires_in,
      scope: body.scope,
    });
  }

  private async accessToken(userid: string, forceRefresh = false): Promise<string> {
    const tokens = this.db.getWithingsTokens(userid);
    if (!tokens) throw new WithingsError(401, 'No Withings account linked. Reconnect the Withings connector in Claude.');
    if (!forceRefresh && tokens.expires_at - 60 > now()) return tokens.access_token;

    let pending = this.refreshes.get(userid);
    if (!pending) {
      pending = this.post<TokenBody>('/v2/oauth2', {
        action: 'requesttoken',
        grant_type: 'refresh_token',
        client_id: config.withings.clientId,
        client_secret: config.withings.clientSecret,
        refresh_token: tokens.refresh_token,
      })
        .then(body => {
          this.store(body);
          return body.access_token;
        })
        .catch(err => {
          if (err instanceof WithingsError && isAuthFailure(err.status)) {
            throw new WithingsError(err.status, 'Withings authorization expired or was revoked. Reconnect the Withings connector in Claude.');
          }
          throw err;
        })
        .finally(() => this.refreshes.delete(userid));
      this.refreshes.set(userid, pending);
    }
    return pending;
  }

  /** Calls an authenticated Withings endpoint, refreshing the access token once if it was rejected. */
  async call<T>(userid: string, path: string, params: Record<string, string | number | undefined>): Promise<T> {
    let token = await this.accessToken(userid);
    try {
      return await this.post<T>(path, params, token);
    } catch (err) {
      if (!(err instanceof WithingsError) || !isAuthFailure(err.status)) throw err;
      token = await this.accessToken(userid, true);
      return this.post<T>(path, params, token);
    }
  }

  /** Follows Withings `more`/`offset` pagination and concatenates `key` across pages. */
  async callPaged<T>(userid: string, path: string, params: Record<string, string | number | undefined>, key: string, maxPages = 20): Promise<T[]> {
    const out: T[] = [];
    let offset: number | undefined;
    for (let page = 0; page < maxPages; page++) {
      const body = await this.call<Record<string, unknown>>(userid, path, { ...params, offset });
      out.push(...((body[key] as T[] | undefined) ?? []));
      if (!body.more || !body.offset) break;
      offset = Number(body.offset);
    }
    return out;
  }

  private async post<T>(path: string, params: Record<string, string | number | undefined>, accessToken?: string): Promise<T> {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) form.set(k, String(v));
    const res = await fetch(new URL(path, config.withings.apiBase), {
      method: 'POST',
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new WithingsError(res.status, `Withings HTTP ${res.status}`);
    const json = (await res.json()) as { status: number; body: T; error?: string };
    if (json.status !== 0) {
      throw new WithingsError(json.status, `Withings API error ${json.status}${json.error ? `: ${json.error}` : ''}`);
    }
    return json.body;
  }
}
