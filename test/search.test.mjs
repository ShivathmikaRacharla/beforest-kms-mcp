import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createSearch, readConfig } from '../src/search.mjs';
import { createApp } from '../src/server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const config = { base: 'https://windmill.example', workspace: 'test', token: 'secret-test-token', timeoutMs: 1000 };
const fixture = { retrieved: true, document_count: 2, documents: [{ private: 'not needed' }], matches: [{ text: 'A relevant passage.', score: 0.8, file_name: 'policy.pdf', dropbox_path: '/Approved/policy.pdf', page_number: 2 }] };
const boss = { name: 'test', level: 'oceo' };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('validates configuration without echoing credentials', () => {
  assert.throws(() => readConfig({}), /Set WINDMILL/);
  assert.throws(() => readConfig({ WINDMILL_BASE_URL: 'ftp://example', WINDMILL_WORKSPACE: 'x', WINDMILL_TOKEN: 'secret' }), /Invalid/);
});
test('calls only the V1 verified search script and preserves citation fields', async () => {
  const search = createSearch(config, async (url, options) => {
    assert.equal(url, 'https://windmill.example/api/w/test/jobs/run_wait_result/p/f/kms/retrieve_verified_chunks');
    assert.deepEqual(JSON.parse(options.body), { question: 'Policy?', department: 'HR', limit: 3, role: 'oceo' });
    assert.equal(options.headers.Authorization, 'Bearer secret-test-token');
    assert.equal(options.redirect, 'error');
    return json(fixture);
  });
  const result = await search({ question: ' Policy? ', department: 'HR', limit: 3 }, boss);
  assert.equal(result.matches[0].page_number, 2);
  assert.equal(result.matches[0].section, null);
  assert.equal(result.documents, undefined);
});
test('invalid inputs never call Windmill', async () => {
  let calls = 0;
  const search = createSearch(config, async () => { calls++; return json(fixture); });
  for (const input of [{ question: '' }, { question: 'x', limit: 21 }, { question: 'x', limit: 1.5 }, { question: 'x', script_path: 'other' }]) await assert.rejects(search(input, boss));
  assert.equal(calls, 0);
});
test('V1: when the check keeps nothing, the search is still successful and returns no passages', async () => {
  const v1 = { retrieved: true, document_count: 2, matches: [], verification: { min_score: 0.65, returned_by_search: 5, kept: 0, dropped: 5 } };
  const result = await createSearch(config, async () => json(v1))({ question: 'Who audits the accounts?' }, boss);
  assert.deepEqual(result.matches, []);
  assert.equal(result.verification, undefined);
});
test('empty results are a successful search', async () => {
  const result = await createSearch(config, async () => json({ retrieved: false, matches: [] }))({ question: 'Unknown' }, boss);
  assert.deepEqual(result.matches, []);
});
test('upstream errors do not expose response bodies or credentials', async () => {
  const search = createSearch(config, async () => new Response('secret-test-token internal stack', { status: 401 }));
  await assert.rejects(search({ question: 'x' }, boss), { message: 'Knowledge search failed (HTTP 401).' });
});
test('timeout and malformed responses are handled', async () => {
  await assert.rejects(createSearch(config, async () => { throw new DOMException('private details', 'TimeoutError'); })({ question: 'x' }, boss), /timed out/);
  await assert.rejects(createSearch(config, async () => json({ matches: 'wrong' }))({ question: 'x' }, boss), /unexpected response/);
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

test('waiting line: only 2 searches reach Windmill at once, the rest wait their turn', async () => {
  let inside = 0, most = 0, calls = 0;
  const slow = async () => { calls++; inside++; most = Math.max(most, inside); await new Promise(r => setTimeout(r, 30)); inside--; return json(fixture); };
  const search = createSearch({ ...config, maxParallel: 2, queueWaitMs: 5000 }, slow);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => search({ question: `q${i}` }, boss)));
  assert.equal(calls, 10);
  assert.equal(most, 2);
  for (const result of results) assert.equal(result.matches[0].text, 'A relevant passage.');
});

test('waiting line: a search that waits too long is told the KMS is busy', async () => {
  const stuck = async () => { await new Promise(r => setTimeout(r, 200)); return json(fixture); };
  const search = createSearch({ ...config, maxParallel: 1, queueWaitMs: 20 }, stuck);
  const first = search({ question: 'first' }, boss);
  await assert.rejects(search({ question: 'second' }, boss), /KMS is busy/);
  assert.equal((await first).matches.length, 1);
});

test('waiting line: a failed search frees its place for the next one', async () => {
  let n = 0;
  const flaky = async () => (n++ === 0 ? new Response('no', { status: 500 }) : json(fixture));
  const search = createSearch({ ...config, maxParallel: 1, queueWaitMs: 1000 }, flaky);
  const [a, b] = await Promise.allSettled([search({ question: 'a' }, boss), search({ question: 'b' }, boss)]);
  assert.equal(a.status, 'rejected');
  assert.equal(b.status, 'fulfilled');
});

test('waiting line settings are validated', () => {
  const base = { WINDMILL_BASE_URL: 'https://windmill.example', WINDMILL_WORKSPACE: 'x', WINDMILL_TOKEN: 'secret' };
  assert.equal(readConfig(base).maxParallel, 2);
  assert.equal(readConfig(base).queueWaitMs, 20000);
  assert.throws(() => readConfig({ ...base, KMS_MAX_PARALLEL_SEARCHES: '0' }), /KMS_MAX_PARALLEL_SEARCHES/);
  assert.throws(() => readConfig({ ...base, KMS_SEARCH_QUEUE_WAIT_MS: 'abc' }), /KMS_SEARCH_QUEUE_WAIT_MS/);
});
