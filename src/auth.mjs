import { createHash, timingSafeEqual } from 'node:crypto';

// Hash before comparing so timingSafeEqual always sees equal-length buffers.
const digest = value => createHash('sha256').update(value).digest();

export function readAuthConfig(env = process.env, { required = false } = {}) {
  // Comma-separated so a new secret can be rolled out before the old one is removed.
  const tokens = (env.MCP_AUTH_TOKENS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (tokens.some(token => token.length < 32 || /\s/.test(token))) throw new Error('Each MCP_AUTH_TOKENS entry must be at least 32 characters with no spaces.');
  if (required && tokens.length === 0) throw new Error('Set MCP_AUTH_TOKENS before enabling container networking.');
  return { enabled: tokens.length > 0, digests: tokens.map(digest) };
}

export function requireBearer(auth) {
  return (req, res, next) => {
    if (!auth.enabled) return next();
    const match = /^Bearer (\S+)$/i.exec(req.headers.authorization || '');
    const presented = match && digest(match[1]);
    if (presented && auth.digests.some(expected => timingSafeEqual(expected, presented))) return next();
    res.status(401).set('WWW-Authenticate', 'Bearer realm="beforest-knowledge"').json({ error: 'Missing or invalid bearer token.' });
  };
}
