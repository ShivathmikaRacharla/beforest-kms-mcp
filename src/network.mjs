export function readNetworkConfig(env = process.env) {
  const host = env.HOST?.trim() || '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0', '::1'].includes(host)) throw new Error('HOST must be 127.0.0.1, ::1 or 0.0.0.0.');
  const extras = (env.MCP_ALLOWED_HOSTS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (extras.some(value => !/^(?:\[::1\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/.test(value))) throw new Error('MCP_ALLOWED_HOSTS must contain exact hostnames without scheme, port, path or wildcards.');
  if (host === '0.0.0.0' && extras.length === 0) throw new Error('Set MCP_ALLOWED_HOSTS before enabling container networking.');
  return { host, allowedHosts: ['127.0.0.1', 'localhost', '[::1]', ...extras] };
}
