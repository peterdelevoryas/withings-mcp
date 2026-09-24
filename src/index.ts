import express from 'express';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config, mcpUrl } from './config.js';
import { openDb } from './db.js';
import { WithingsOAuthProvider } from './oauth.js';
import { buildServer } from './tools.js';
import { Withings } from './withings.js';

const db = openDb(config.dbPath);
const withings = new Withings(db);
const provider = new WithingsOAuthProvider(db, withings);

const app = express();
app.set('trust proxy', 'loopback'); // Caddy terminates TLS in front of us

app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: config.publicUrl,
    resourceServerUrl: mcpUrl,
    resourceName: 'Withings',
  }),
);

app.get('/withings/callback', (req, res, next) => {
  provider.handleWithingsCallback(req.query, res).catch(next);
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

const bearer = requireBearerAuth({
  verifier: provider,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
});

// Stateless Streamable HTTP: a fresh server + transport per request.
app.post('/mcp', bearer, express.json({ limit: '1mb' }), async (req, res) => {
  const userid = req.auth?.extra?.userid as string;
  const server = buildServer(withings, userid);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request failed', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

app.all('/mcp', bearer, (_req, res) => {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
});

setInterval(() => db.purgeExpired(), 60 * 60 * 1000).unref();

app.listen(config.port, config.host, () => {
  console.log(`withings-mcp listening on ${config.host}:${config.port}, public URL ${config.publicUrl.href}`);
});
