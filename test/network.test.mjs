import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readNetworkConfig } from '../src/network.mjs';
import { createApp, startServer } from '../src/server.mjs';

const config = { base: 'https://unused.example', workspace: 'test', token: 'fake', timeoutMs: 1000 };
test('defaults to localhost and requires exact hosts for container networking', () => {
  assert.equal(readNetworkConfig({}).host, '127.0.0.1');
  assert.throws(() => readNetworkConfig({ HOST: '0.0.0.0' }), /MCP_ALLOWED_HOSTS/);
  for (const host of ['*', 'https://mcp.example', 'mcp.example:3100', 'mcp.example/mcp']) {
    assert.throws(() => readNetworkConfig({ MCP_ALLOWED_HOSTS: host }), /exact hostnames/);
  }
  assert.throws(() => readNetworkConfig({ HOST: 'external.example' }), /HOST must/);
});
test('container mode binds all interfaces only when explicitly requested', async () => {
  const network = readNetworkConfig({ HOST: '0.0.0.0', MCP_ALLOWED_HOSTS: 'mcp.internal' });
  const listener = await startServer(config, 0, network);
  try {
    assert.equal(listener.address().address, '0.0.0.0');
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/health`);
    assert.deepEqual(await response.json(), { status: 'ok', mode: 'container-private' });
  } finally { await new Promise(resolve => listener.close(resolve)); }
});
test('proxy host allowlist rejects origins and forwarded-host spoofing', async () => {
  const network = readNetworkConfig({ HOST: '0.0.0.0', MCP_ALLOWED_HOSTS: 'mcp.internal' });
  const app = createApp(config, { network });
  const listener = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const call = headers => new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${listener.address().port}/health`, { headers }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  try {
    assert.equal(await call({ Host: 'mcp.internal:3100' }), 200);
    assert.equal(await call({ Host: 'untrusted.example' }), 403);
    assert.equal(await call({ Host: 'untrusted.example', 'X-Forwarded-Host': 'mcp.internal' }), 403);
    assert.equal(await call({ Host: 'mcp.internal', Origin: 'https://untrusted.example' }), 403);
  } finally { await new Promise(resolve => listener.close(resolve)); }
});
