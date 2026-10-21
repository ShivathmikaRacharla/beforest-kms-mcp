import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readConfig } from '../src/search.mjs';
import { startServer } from '../src/server.mjs';

// Optional read-only import of existing credentials; never creates or edits .env.
let env = { ...process.env };
if (process.env.KMS_ENV_FILE) {
  const entries = readFileSync(resolve(process.env.KMS_ENV_FILE), 'utf8').split(/\r?\n/)
    .filter(line => line.trim() && !line.trim().startsWith('#') && line.includes('='))
    .map(line => { const i = line.indexOf('='); return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]; });
  env = { ...Object.fromEntries(entries), ...env };
}
const config = readConfig({
  ...env, WINDMILL_BASE_URL: env.WINDMILL_BASE_URL || env.BASE_URL,
  WINDMILL_WORKSPACE: env.WINDMILL_WORKSPACE || env.WM_WORKSPACE,
  WINDMILL_TOKEN: env.WINDMILL_TOKEN || env.WM_TOKEN,
});
const listener = await startServer(config, 0);
const client = new Client({ name: 'beforest-local-live-check', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${listener.address().port}/mcp`)));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name), ['search_knowledge']);
  const started = Date.now();
  const result = await client.callTool({ name: 'search_knowledge', arguments: { question: 'What is Beforest?', limit: 3 } });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  const data = result.structuredContent;
  assert.ok(data.matches.length > 0 && data.matches.length <= 3);
  assert.ok(data.matches.every(m => m.text && m.file_name && m.dropbox_path && typeof m.score === 'number'));
  console.log(JSON.stringify({ passed: true, tool: tools[0].name, duration_ms: Date.now() - started, document_count: data.document_count, matches: data.matches.length, all_have_text_and_sources: true, endpoint: 'loopback only', credentials_printed: false }, null, 2));
} finally { await client.close(); await new Promise(resolve => listener.close(resolve)); }
