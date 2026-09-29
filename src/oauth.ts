import type { Response } from 'express';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { config } from './config.js';
import { type Db, type Grant, now, randomToken } from './db.js';
import { lookupStaticToken } from './static-tokens.js';
import type { Withings } from './withings.js';

const PENDING_TTL = 10 * 60;
const CODE_TTL = 5 * 60;
const ACCESS_TTL = 24 * 60 * 60;
const REFRESH_TTL = 90 * 24 * 60 * 60;

/**
 * An OAuth authorization server for MCP clients whose login step is Withings' own OAuth consent.
 * Claude → /authorize → Withings consent → /withings/callback → Claude, with our own code/tokens
 * issued at the end and mapped to the Withings user who approved.
 */
export class WithingsOAuthProvider implements OAuthServerProvider {
  constructor(
    private db: Db,
    private withings: Withings,
  ) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: clientId => this.db.getClient(clientId) as OAuthClientInformationFull | undefined,
      // The SDK's registration handler generates client_id before calling this, despite the Omit<> in the signature.
      registerClient: client => {
        const full = client as OAuthClientInformationFull;
        this.db.saveClient(full.client_id, full);
        return full;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const state = randomToken();
    this.db.savePending(
      state,
      {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        state: params.state,
        scopes: params.scopes ?? [],
        resource: params.resource?.href,
      },
      PENDING_TTL,
    );
    res.redirect(this.withings.authorizeUrl(state));
  }

  /** Handles the redirect back from Withings and finishes the MCP client's authorization request. */
  async handleWithingsCallback(query: Record<string, unknown>, res: Response): Promise<void> {
    const pending = typeof query.state === 'string' ? this.db.takePending(query.state) : undefined;
    if (!pending) {
      res.status(400).type('text').send('This authorization request is unknown or expired. Start the connection again from Claude.');
      return;
    }
    const back = (params: Record<string, string>) => {
      const url = new URL(pending.redirectUri);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      if (pending.state) url.searchParams.set('state', pending.state);
      res.redirect(url.href);
    };

    if (typeof query.code !== 'string') {
      back({ error: 'access_denied', error_description: 'Withings authorization was declined' });
      return;
    }

    let exchanged;
    try {
      exchanged = await this.withings.exchangeCode(query.code);
    } catch (err) {
      console.error('Withings code exchange failed', err);
      back({ error: 'server_error', error_description: 'Could not complete Withings authorization' });
      return;
    }

    if (!this.isAllowed(exchanged.userid)) {
      console.warn(`Rejected Withings user ${exchanged.userid}: not on the allowlist`);
      back({ error: 'access_denied', error_description: 'This Withings account is not allowed to use this server' });
      return;
    }
    exchanged.save();

    const code = randomToken();
    this.db.saveAuthCode(code, {
      client_id: pending.clientId,
      userid: exchanged.userid,
      code_challenge: pending.codeChallenge,
      redirect_uri: pending.redirectUri,
      scopes: pending.scopes.join(' '),
      resource: pending.resource ?? null,
      expires_at: now() + CODE_TTL,
    });
    back({ code });
  }

  private isAllowed(userid: string): boolean {
    if (config.allowedUserIds.length > 0) return config.allowedUserIds.includes(userid);
    const owner = this.db.getMeta('owner_userid');
    if (owner) return owner === userid;
    this.db.setMeta('owner_userid', userid);
    console.log(`Withings user ${userid} is now the owner of this server`);
    return true;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const code = this.db.getAuthCode(authorizationCode);
    if (!code || code.client_id !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
    return code.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const code = this.db.takeAuthCode(authorizationCode);
    if (!code || code.client_id !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
    if (redirectUri && redirectUri !== code.redirect_uri) throw new InvalidGrantError('redirect_uri mismatch');
    return this.issueTokens(code);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const grant = this.db.takeToken(refreshToken, 'refresh');
    if (!grant || grant.client_id !== client.client_id) throw new InvalidGrantError('Invalid refresh token');
    return this.issueTokens(grant);
  }

  private issueTokens(grant: Pick<Grant, 'client_id' | 'userid' | 'scopes' | 'resource'>): OAuthTokens {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    this.db.saveToken(accessToken, 'access', { ...grant, expires_at: now() + ACCESS_TTL });
    this.db.saveToken(refreshToken, 'refresh', { ...grant, expires_at: now() + REFRESH_TTL });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL,
      refresh_token: refreshToken,
      scope: grant.scopes || undefined,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const fixed = lookupStaticToken(config.staticTokensFile, token);
    if (fixed) {
      return {
        token,
        clientId: `static:${fixed.source}`,
        scopes: [],
        // Static tokens don't expire (revoke by removing the line), but the SDK
        // requires an expiry, so each check vouches for the next minute.
        expiresAt: now() + 60,
        extra: { userid: fixed.userid },
      };
    }
    const grant = this.db.getToken(token, 'access');
    if (!grant) throw new InvalidTokenError('Invalid or expired access token');
    return {
      token,
      clientId: grant.client_id,
      scopes: grant.scopes ? grant.scopes.split(' ') : [],
      expiresAt: grant.expires_at,
      resource: grant.resource ? new URL(grant.resource) : undefined,
      extra: { userid: grant.userid },
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.db.deleteToken(request.token);
  }
}
