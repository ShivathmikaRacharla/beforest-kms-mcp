import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readAuthConfig } from '../src/auth.mjs';
import { createApp } from '../src/server.mjs';

const config = { base: 'https://windmill.example', workspace: 'test', token: 'fake', timeoutMs: 1000 };
const current = 'a'.repeat(40);
const next = 'b'.repeat(40);
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } };

async function serve(auth, fetchImpl) {
  const app = createApp(config, { auth, fetchImpl });
  const listener = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { listener, base: `http://127.0.0.1:${listener.address().port}` };
}
const post = (base, headers = {}) => fetch(base + '/mcp', {
  method: 'POST', body: JSON.stringify(initialize),
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
});

test('auth config requires strong secrets and is mandatory when asked', () => {
  assert.equal(readAuthConfig({}).enabled, false);
  assert.throws(() => readAuthConfig({}, { required: true }), /Set MCP_AUTH_TOKENS/);
  assert.throws(() => readAuthConfig({ MCP_AUTH_TOKENS: 'short' }), /at least 32/);
  assert.throws(() => readAuthConfig({ MCP_AUTH_TOKENS: `${current},tiny` }), /at least 32/);
  assert.equal(readAuthConfig({ MCP_AUTH_TOKENS: ` ${current} , ${next} ` }).digests.length, 2);
});
test('rejects missing, malformed and wrong secrets before the MCP layer', async () => {
  let calls = 0;
  const { listener, base } = await serve(readAuthConfig({ MCP_AUTH_TOKENS: current }), async () => { calls++; return json({ matches: [] }); });
  try {
    for (const headers of [{}, { Authorization: current }, { Authorization: `Basic ${current}` }, { Authorization: `Bearer ${next}` }, { Authorization: `Bearer ${current}x` }, { Authorization: 'Bearer ' }]) {
      const response = await post(base, headers);
      assert.equal(response.status, 401, JSON.stringify(headers));
      assert.match(response.headers.get('www-authenticate'), /^Bearer /);
      assert.doesNotMatch(await response.text(), new RegExp(current));
    }
    assert.equal((await fetch(base + '/mcp')).status, 401);
    assert.equal((await fetch(base + '/health')).status, 200, 'health stays open for Coolify checks');
    assert.equal(calls, 0);
  } finally { await new Promise(resolve => listener.close(resolve)); }
});
test('official MCP client with the shared secret can search; rotated secrets both work', async () => {
  const { listener, base } = await serve(readAuthConfig({ MCP_AUTH_TOKENS: `${current},${next}` }), async () => json({ retrieved: true, matches: [{ text: 'Passage.', score: 0.9, file_name: 'a.pdf', dropbox_path: '/a.pdf' }] }));
  try {
    for (const secret of [current, next]) {
      const client = new Client({ name: 'auth-test', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }));
      try {
        const result = await client.callTool({ name: 'search_knowledge', arguments: { question: 'Policy?' } });
        assert.equal(result.structuredContent.matches[0].file_name, 'a.pdf');
      } finally { await client.close(); }
    }
    assert.equal((await post(base, { Authorization: `bearer ${current}` })).status, 200, 'scheme is case-insensitive');
  } finally { await new Promise(resolve => listener.close(resolve)); }
});
test('local-only mode without secrets stays open for development', async () => {
  const { listener, base } = await serve(readAuthConfig({}), async () => json({ matches: [] }));
  try { assert.equal((await post(base)).status, 200); }
  finally { await new Promise(resolve => listener.close(resolve)); }
});
