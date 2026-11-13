import { createHash, timingSafeEqual } from 'node:crypto';

// Lowest first: a person sees content at or below their own level.
export const LEVELS = ['employee', 'leader', 'oceo'];

// Hash before comparing so timingSafeEqual always sees equal-length buffers.
const digest = value => createHash('sha256').update(value).digest();
const list = value => (value || '').split(',').map(entry => entry.trim()).filter(Boolean);

export function readAuthConfig(env = process.env, { required = false } = {}) {
  const users = [];
  // One token per person (name:level:token) so one person can be switched off or moved without touching anyone else.
  for (const entry of list(env.MCP_USERS)) {
    const [name, level, token, ...rest] = entry.split(':');
    if (!name || !token || rest.length) throw new Error('Each MCP_USERS entry must be name:level:token.');
    if (!/^[a-z0-9._-]+$/i.test(name)) throw new Error('MCP_USERS names may only use letters, digits, dot, dash and underscore.');
    if (!LEVELS.includes(level)) throw new Error(`MCP_USERS level must be one of ${LEVELS.join(', ')}.`);
    users.push({ name, level, token });
  }
  // Legacy shared secrets see everything; remove them once everyone has their own token.
  for (const token of list(env.MCP_AUTH_TOKENS)) users.push({ name: 'shared', level: 'oceo', token });
  if (users.some(({ token }) => token.length < 32 || /\s/.test(token))) throw new Error('Each token must be at least 32 characters with no spaces.');
  const names = users.filter(user => user.name !== 'shared').map(user => user.name.toLowerCase());
  if (new Set(names).size !== names.length) throw new Error('MCP_USERS names must be unique.');
  if (new Set(users.map(user => user.token)).size !== users.length) throw new Error('Tokens must be unique.');
  if (required && users.length === 0) throw new Error('Set MCP_USERS (or MCP_AUTH_TOKENS) before enabling container networking.');
  return { enabled: users.length > 0, users: users.map(({ name, level, token }) => ({ name, level, digest: digest(token) })) };
}

// Local-only development without tokens runs as full access.
const LOCAL = Object.freeze({ name: 'local', level: 'oceo' });

export function requireBearer(auth) {
  return (req, res, next) => {
    if (!auth.enabled) { req.kmsUser = LOCAL; return next(); }
    const match = /^Bearer (\S+)$/i.exec(req.headers.authorization || '');
    const presented = match && digest(match[1]);
    const user = presented && auth.users.find(candidate => timingSafeEqual(candidate.digest, presented));
    if (user) { req.kmsUser = { name: user.name, level: user.level }; return next(); }
    res.status(401).set('WWW-Authenticate', 'Bearer realm="beforest-knowledge"').json({ error: 'Missing or invalid bearer token.' });
  };
}
