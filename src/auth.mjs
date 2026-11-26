import { createHash, timingSafeEqual } from 'node:crypto';

// Lowest first: a person sees content at or below their own level.
export const LEVELS = ['employee', 'leader', 'oceo'];

// Hash before comparing so timingSafeEqual always sees equal-length buffers.
const digest = value => createHash('sha256').update(value).digest();
const list = value => (value || '').split(',').map(entry => entry.trim()).filter(Boolean);

// A wrong entry is skipped (and reported by position, never by its text) instead of stopping the server,
// so one typo only locks out that one person. The server still refuses to start when tokens were given
// but none is valid, or when container networking is on and there are no tokens at all.
export function readAuthConfig(env = process.env, { required = false } = {}) {
  const entries = [];
  const skipped = [];
  const skip = (entry, reason) => { entry.bad = true; skipped.push({ entry: entry.where, reason }); };
  // One token per person (name:level:token) so one person can be switched off or moved without touching anyone else.
  list(env.MCP_USERS).forEach((text, i) => {
    const entry = { where: `MCP_USERS entry ${i + 1}` };
    entries.push(entry);
    const [name, level, token, ...rest] = text.split(':');
    if (!name || !token || rest.length) return skip(entry, 'Each MCP_USERS entry must be name:level:token.');
    if (!/^[a-z0-9._-]+$/i.test(name)) return skip(entry, 'MCP_USERS names may only use letters, digits, dot, dash and underscore.');
    if (!LEVELS.includes(level)) return skip(entry, `MCP_USERS level must be one of ${LEVELS.join(', ')}.`);
    Object.assign(entry, { name, level, token });
  });
  // Legacy shared secrets see everything; remove them once everyone has their own token.
  list(env.MCP_AUTH_TOKENS).forEach((token, i) => entries.push({ where: `MCP_AUTH_TOKENS entry ${i + 1}`, name: 'shared', level: 'oceo', token }));
  for (const entry of entries) {
    if (!entry.bad && (entry.token.length < 32 || /\s/.test(entry.token))) skip(entry, 'Each token must be at least 32 characters with no spaces.');
  }
  // A name or token used twice is ambiguous, so every entry that shares it is skipped, not just the later one.
  const count = key => entries.filter(entry => !entry.bad).reduce((seen, entry) => seen.set(key(entry), (seen.get(key(entry)) ?? 0) + 1), new Map());
  const names = count(entry => (entry.name === 'shared' ? entry.where : entry.name.toLowerCase()));
  const tokens = count(entry => entry.token);
  for (const entry of entries.filter(entry => !entry.bad)) {
    if (names.get(entry.name === 'shared' ? entry.where : entry.name.toLowerCase()) > 1) skip(entry, 'MCP_USERS names must be unique.');
    else if (tokens.get(entry.token) > 1) skip(entry, 'Tokens must be unique.');
  }
  const users = entries.filter(entry => !entry.bad);
  if (entries.length > 0 && users.length === 0) {
    throw new Error(`No valid token entries, so the server will not start: ${skipped.map(({ entry, reason }) => `${entry}: ${reason}`).join(' ')}`);
  }
  if (required && users.length === 0) throw new Error('Set MCP_USERS (or MCP_AUTH_TOKENS) before enabling container networking.');
  return {
    enabled: users.length > 0,
    users: users.map(({ name, level, token }) => ({ name, level, digest: digest(token) })),
    skipped,
  };
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
