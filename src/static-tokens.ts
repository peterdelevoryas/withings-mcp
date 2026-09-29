import { readFileSync } from 'node:fs';
import { hash } from './db.js';

/**
 * Long-lived bearer tokens for clients that can't do the OAuth flow, like a
 * headless agent. The file holds one client per line,
 * `<sha256-of-token> <source> <withings-userid>`; only hashes are stored. It's
 * read on every check, so adding or revoking a line needs no restart.
 */
export interface StaticGrant {
  source: string;
  userid: string;
}

export function lookupStaticToken(path: string | undefined, token: string): StaticGrant | undefined {
  if (!path) return undefined;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`reading static tokens file ${path}:`, err);
    return undefined;
  }
  const tokenHash = hash(token);
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [lineHash, source, userid] = line.split(/\s+/);
    if (lineHash === tokenHash && source && userid) return { source, userid };
  }
  return undefined;
}
