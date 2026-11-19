import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readAuthConfig } from '../src/auth.mjs';
import { createApp } from '../src/server.mjs';
import { createLister } from '../src/list.mjs';
import { createLinker } from '../src/link.mjs';

const NOW = Date.parse('2026-11-19T06:00:00Z');
const file = (path, added = '2026-11-01T10:00:00Z') => ({ path, name: path.split('/').pop(), size: 1000, added });
const TEAM = '/Team/HR/HR_POLICY_Leave-and-Attendance_V2_2026-10-01.pdf';
const LEAD = '/Leadership/Collective Design & Support/CDS_GUIDE_Soil-Food-Web_V1_2026-11-12.pdf';
const CEO = '/Office of the CEO/Legal & Liasoning/LEGAL_REPORT_Board-Minutes_V1_2026-11-01.pdf';
const DOCX = '/Team/Finance & Accounts/FIN_SOP_Expense-Claims_V1_2026-09-01.docx';
const FILES = [file(TEAM), file(LEAD), file(CEO), file(DOCX)];

function setup() {
  const linked = [];
  const box = {
    listAll: async () => FILES,
    temporaryLink: async path => { linked.push(path); return `https://dl.dropboxusercontent.example/${linked.length}`; },
  };
  const lister = createLister(box, () => NOW);
  return { linked, link: createLinker(lister, box, () => NOW) };
}
const viewer = level => ({ name: `t-${level}`, level });
const name = path => path.split('/').pop();

test('gives a 4-hour link to a document at or below the caller level', async () => {
  const { linked, link } = setup();
  const result = await link({ file_name: name(LEAD) }, viewer('leader'));
  assert.equal(linked[0], LEAD);
  assert.equal(result.link, 'https://dl.dropboxusercontent.example/1');
  assert.equal(result.title, 'Soil Food Web');
  assert.equal(result.level, 'Leadership');
  assert.equal(result.expires_at, '2026-11-19T10:00:00.000Z');
  assert.match(result.opens, /browser/);
  const word = await link({ file_name: name(DOCX) }, viewer('employee'));
  assert.match(word.opens, /Downloads/);
});

test('documents above the caller level look exactly like missing ones, and no link is made', async () => {
  const { linked, link } = setup();
  const above = await link({ file_name: name(LEAD) }, viewer('employee')).catch(error => error.message);
  const missing = await link({ file_name: 'HR_POLICY_Nothing_V1_2026-01-01.pdf' }, viewer('employee')).catch(error => error.message);
  assert.equal(above, missing);
  assert.match(above, /not|No document/);
  await assert.rejects(link({ file_name: name(CEO) }, viewer('leader')), /No document/);
  // A full path pointing above the caller's level is refused too.
  await assert.rejects(link({ file_name: `/Apps/KMS-Documents (1)${CEO}` }, viewer('leader')), /No document/);
  await assert.rejects(link({}, viewer('leader')));
  await assert.rejects(link({ file_name: name(TEAM) }, undefined), /signed-in/);
  assert.equal(linked.length, 0);
});

test('accepts any letter case and a full path from search results', async () => {
  const { linked, link } = setup();
  await link({ file_name: name(TEAM).toLowerCase() }, viewer('employee'));
  await link({ file_name: `/Apps/KMS-Documents (1)${TEAM}` }, viewer('oceo'));
  assert.deepEqual(linked, [TEAM, TEAM]);
});

test('over MCP: tool listed with Dropbox on, calls get_temporary_link with the app-folder path', async () => {
  const token = 'z'.repeat(40);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: options.body });
    if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'a', expires_in: 14400 });
    if (url.endsWith('/files/list_folder')) {
      return Response.json({ has_more: false, entries: FILES.map(f => ({ '.tag': 'file', name: f.name, path_display: f.path, size: 1, server_modified: f.added })) });
    }
    if (url.endsWith('/files/get_temporary_link')) return Response.json({ link: 'https://dl.dropboxusercontent.example/abc', metadata: {} });
    return new Response('unexpected', { status: 500 });
  };
  const app = createApp({ base: 'https://w.example', workspace: 't', token: 't', timeoutMs: 1000 }, {
    auth: readAuthConfig({ MCP_USERS: `seshu:employee:${token}` }), fetchImpl, now: () => NOW,
    dropbox: { enabled: true, appKey: 'k', appSecret: 's', refreshToken: 'r', timeoutMs: 1000 },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const tools = (await client.listTools()).tools.map(tool => tool.name).sort();
    assert.deepEqual(tools, ['get_document_link', 'list_documents', 'search_knowledge']);
    const ok = await client.callTool({ name: 'get_document_link', arguments: { file_name: name(TEAM) } });
    assert.equal(ok.structuredContent.link, 'https://dl.dropboxusercontent.example/abc');
    const refused = await client.callTool({ name: 'get_document_link', arguments: { file_name: name(LEAD) } });
    assert.equal(refused.isError, true);
    await client.close();
    const linkCalls = calls.filter(call => call.url.endsWith('/files/get_temporary_link'));
    assert.equal(linkCalls.length, 1);
    assert.deepEqual(JSON.parse(linkCalls[0].body), { path: TEAM });
  } finally { server.close(); }
});

test('Dropbox problems give plain messages', async () => {
  const lister = createLister({ listAll: async () => FILES }, () => NOW);
  const { createDropbox } = await import('../src/dropbox.mjs');
  const box = createDropbox({ appKey: 'k', appSecret: 's', refreshToken: 'r', timeoutMs: 1000 }, async url => {
    if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'a', expires_in: 14400 });
    return Response.json({ error_summary: 'path/not_found/..' }, { status: 409 });
  }, () => NOW);
  await assert.rejects(createLinker(lister, box, () => NOW)({ file_name: name(TEAM) }, viewer('employee')), /no longer in Dropbox/);
});
