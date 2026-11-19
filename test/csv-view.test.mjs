import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/server.mjs';
import { decodeCsv, parseCsv, renderCsvPage } from '../src/csv-view.mjs';

const NOW = Date.parse('2026-11-19T06:00:00Z');
const CSV = '/Team/Community Engagement/Prospect List - Bhopal Collective.csv';

test('CSV parsing: quotes, commas and line breaks inside cells, other delimiters, encodings', () => {
  const { rows, total } = parseCsv('Name,City,Note\r\n"Rao, Asha",Bhopal,"line one\nline two"\r\nRavi,Mumbai,"said ""hi"""\r\n\r\n');
  assert.equal(total, 3);
  assert.deepEqual(rows[1], ['Rao, Asha', 'Bhopal', 'line one\nline two']);
  assert.deepEqual(rows[2], ['Ravi', 'Mumbai', 'said "hi"']);
  assert.deepEqual(parseCsv('a;b\n1;2').rows, [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2').rows[1], ['1', '2']);
  assert.equal(decodeCsv(Buffer.from('﻿Name\nÀsha', 'utf8')), 'Name\nÀsha');
  assert.equal(decodeCsv(Buffer.from([0x4e, 0x0a, 0xc9, 0x6c, 0x61])), 'N\nÉla');
});

test('CSV page: cells are escaped and large files show the first rows with a note', () => {
  const page = renderCsvPage('list.csv', parseCsv('Name,Note\n<script>alert(1)</script>,"a & b"'));
  assert.ok(!page.includes('<script>alert'));
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(page, /a &amp; b/);
  const big = 'n\n' + Array.from({ length: 6000 }, (_, i) => i).join('\n');
  assert.match(renderCsvPage('big.csv', parseCsv(big)), /Showing the first 5,000 of 6,000 rows/);
});

test('over MCP and the browser: a CSV gets View (table page, sandboxed) and Download (original)', async () => {
  const body = 'Name,Phone\nAsha,98450 00000\n';
  const app = createApp({ base: 'https://w.example', workspace: 't', token: 't', timeoutMs: 1000 }, {
    fetchImpl: async url => {
      if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'a', expires_in: 14400 });
      if (url.endsWith('/files/list_folder')) return Response.json({ has_more: false, entries: [{ '.tag': 'file', name: CSV.split('/').pop(), path_display: CSV, size: 1, server_modified: '2026-11-01T10:00:00Z' }] });
      if (url.endsWith('/files/download')) return new Response(body, { status: 200 });
      return new Response('unexpected', { status: 500 });
    },
    now: () => NOW, dropbox: { enabled: true, appKey: 'k', appSecret: 's', refreshToken: 'r', timeoutMs: 1000 },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
    const link = (await client.callTool({ name: 'get_document_link', arguments: { file_name: CSV.split('/').pop() } })).structuredContent;
    await client.close();
    assert.ok(link.view_link);
    assert.match(link.how_to_show, /Show both links/);
    const view = await fetch(link.view_link);
    assert.equal(view.status, 200);
    assert.match(view.headers.get('content-type'), /^text\/html/);
    assert.match(view.headers.get('content-security-policy'), /^sandbox;/);
    assert.match(view.headers.get('content-disposition'), /^inline;/);
    const html = await view.text();
    assert.match(html, /<th>Name<\/th><th>Phone<\/th>/);
    assert.match(html, /<td>Asha<\/td><td>98450 00000<\/td>/);
    const download = await fetch(link.download_link);
    assert.match(download.headers.get('content-disposition'), /^attachment; filename="Prospect List - Bhopal Collective\.csv"/);
    assert.match(download.headers.get('content-type'), /^text\/csv/);
    assert.equal(await download.text(), body);
  } finally { server.close(); }
});
