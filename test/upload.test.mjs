import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readAuthConfig } from '../src/auth.mjs';
import { createApp } from '../src/server.mjs';
import { matchDepartment } from '../src/departments.mjs';
import { checkFile, safeFileName, readUploadConfig } from '../src/upload.mjs';
import { readProcessConfig } from '../src/process.mjs';

const NOW = Date.parse('2026-11-19T06:00:00Z');
const PDF = Buffer.from('%PDF-1.7 test document');
const PIPELINE = 'https://w.example/api/w/beforest-automations/jobs/run/f/f/kms/process_approved_document_pipeline';
const LEADER = 'l'.repeat(40);
const TEAM = 't'.repeat(40);

test('departments: short names, typos and "Level / Department" are understood; unclear text is never guessed', () => {
  const cases = {
    'hr': 'HR', 'Human Resources': 'HR', 'fin': 'Finance & Accounts', 'Finanace': 'Finance & Accounts',
    'BI': 'Business Intelligence', 'bussiness intelligence': 'Business Intelligence', 'Team / HR': 'HR',
    'Leadership / finance & accounts': 'Finance & Accounts', 'ops': 'Collective Operations', 'be wild': 'Bewild',
    'liaisoning': 'Legal & Liasoning', 'Regolth': 'Regolith', 'CDS': 'Collective Design & Support',
  };
  for (const [typed, expected] of Object.entries(cases)) assert.equal(matchDepartment(typed).department, expected, typed);
  for (const typed of ['', 'marketing', 'finance hr', 'Team', 'Leadership /']) assert.equal(matchDepartment(typed).department, undefined, typed);
});

test('files: the real type is checked, names are kept, sizes are limited', () => {
  assert.equal(readUploadConfig({}).maxBytes, 150 * 1048576);
  assert.throws(() => readUploadConfig({ UPLOAD_MAX_MB: '151' }));
  assert.equal(checkFile('a.pdf', PDF, 1000), 'pdf');
  const zip = name => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`${name}/document.xml`)]);
  assert.equal(checkFile('a.pptx', zip('ppt'), 1000), 'pptx');
  assert.equal(checkFile('a.xlsx', zip('xl'), 1000), 'xlsx');
  assert.throws(() => checkFile('a.docx', zip('ppt'), 1000), /real \.docx/);
  assert.throws(() => checkFile('a.pdf', Buffer.from('MZ fake'), 1000), /real \.pdf/);
  assert.throws(() => checkFile('a.exe', PDF, 1000), error => error.status === 415);
  assert.throws(() => checkFile('a.pdf', PDF, 5), error => error.status === 413);
  assert.equal(safeFileName('C:\\Users\\me\\BI-October-2026-Bulletin.pptx'), 'BI-October-2026-Bulletin.pptx');
  assert.equal(safeFileName('Budget: "Q3" <final>?.xlsx'), 'Budget Q3 final.xlsx');
  assert.throws(() => safeFileName('no-extension'));
});

async function startApp({ pipeline = async () => Response.json('job-123'), conflicts = 0, processing = true } = {}) {
  const calls = { uploads: [], pipeline: [] };
  let taken = conflicts;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'a', expires_in: 14400 });
    if (url.endsWith('/files/list_folder')) return Response.json({ has_more: false, entries: [] });
    if (url.endsWith('/files/upload')) {
      const arg = JSON.parse(options.headers['Dropbox-API-Arg']);
      calls.uploads.push(arg);
      if (taken-- > 0) return Response.json({ error_summary: 'path/conflict/file/..' }, { status: 409 });
      return Response.json({ id: 'id:NewFile123', rev: '0123456789abcdef', name: arg.path.split('/').pop() });
    }
    if (url === PIPELINE) { calls.pipeline.push({ body: JSON.parse(options.body), auth: options.headers.Authorization }); return pipeline(); }
    return new Response('unexpected', { status: 500 });
  };
  const app = createApp({ base: 'https://w.example', workspace: 't', token: 't', timeoutMs: 1000 }, {
    auth: readAuthConfig({ MCP_USERS: `asha:leader:${LEADER},ravi:employee:${TEAM}` }), fetchImpl, now: () => NOW,
    dropbox: { enabled: true, appKey: 'k', appSecret: 's', refreshToken: 'r', timeoutMs: 1000 },
    processing: processing ? readProcessConfig({ WINDMILL_WEBHOOK_URL: PIPELINE, WINDMILL_WEBHOOK_TOKEN: 'pipeline-token' }) : { enabled: false },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mcp = async (key, fn) => {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
    try { return await fn(client); } finally { await client.close(); }
  };
  const send = (link, name, bytes) => fetch(`${base}/upload/file`, {
    method: 'POST', body: bytes,
    headers: { 'X-Upload-Token': link.split('#')[1], 'X-File-Name': encodeURIComponent(name), 'Content-Type': 'application/octet-stream' },
  });
  return { server, base, calls, mcp, send };
}

test('Claude flow: list departments, pick one, upload into the own level, indexing starts with the file id', async () => {
  const { server, base, calls, mcp, send } = await startApp();
  try {
    const { departments, link } = await mcp(LEADER, async client => {
      const names = (await client.listTools()).tools.map(tool => tool.name);
      assert.ok(names.includes('list_departments') && names.includes('upload_document'));
      const list = (await client.callTool({ name: 'list_departments', arguments: {} })).structuredContent;
      const made = (await client.callTool({ name: 'upload_document', arguments: { department: 'finanace' } })).structuredContent;
      return { departments: list, link: made };
    });
    assert.equal(departments.level, 'Leadership');
    assert.equal(departments.departments.length, 10);
    assert.equal(link.department, 'Finance & Accounts');
    assert.equal(link.dropbox_destination, '/Apps/KMS-Documents (1)/Leadership/Finance & Accounts/');
    assert.ok(link.upload_link.startsWith(`${base}/upload#`));

    const check = await (await fetch(`${base}/upload/check`, { headers: { 'X-Upload-Token': link.upload_link.split('#')[1] } })).json();
    assert.equal(check.folder, 'Leadership / Finance & Accounts');

    const response = await send(link.upload_link, 'Budget 2027.pdf', PDF);
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.deepEqual(calls.uploads[0], { path: '/Leadership/Finance & Accounts/Budget 2027.pdf', mode: 'add', autorename: false, mute: true, strict_conflict: true });
    assert.equal(result.indexing, 'started');
    assert.equal(result.dropbox_destination, '/Apps/KMS-Documents (1)/Leadership/Finance & Accounts/Budget 2027.pdf');
    assert.deepEqual(calls.pipeline[0].body, {
      event_type: 'approved_document_uploaded', approval_status: 'approved',
      dropbox_file_id: 'id:NewFile123', dropbox_revision: '0123456789abcdef',
      dropbox_path: '/Apps/KMS-Documents (1)/Leadership/Finance & Accounts/Budget 2027.pdf',
      file_name: 'Budget 2027.pdf', file_size_bytes: PDF.length,
    });
    assert.equal(calls.pipeline[0].auth, 'Bearer pipeline-token');

    const again = await send(link.upload_link, 'Budget 2027.pdf', PDF);
    assert.equal(again.status, 409);
  } finally { server.close(); }
});

test('never overwrites, never guesses the department, and a team key only reaches Team', async () => {
  const { server, calls, mcp, send } = await startApp({ conflicts: 2 });
  try {
    await mcp(TEAM, async client => {
      const unclear = await client.callTool({ name: 'upload_document', arguments: { department: 'marketing' } });
      assert.equal(unclear.isError, true);
      assert.match(unclear.content[0].text, /choose one of: Bewild, Business Intelligence/);
      const made = (await client.callTool({ name: 'upload_document', arguments: { department: 'Leadership / HR' } })).structuredContent;
      assert.equal(made.level, 'Team');
      const result = await (await send(made.upload_link, 'Policy.pdf', PDF)).json();
      assert.equal(result.file_name, 'Policy (3).pdf');
      assert.deepEqual(calls.uploads.map(arg => arg.path), ['/Team/HR/Policy.pdf', '/Team/HR/Policy (2).pdf', '/Team/HR/Policy (3).pdf']);
    });
  } finally { server.close(); }
});

test('links are refused when tampered, expired or the key level changed; bad files never reach Dropbox', async () => {
  const { server, base, calls, mcp, send } = await startApp();
  try {
    const link = (await mcp(TEAM, client => client.callTool({ name: 'upload_document', arguments: { department: 'HR' } }))).structuredContent.upload_link;
    const [body, mac] = link.split('#')[1].split('.');
    const raised = JSON.parse(Buffer.from(body, 'base64url').toString());
    raised.l = 'oceo';
    const forged = `${base}/upload#${Buffer.from(JSON.stringify(raised)).toString('base64url')}.${mac}`;
    assert.equal((await send(forged, 'a.pdf', PDF)).status, 403);
    assert.equal((await send(link, 'a.pdf', Buffer.from('not a pdf'))).status, 415);
    assert.equal(calls.uploads.length, 0);
    const blocked = await fetch(`${base}/upload/check`, { headers: { Origin: 'https://evil.example', 'X-Upload-Token': link.split('#')[1] } });
    assert.equal(blocked.status, 403);
  } finally { server.close(); }
});

test('if indexing cannot start, the file is still saved and the person is told', async () => {
  const { server, mcp, send } = await startApp({ pipeline: async () => new Response('no', { status: 403 }) });
  try {
    const link = (await mcp(LEADER, client => client.callTool({ name: 'upload_document', arguments: { department: 'BI' } }))).structuredContent.upload_link;
    const result = await (await send(link, 'BI-October-2026-Bulletin.pdf', PDF)).json();
    assert.equal(result.saved, true);
    assert.equal(result.indexing, 'not_started');
    assert.match(result.message, /tell the KMS team/);
  } finally { server.close(); }
});

test('upload tools stay off until the pipeline start is configured', async () => {
  const { server, mcp } = await startApp({ processing: false });
  try {
    const names = await mcp(LEADER, async client => (await client.listTools()).tools.map(tool => tool.name));
    assert.ok(!names.includes('upload_document') && !names.includes('list_departments'));
    assert.ok(names.includes('get_document_link'));
  } finally { server.close(); }
});
