import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readAuthConfig } from '../src/auth.mjs';
import { createApp } from '../src/server.mjs';
import { createLister, describeFile } from '../src/list.mjs';

const NOW = Date.parse('2026-11-18T06:00:00Z');
const file = (path, added = '2026-11-01T10:00:00Z') => ({ path, name: path.split('/').pop(), size: 1000, added });
const FILES = [
  file('/Team/HR/HR_POLICY_Leave-and-Attendance_V1_2026-08-11.pdf'),
  file('/Team/HR/HR_POLICY_Leave-and-Attendance_V2_2026-10-01.pdf'),
  file('/Team/Finance & Accounts/FIN_SOP_Expense-Claims_V1_2026-09-01.docx'),
  file('/Team/Bewild/old notes.pdf'),
  file('/Leadership/Collective Design & Support/CDS_GUIDE_Soil-Food-Web_V1_2026-11-12.pdf'),
  file('/Leadership/Finance & Accounts/FIN_PLAN_Budget-2027_V1_2026-11-17.pdf', '2026-11-18T05:58:00Z'),
  file('/Office of the CEO/Legal & Liasoning/LEGAL_REPORT_Board-Minutes_V1_2026-11-01.pdf'),
  file('/Unsorted/mystery.pdf'),
  file('/Team/HR/.DS_Store'),
];
const fakeDropbox = (files = FILES) => {
  const box = { calls: 0, listAll: async () => { box.calls++; return files; } };
  return box;
};
const viewer = level => ({ name: `t-${level}`, level });
const names = result => result.documents.map(doc => doc.file_name);

test('a file gets its level from its folder (same rule as search) and its details from its name', () => {
  assert.deepEqual(describeFile(FILES[4]), {
    level: 'leader',
    entry: { title: 'Soil Food Web', space: 'Collective Design & Support', level: 'Leadership', type: 'GUIDE', version: 1, date: '2026-11-12', file_name: 'CDS_GUIDE_Soil-Food-Web_V1_2026-11-12.pdf', added: '2026-11-01T10:00:00Z' },
  });
  assert.equal(describeFile(FILES[3]).entry.title, 'old notes');
  assert.equal(describeFile(FILES[7]).level, 'oceo');
});

test('each level gets the exact count of what it may see, and nothing above it', async () => {
  const lister = createLister(fakeDropbox(), () => NOW);
  const team = await lister.list({}, viewer('employee'));
  assert.equal(team.total, 4);
  assert.equal(team.shows, 'Team documents');
  assert.deepEqual(team.by_space, [{ space: 'Bewild', count: 1 }, { space: 'Finance & Accounts', count: 1 }, { space: 'HR', count: 2 }]);
  const text = JSON.stringify(team);
  for (const hidden of ['Soil', 'Budget', 'Board', 'mystery', 'Leadership', 'Office of the CEO']) assert.ok(!text.includes(hidden), hidden);

  const leader = await lister.list({}, viewer('leader'));
  assert.equal(leader.total, 6);
  assert.ok(names(leader).includes('CDS_GUIDE_Soil-Food-Web_V1_2026-11-12.pdf'));
  assert.ok(!JSON.stringify(leader).includes('Board'));

  const oceo = await lister.list({}, viewer('oceo'));
  assert.equal(oceo.total, 8);
  assert.ok(names(oceo).includes('mystery.pdf'));
});

test('space filter, newest version first, just-added marker', async () => {
  const lister = createLister(fakeDropbox(), () => NOW);
  const hr = await lister.list({ space: 'HR' }, viewer('employee'));
  assert.deepEqual(names(hr), ['HR_POLICY_Leave-and-Attendance_V2_2026-10-01.pdf', 'HR_POLICY_Leave-and-Attendance_V1_2026-08-11.pdf']);
  const fin = await lister.list({ space: 'Finance & Accounts' }, viewer('leader'));
  assert.deepEqual(fin.documents.map(doc => [doc.title, doc.just_added]), [['Budget 2027', true], ['Expense Claims', false]]);
  await assert.rejects(lister.list({ space: 'Marketing' }, viewer('leader')));
  await assert.rejects(lister.list({ level: 'oceo' }, viewer('employee')));
  await assert.rejects(lister.list({}, undefined), /signed-in/);
});

test('Dropbox is read at most once per 5 minutes unless an upload refreshes it', async () => {
  let clock = NOW;
  const box = fakeDropbox();
  const lister = createLister(box, () => clock);
  await lister.list({}, viewer('leader'));
  await lister.list({}, viewer('employee'));
  assert.equal(box.calls, 1);
  clock += 6 * 60 * 1000;
  await lister.list({}, viewer('leader'));
  assert.equal(box.calls, 2);
  lister.refresh();
  await lister.list({}, viewer('leader'));
  assert.equal(box.calls, 3);
});

test('over MCP: list_documents uses the key level and reads Dropbox recursively', async () => {
  const token = 'q'.repeat(40);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: options.body });
    if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'a', expires_in: 14400 });
    if (url.endsWith('/files/list_folder')) {
      return Response.json({ has_more: true, cursor: 'c1', entries: [{ '.tag': 'folder', name: 'Team', path_display: '/Team' }, { '.tag': 'file', name: FILES[0].name, path_display: FILES[0].path, size: 1, server_modified: '2026-11-01T10:00:00Z' }] });
    }
    if (url.endsWith('/files/list_folder/continue')) {
      return Response.json({ has_more: false, entries: [{ '.tag': 'file', name: FILES[4].name, path_display: FILES[4].path, size: 1, server_modified: '2026-11-01T10:00:00Z' }] });
    }
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
    const result = await client.callTool({ name: 'list_documents', arguments: {} });
    await client.close();
    assert.equal(result.structuredContent.total, 1);
    assert.deepEqual(result.structuredContent.documents.map(doc => doc.file_name), [FILES[0].name]);
    assert.deepEqual(JSON.parse(calls.find(call => call.url.endsWith('/files/list_folder')).body), { path: '', recursive: true, limit: 2000 });
  } finally { server.close(); }
});
