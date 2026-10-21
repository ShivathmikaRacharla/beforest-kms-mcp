import { z } from 'zod';

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

export function createSearch(config, fetchImpl = fetch) {
  return async (rawInput) => {
    const input = inputSchema.parse(rawInput);
    let response;
    try {
      response = await fetchImpl(`${config.base}/api/w/${encodeURIComponent(config.workspace)}/jobs/run_wait_result/p/f/kms/retrieve_qdrant_chunks`, {
        method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input), signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      if (['TimeoutError', 'AbortError'].includes(error.name)) throw new Error('Knowledge search timed out. Please try again.');
      throw new Error('Knowledge search is unavailable. Please try again later.');
    }
    if (!response.ok) throw new Error(`Knowledge search failed (HTTP ${response.status}).`);
    let data;
    try { data = resultSchema.parse(await response.json()); }
    catch { throw new Error('Knowledge search returned an unexpected response.'); }
    return {
      question: input.question, department: input.department ?? null,
      retrieved: data.retrieved, document_count: data.document_count ?? null,
      matches: data.matches.map((match) => ({
        text: match.text, score: match.score ?? null, file_name: match.file_name ?? null,
        dropbox_path: match.dropbox_path ?? null, page_number: match.page_number ?? null, section: match.section ?? null,
      })),
    };
  };
}
