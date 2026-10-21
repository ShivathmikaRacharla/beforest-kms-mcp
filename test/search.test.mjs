import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createSearch, readConfig } from '../src/search.mjs';
import { createApp } from '../src/server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const config = { base: 'https://windmill.example', workspace: 'test', token: 'secret-test-token', timeoutMs: 1000 };
const fixture = { retrieved: true, document_count: 2, documents: [{ private: 'not needed' }], matches: [{ text: 'A relevant passage.', score: 0.8, file_name: 'policy.pdf', dropbox_path: '/Approved/policy.pdf', page_number: 2 }] };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('validates configuration without echoing credentials', () => {
  assert.throws(() => readConfig({}), /Set WINDMILL/);
  assert.throws(() => readConfig({ WINDMILL_BASE_URL: 'ftp://example', WINDMILL_WORKSPACE: 'x', WINDMILL_TOKEN: 'secret' }), /Invalid/);
});
test('calls only the fixed retrieval script and preserves citation fields', async () => {
  const search = createSearch(config, async (url, options) => {
    assert.equal(url, 'https://windmill.example/api/w/test/jobs/run_wait_result/p/f/kms/retrieve_qdrant_chunks');
    assert.deepEqual(JSON.parse(options.body), { question: 'Policy?', department: 'HR', limit: 3 });
    assert.equal(options.headers.Authorization, 'Bearer secret-test-token');
    assert.equal(options.redirect, 'error');
    return json(fixture);
  });
  const result = await search({ question: ' Policy? ', department: 'HR', limit: 3 });
  assert.equal(result.matches[0].page_number, 2);
  assert.equal(result.matches[0].section, null);
  assert.equal(result.documents, undefined);
});
test('invalid inputs never call Windmill', async () => {
  let calls = 0;
  const search = createSearch(config, async () => { calls++; return json(fixture); });
  for (const input of [{ question: '' }, { question: 'x', limit: 21 }, { question: 'x', limit: 1.5 }, { question: 'x', script_path: 'other' }]) await assert.rejects(search(input));
  assert.equal(calls, 0);
});
test('empty results are a successful search', async () => {
  const result = await createSearch(config, async () => json({ retrieved: false, matches: [] }))({ question: 'Unknown' });
  assert.deepEqual(result.matches, []);
});
test('upstream errors do not expose response bodies or credentials', async () => {
  const search = createSearch(config, async () => new Response('secret-test-token internal stack', { status: 401 }));
  await assert.rejects(search({ question: 'x' }), { message: 'Knowledge search failed (HTTP 401).' });
});
test('timeout and malformed responses are handled', async () => {
  await assert.rejects(createSearch(config, async () => { throw new DOMException('private details', 'TimeoutError'); })({ question: 'x' }), /timed out/);
  await assert.rejects(createSearch(config, async () => json({ matches: 'wrong' }))({ question: 'x' }), /unexpected response/);
});
test('official MCP client discovers tool, searches, rejects invalid limits, and receives tool errors', async () => {
  let calls = 0;
  const app = createApp(config, { fetchImpl: async () => { calls++; return calls === 1 ? json(fixture) : new Response('private', { status: 503 }); } });
  const listener = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  try {
    assert.equal((await fetch(base + '/health')).status, 200);
    assert.equal((await fetch(base + '/health', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    const rejectedHostStatus = await new Promise((resolve, reject) => {
      const req = request(base + '/health', { headers: { Host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(rejectedHostStatus, 403);
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name), ['search_knowledge']);
    const ok = await client.callTool({ name: 'search_knowledge', arguments: { question: 'Policy?' } });
    assert.equal(ok.structuredContent.matches[0].file_name, 'policy.pdf');
    const invalid = await client.callTool({ name: 'search_knowledge', arguments: { question: 'x', limit: 30 } });
    assert.equal(invalid.isError, true);
    assert.equal(calls, 1);
    const fail = await client.callTool({ name: 'search_knowledge', arguments: { question: 'x' } });
    assert.equal(fail.isError, true);
    assert.match(fail.content[0].text, /HTTP 503/);
  } finally { await client.close(); await new Promise(resolve => listener.close(resolve)); }
});
