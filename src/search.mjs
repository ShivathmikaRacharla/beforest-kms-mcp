import { z } from 'zod';
import { LEVELS } from './auth.mjs';

export const inputShape = {
  question: z.string().trim().min(1).max(8000).describe('Question to search for in the Beforest knowledge base.'),
  department: z.string().trim().min(1).max(200).optional().describe('Optional exact department filter; this is not an access-control boundary.'),
  limit: z.number().int().min(1).max(20).default(5),
};
const inputSchema = z.object(inputShape).strict();
const matchSchema = z.object({
  text: z.string(), score: z.number().finite().optional(),
  file_name: z.string().nullable().optional(), dropbox_path: z.string().nullable().optional(),
  page_number: z.union([z.string(), z.number()]).nullable().optional(),
  section: z.string().nullable().optional(),
  min_role: z.string().nullable().optional(),
});
const resultSchema = z.object({
  retrieved: z.boolean(), matches: z.array(matchSchema),
  document_count: z.number().int().nonnegative().optional(),
});

export function readConfig(env = process.env) {
  const base = env.WINDMILL_BASE_URL?.trim();
  const workspace = env.WINDMILL_WORKSPACE?.trim();
  const token = env.WINDMILL_TOKEN?.trim();
  if (!base || !workspace || !token) throw new Error('Set WINDMILL_BASE_URL, WINDMILL_WORKSPACE and WINDMILL_TOKEN.');
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid Windmill base URL.');
  const timeoutMs = Number(env.WINDMILL_TIMEOUT_MS || 30000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new Error('Invalid Windmill timeout.');
  return { base: base.replace(/\/+$/, ''), workspace, token, timeoutMs };
}

// Dropbox level folders (any depth) -> level. Folder names are matched case-insensitively.
const FOLDER_LEVELS = { 'office of the ceo': 'oceo', leadership: 'leader', confidential: 'leader', team: 'employee' };

// A passage's level is the stricter of its stored min_role and its Dropbox folder.
// Anything without a recognised level is treated as oceo, so new or misfiled documents start closed.
export function passageLevel(match) {
  const folder = (match.dropbox_path || '').split('/').map(part => FOLDER_LEVELS[part.trim().toLowerCase()]).find(Boolean);
  const stored = LEVELS.includes(match.min_role) ? match.min_role : undefined;
  if (!folder && !stored) return 'oceo';
  return LEVELS[Math.max(LEVELS.indexOf(folder ?? 'employee'), LEVELS.indexOf(stored ?? 'employee'))];
}

export function createSearch(config, fetchImpl = fetch) {
  return async (rawInput, viewer) => {
    if (!LEVELS.includes(viewer?.level)) throw new Error('Knowledge search needs a signed-in user.');
    const input = inputSchema.parse(rawInput);
    const full = viewer.level === 'oceo';
    // Ask for more than needed when some passages may be filtered out below.
    const upstream = full ? input : { ...input, limit: Math.min(20, input.limit * 4) };
    let response;
    try {
      response = await fetchImpl(`${config.base}/api/w/${encodeURIComponent(config.workspace)}/jobs/run_wait_result/p/f/kms/retrieve_qdrant_chunks`, {
        method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(upstream), signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      if (['TimeoutError', 'AbortError'].includes(error.name)) throw new Error('Knowledge search timed out. Please try again.');
      throw new Error('Knowledge search is unavailable. Please try again later.');
    }
    if (!response.ok) throw new Error(`Knowledge search failed (HTTP ${response.status}).`);
    let data;
    try { data = resultSchema.parse(await response.json()); }
    catch { throw new Error('Knowledge search returned an unexpected response.'); }
    const allowed = data.matches.filter(match => LEVELS.indexOf(passageLevel(match)) <= LEVELS.indexOf(viewer.level));
    console.log(JSON.stringify({ event: 'search', user: viewer.name, level: viewer.level, returned: Math.min(allowed.length, input.limit), hidden: data.matches.length - allowed.length }));
    return {
      question: input.question, department: input.department ?? null,
      // Total document count is only shown to full access; it says how much exists beyond a person's level.
      retrieved: data.retrieved, document_count: full ? data.document_count ?? null : null,
      matches: allowed.slice(0, input.limit).map((match) => ({
        text: match.text, score: match.score ?? null, file_name: match.file_name ?? null,
        dropbox_path: match.dropbox_path ?? null, page_number: match.page_number ?? null, section: match.section ?? null,
      })),
    };
  };
}
