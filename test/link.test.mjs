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
const PDF = '%PDF-1.7 test file';
const KEY = Buffer.alloc(32, 7);
const viewer = level => ({ name: `t-${level}`, level });
const name = path => path.split('/').pop();
const lister = () => createLister({ listAll: async () => FILES }, () => NOW);

test('makes a view link for PDFs and a download link for every file', async () => {
  const linker = createLinker(lister(), KEY, () => NOW);
  const pdf = await linker.make({ file_name: name(LEAD) }, viewer('leader'), 'https://kms.example');
  assert.match(pdf.view_link, /^https:\/\/kms\.example\/doc\/[\w-]+\.[\w-]+$/);
  assert.equal(pdf.download_link, `${pdf.view_link}?download=1`);
  assert.equal(pdf.title, 'Soil Food Web');
  assert.equal(pdf.expires_at, '2026-11-19T10:00:00.000Z');
  const word = await linker.make({ file_name: name(DOCX) }, viewer('employee'), 'https://kms.example');
  assert.equal(word.view_link, null);
  assert.match(word.download_link, /\?download=1$/);
  assert.match(word.how_to_show, /"Download" link only/);
});

test('documents above the caller level look exactly like missing ones', async () => {
  const linker = createLinker(lister(), KEY, () => NOW);
  const make = (input, level) => linker.make(input, viewer(level), 'https://kms.example').catch(error => error.message);
  assert.equal(await make({ file_name: name(LEAD) }, 'employee'), await make({ file_name: 'HR_POLICY_Nothing_V1_2026-01-01.pdf' }, 'employee'));
  assert.match(await make({ file_name: name(CEO) }, 'leader'), /No document/);
  assert.match(await make({ file_name: `/Apps/KMS-Documents (1)${CEO}` }, 'leader'), /No document/);
  assert.match(await make({ file_name: name(TEAM) }, undefined), /signed-in/);
});

test('links are checked when opened: signature, expiry and the person still allowed', async () => {
  let clock = NOW;
  const linker = createLinker(lister(), KEY, () => clock);
  const auth = readAuthConfig({ MCP_USERS: `t-leader:leader:${'a'.repeat(40)}` });
  const { view_link: link } = await linker.make({ file_name: name(LEAD) }, viewer('leader'), 'https://kms.example');
  const token = link.split('/doc/')[1];
  assert.deepEqual(linker.open(token, auth), { path: LEAD, user: 't-leader' });
  const [body, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ v: 1, p: CEO, u: 't-leader', e: 9999999999 })).toString('base64url');
  assert.throws(() => linker.open(`${forged}.${mac}`, auth), error => error.status === 404);
  assert.throws(() => createLinker(lister(), Buffer.alloc(32, 8), () => clock).open(token, auth), error => error.status === 404);
  assert.throws(() => linker.open(`${body}.${mac}`, readAuthConfig({ MCP_USERS: `other:oceo:${'b'.repeat(40)}` })), error => error.status === 403);
  assert.throws(() => linker.open(token, readAuthConfig({ MCP_USERS: `t-leader:employee:${'a'.repeat(40)}` })), error => error.status === 403);
  clock = NOW + 4 * 60 * 60 * 1000 + 1;
  assert.throws(() => linker.open(token, auth), error => error.status === 410);
});

test('over MCP and the browser: view opens inline, download saves, wrong level is refused', async () => {
  const token = 'z'.repeat(40);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'a', expires_in: 14400 });
    if (url.endsWith('/files/list_folder')) {
      return Response.json({ has_more: false, entries: FILES.map(f => ({ '.tag': 'file', name: f.name, path_display: f.path, size: 1, server_modified: f.added })) });
    }
    if (url.endsWith('/files/download')) return new Response(PDF, { status: 200, headers: { 'Content-Length': String(PDF.length) } });
    return new Response('unexpected', { status: 500 });
  };
  const app = createApp({ base: 'https://w.example', workspace: 't', token: 't', timeoutMs: 1000 }, {
    auth: readAuthConfig({ MCP_USERS: `seshu:employee:${token}` }), fetchImpl, now: () => NOW,
    dropbox: { enabled: true, appKey: 'k', appSecret: 's', refreshToken: 'r', timeoutMs: 1000 },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['get_document_link', 'list_documents', 'search_knowledge']);
    const ok = (await client.callTool({ name: 'get_document_link', arguments: { file_name: name(TEAM) } })).structuredContent;
    const refused = await client.callTool({ name: 'get_document_link', arguments: { file_name: name(LEAD) } });
    assert.equal(refused.isError, true);
    await client.close();
    assert.ok(ok.view_link.startsWith(`${base}/doc/`));

    const view = await fetch(ok.view_link);
    assert.equal(view.status, 200);
    assert.equal(view.headers.get('content-type'), 'application/pdf');
    assert.match(view.headers.get('content-disposition'), /^inline; filename="HR_POLICY_Leave-and-Attendance_V2_2026-10-01\.pdf"/);
    assert.equal(await view.text(), PDF);

    const download = await fetch(ok.download_link);
    assert.match(download.headers.get('content-disposition'), /^attachment;/);
    assert.equal(await download.text(), PDF);

    const dl = calls.find(call => call.url.endsWith('/files/download'));
    assert.deepEqual(JSON.parse(dl.options.headers['Dropbox-API-Arg']), { path: TEAM });

    const bad = await fetch(`${base}/doc/not-a-token`);
    assert.equal(bad.status, 404);
    assert.match(await bad.text(), /expired or is not valid/);
  } finally { server.close(); }
});

test('a file gone from Dropbox gives a plain message, not a crash', async () => {
  const app = createApp({ base: 'https://w.example', workspace: 't', token: 't', timeoutMs: 1000 }, {
    fetchImpl: async url => {
      if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'a', expires_in: 14400 });
      if (url.endsWith('/files/list_folder')) return Response.json({ has_more: false, entries: [{ '.tag': 'file', name: name(TEAM), path_display: TEAM, size: 1, server_modified: '2026-11-01T10:00:00Z' }] });
      return Response.json({ error_summary: 'path/not_found/..' }, { status: 409 });
    },
    now: () => NOW, dropbox: { enabled: true, appKey: 'k', appSecret: 's', refreshToken: 'r', timeoutMs: 1000 },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const ok = (await client.callTool({ name: 'get_document_link', arguments: { file_name: name(TEAM) } })).structuredContent;
    await client.close();
    const response = await fetch(ok.view_link);
    assert.equal(response.status, 502);
    assert.match(await response.text(), /no longer in Dropbox/);
  } finally { server.close(); }
});
