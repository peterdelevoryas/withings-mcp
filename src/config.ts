function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const port = Number(process.env.PORT ?? 3000);

export const config = {
  port,
  host: process.env.HOST ?? '127.0.0.1',
  // Public origin Claude reaches us at; also the OAuth issuer.
  publicUrl: new URL(process.env.PUBLIC_URL ?? `http://localhost:${port}`),
  dbPath: process.env.DB_PATH ?? './data/withings-mcp.db',
  // Used to interpret YYYY-MM-DD dates in tool arguments and to format timestamps.
  timezone: process.env.DEFAULT_TIMEZONE ?? 'America/Los_Angeles',
  // 'imperial' reports lb / in / mi / °F instead of Withings' native kg / m / °C.
  units: process.env.UNITS === 'imperial' ? 'imperial' : 'metric',
  // Withings user ids allowed to connect. If empty, the first account to connect becomes the owner.
  allowedUserIds: (process.env.ALLOWED_WITHINGS_USERIDS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  withings: {
    clientId: required('WITHINGS_CLIENT_ID'),
    clientSecret: required('WITHINGS_CLIENT_SECRET'),
    authorizeUrl: process.env.WITHINGS_AUTHORIZE_URL ?? 'https://account.withings.com/oauth2_user/authorize2',
    apiBase: process.env.WITHINGS_API_BASE ?? 'https://wbsapi.withings.net',
    scopes: 'user.info,user.metrics,user.activity,user.sleepevents',
  },
};

export const mcpUrl = new URL('/mcp', config.publicUrl);
export const withingsRedirectUri = new URL('/withings/callback', config.publicUrl).href;
