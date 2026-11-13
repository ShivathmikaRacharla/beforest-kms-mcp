import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readAuthConfig } from '../src/auth.mjs';
import { createSearch, passageLevel } from '../src/search.mjs';
import { createApp } from '../src/server.mjs';

const config = { base: 'https://windmill.example', workspace: 'test', token: 'fake', timeoutMs: 1000 };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const root = '/Apps/KMS-Documents (1)';
const passage = (path, extra = {}) => ({ text: path, score: 0.5, file_name: path.split('/').pop(), dropbox_path: path, ...extra });
const matches = [
  passage(`${root}/Office of the CEO/bi/board.pdf`),
  passage(`${root}/Leadership/HR/salaries.pdf`),
  passage(`${root}/Confidential/cds/plan.pdf`),
  passage(`${root}/Team/HR/leave.pdf`),
  passage(`${root}/HR/old-unsorted.pdf`),
  passage(`${root}/Team/bi/marked-up.pdf`, { min_role: 'leader' }),
];
const tokens = { asha: 'a'.repeat(40), lead: 'b'.repeat(40), emp: 'c'.repeat(40), shared: 'd'.repeat(40) };
const users = `asha:oceo:${tokens.asha}, lead:leader:${tokens.lead},emp:employee:${tokens.emp}`;

test('MCP_USERS parses name:level:token and rejects bad entries', () => {
  const auth = readAuthConfig({ MCP_USERS: users, MCP_AUTH_TOKENS: tokens.shared });
  assert.deepEqual(auth.users.map(u => `${u.name}:${u.level}`), ['asha:oceo', 'lead:leader', 'emp:employee', 'shared:oceo']);
  assert.ok(auth.users.every(u => !('token' in u)), 'raw tokens are not kept');
  assert.throws(() => readAuthConfig({ MCP_USERS: `x:boss:${tokens.asha}` }), /level must be one of/);
  assert.throws(() => readAuthConfig({ MCP_USERS: `x:employee` }), /name:level:token/);
  assert.throws(() => readAuthConfig({ MCP_USERS: `x:employee:${tokens.asha}:extra` }), /name:level:token/);
  assert.throws(() => readAuthConfig({ MCP_USERS: 'x:employee:short' }), /at least 32/);
  assert.throws(() => readAuthConfig({ MCP_USERS: `a b:employee:${tokens.asha}` }), /names may only/);
  assert.throws(() => readAuthConfig({ MCP_USERS: `x:employee:${tokens.asha},X:leader:${tokens.lead}` }), /unique/);
  assert.throws(() => readAuthConfig({ MCP_USERS: `x:employee:${tokens.asha},y:leader:${tokens.asha}` }), /Tokens must be unique/);
  assert.throws(() => readAuthConfig({}, { required: true }), /Set MCP_USERS/);
  assert.equal(readAuthConfig({ MCP_USERS: users }, { required: true }).enabled, true);
});

test('passage level comes from the stricter of folder and stored min_role; unknown is closed', () => {
  assert.deepEqual(matches.map(passageLevel), ['oceo', 'leader', 'leader', 'employee', 'oceo', 'leader']);
  assert.equal(passageLevel({ dropbox_path: null }), 'oceo');
  assert.equal(passageLevel({ dropbox_path: `${root}/team/x.pdf` }), 'employee', 'folder match ignores case');
  assert.equal(passageLevel({ dropbox_path: '/x.pdf', min_role: 'employee' }), 'employee');
  assert.equal(passageLevel({ dropbox_path: `${root}/Team/x.pdf`, min_role: 'nonsense' }), 'employee');
});

test('each level sees only its own and lower passages', async () => {
  const bodies = [];
  const search = createSearch(config, async (_url, options) => { bodies.push(JSON.parse(options.body)); return json({ retrieved: true, document_count: 30, matches }); });
  const files = async level => (await search({ question: 'q', limit: 10 }, { name: level, level })).matches.map(m => m.file_name);
  assert.deepEqual(await files('oceo'), matches.map(m => m.file_name));
  assert.deepEqual(await files('leader'), ['salaries.pdf', 'plan.pdf', 'leave.pdf', 'marked-up.pdf']);
  assert.deepEqual(await files('employee'), ['leave.pdf']);
  assert.deepEqual(bodies.map(b => b.limit), [10, 20, 20], 'over-fetches only when filtering');
  assert.deepEqual(bodies.map(b => b.role), ['oceo', 'leader', 'employee'], 'sends the viewer level to Windmill');
  const employee = await search({ question: 'q' }, { name: 'emp', level: 'employee' });
  assert.equal(employee.document_count, null, 'document count hidden below full access');
});

test('results are trimmed to the requested limit after filtering', async () => {
  const many = Array.from({ length: 8 }, (_, i) => passage(`${root}/Team/doc${i}.pdf`));
  const result = await createSearch(config, async () => json({ retrieved: true, matches: many }))({ question: 'q', limit: 3 }, { name: 'e', level: 'employee' });
  assert.equal(result.matches.length, 3);
});

test('search refuses to run without a known viewer', async () => {
  let calls = 0;
  const search = createSearch(config, async () => { calls++; return json({ retrieved: true, matches }); });
  for (const viewer of [undefined, {}, { name: 'x', level: 'admin' }]) await assert.rejects(search({ question: 'q' }, viewer), /signed-in user/);
  assert.equal(calls, 0);
});

test('over MCP, each person token gets its own level; legacy shared secret keeps full access', async () => {
  const app = createApp(config, { auth: readAuthConfig({ MCP_USERS: users, MCP_AUTH_TOKENS: tokens.shared }), fetchImpl: async () => json({ retrieved: true, matches }) });
  const listener = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const ask = async token => {
    const client = new Client({ name: 'levels-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    try { return (await client.callTool({ name: 'search_knowledge', arguments: { question: 'q', limit: 10 } })).structuredContent.matches.length; }
    finally { await client.close(); }
  };
  try {
    assert.equal(await ask(tokens.asha), 6);
    assert.equal(await ask(tokens.lead), 4);
    assert.equal(await ask(tokens.emp), 1);
    assert.equal(await ask(tokens.shared), 6);
    const wrong = await fetch(base + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${'e'.repeat(40)}`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(wrong.status, 401);
  } finally { await new Promise(resolve => listener.close(resolve)); }
});
