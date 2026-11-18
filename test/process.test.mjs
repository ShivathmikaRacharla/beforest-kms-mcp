import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createProcess, parseDocumentPath, readProcessConfig, ROOT } from '../src/process.mjs';
import { readAuthConfig } from '../src/auth.mjs';
import { createApp } from '../src/server.mjs';

const FLOW_URL = 'https://windmill.example/api/w/test/jobs/run/f/f/kms/process_approved_document_pipeline';
const config = { enabled: true, url: FLOW_URL, token: 'webhook-test-token', timeoutMs: 1000 };
const leader = { name: 'wa-leader', level: 'leader' };
const employee = { name: 'wa-employee', level: 'employee' };
const good = {
  dropbox_path: `${ROOT}/Leadership/Collective Design & Support/CDS_GUIDE_Soil-Food-Web_V1_2026-11-12.pdf`,
  dropbox_file_id: 'id:5YcLS9tLFfAAAAAAAAAAUA',
  dropbox_revision: '016602600f9312a0000000377c44b83',
  uploaded_by: 'Shivathmika',
};
const ok = () => new Response('"0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"', { status: 201 });

test('config: off when unset, both values required, only the KMS pipeline URL accepted', () => {
  assert.equal(readProcessConfig({}).enabled, false);
  assert.throws(() => readProcessConfig({ WINDMILL_WEBHOOK_URL: FLOW_URL }), /both/);
  assert.throws(() => readProcessConfig({ WINDMILL_WEBHOOK_URL: 'https://windmill.example/api/w/test/jobs/run/p/f/other', WINDMILL_WEBHOOK_TOKEN: 'x' }), /process_approved_document_pipeline/);
  assert.throws(() => readProcessConfig({ WINDMILL_WEBHOOK_URL: FLOW_URL.replace('https', 'http'), WINDMILL_WEBHOOK_TOKEN: 'x' }), /https/);
  assert.equal(readProcessConfig({ WINDMILL_WEBHOOK_URL: FLOW_URL, WINDMILL_WEBHOOK_TOKEN: 'x' }).enabled, true);
});

test('path rules: level folder, space, naming, no traversal', () => {
  assert.deepEqual(parseDocumentPath(good.dropbox_path), { level: 'leader', levelFolder: 'Leadership', space: 'Collective Design & Support', fileName: 'CDS_GUIDE_Soil-Food-Web_V1_2026-11-12.pdf' });
  const bad = [
    '/Apps/Other/Team/HR/HR_POLICY_Leave_V1_2026-11-18.pdf',
    `${ROOT}/Founders/HR/HR_POLICY_Leave_V1_2026-11-18.pdf`,
    `${ROOT}/Team/Marketing/HR_POLICY_Leave_V1_2026-11-18.pdf`,
    `${ROOT}/Team/HR/final.pdf`,
    `${ROOT}/Team/HR/HR_POLICY_Leave_V1_2026-11-18.exe`,
    `${ROOT}/Team/HR/sub/HR_POLICY_Leave_V1_2026-11-18.pdf`,
    `${ROOT}/Team/../Leadership/HR_POLICY_Leave_V1_2026-11-18.pdf`,
  ];
  for (const path of bad) assert.throws(() => parseDocumentPath(path), undefined, path);
});

test('sends exactly the intake body to the pipeline with the webhook token', async () => {
  let sent;
  const start = createProcess(config, async (url, options) => { sent = { url, options }; return ok(); });
  const result = await start(good, leader);
  assert.equal(sent.url, FLOW_URL);
  assert.equal(sent.options.headers.Authorization, 'Bearer webhook-test-token');
  assert.equal(sent.options.redirect, 'error');
  assert.deepEqual(JSON.parse(sent.options.body), {
    event_type: 'approved_document_uploaded', dropbox_file_id: good.dropbox_file_id, dropbox_revision: good.dropbox_revision,
    dropbox_path: good.dropbox_path, approval_status: 'approved', file_name: 'CDS_GUIDE_Soil-Food-Web_V1_2026-11-12.pdf',
  });
  assert.equal(result.job_id, '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b');
  assert.equal(result.folder, 'Leadership / Collective Design & Support');
  assert.equal(result.visible_to, 'leaders and the Office of the CEO');
});

test('a level above the caller is refused and nothing is sent', async () => {
  let calls = 0;
  const start = createProcess(config, async () => { calls++; return ok(); });
  await assert.rejects(start(good, employee), /above yours. Choose Team\./);
  await assert.rejects(start({ ...good, dropbox_path: good.dropbox_path.replace('Leadership', 'Office of the CEO') }, leader), /Choose Team or Leadership/);
  await assert.rejects(start({ ...good, dropbox_file_id: 'not-an-id' }, leader));
  await assert.rejects(start({ ...good, extra: 'x' }, leader));
  await assert.rejects(start(good, undefined), /signed-in/);
  assert.equal(calls, 0);
});

test('upstream failures give plain messages without the token', async () => {
  const failing = createProcess(config, async () => new Response('nope', { status: 500 }));
  await assert.rejects(failing(good, leader), error => /HTTP 500/.test(error.message) && !error.message.includes('webhook-test-token'));
  const down = createProcess(config, async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(down(good, leader), /unavailable/);
});

test('the tool is listed only when processing is configured', async () => {
  const token = 'e'.repeat(40);
  const auth = readAuthConfig({ MCP_USERS: `wa-leader:leader:${token}` });
  const listTools = async processing => {
    const app = createApp({ base: 'https://w.example', workspace: 't', token: 't', timeoutMs: 1000 }, { auth, processing, fetchImpl: async () => ok() });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
      const client = new Client({ name: 'test', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      const { tools } = await client.listTools();
      await client.close();
      return tools.map(tool => tool.name).sort();
    } finally { server.close(); }
  };
  assert.deepEqual(await listTools({ enabled: false }), ['search_knowledge']);
  assert.deepEqual(await listTools(config), ['search_knowledge', 'start_processing']);
});
