import { z } from 'zod';
import { LEVELS } from './auth.mjs';

// After a document is saved in Dropbox, start the existing Windmill pipeline for it.
// The Dropbox -> Windmill handoff is unchanged: same flow, same body the email intake sent.
export const ROOT = '/Apps/KMS-Documents (1)';
export const LEVEL_FOLDERS = { 'Team': 'employee', 'Leadership': 'leader', 'Office of the CEO': 'oceo' };
export const SPACES = [
  'Bewild', 'Business Intelligence', 'Collective Design & Support', 'Collective Operations', 'Community Engagement',
  'Content & Storytelling', 'Finance & Accounts', 'HR', 'Legal & Liasoning', 'Regolith',
];
// Naming rule from the intake: [SPACE]_[TYPE]_[Title]_V[n]_[YYYY-MM-DD].[ext]
const FILE_NAME = /^[A-Z][A-Z0-9]*_[A-Z][A-Z0-9-]*_[A-Za-z0-9][A-Za-z0-9-]*_V[1-9]\d*_\d{4}-\d{2}-\d{2}\.(pdf|docx|txt|md)$/;
const FLOW = '/jobs/run/f/f/kms/process_approved_document_pipeline';

export const processShape = {
  dropbox_path: z.string().trim().min(1).max(500).describe(`Full Dropbox path of the saved file: "${ROOT}/<Level>/<Space>/<File name>".`),
  dropbox_file_id: z.string().trim().regex(/^id:[A-Za-z0-9_-]{6,}$/).describe('Dropbox file id from the upload response, e.g. "id:5YcLS9tLFfAAAAAAAAAAUA".'),
  dropbox_revision: z.string().trim().regex(/^[0-9a-f]{9,64}$/i).describe('Dropbox revision ("rev") from the upload response.'),
  uploaded_by: z.string().trim().min(1).max(100).describe('Name of the person who sent the document (for the upload log).'),
};
const processSchema = z.object(processShape).strict();

export function readProcessConfig(env = process.env) {
  const url = env.WINDMILL_WEBHOOK_URL?.trim();
  const token = env.WINDMILL_WEBHOOK_TOKEN?.trim();
  if (!url && !token) return { enabled: false };
  if (!url || !token) throw new Error('Set both WINDMILL_WEBHOOK_URL and WINDMILL_WEBHOOK_TOKEN, or neither.');
  const parsed = new URL(url);
  // Only the KMS pipeline flow can be started; anything else is a configuration mistake.
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.pathname.endsWith(FLOW)) {
    throw new Error('WINDMILL_WEBHOOK_URL must be the https run URL of f/kms/process_approved_document_pipeline.');
  }
  const timeoutMs = Number(env.WINDMILL_TIMEOUT_MS || 30000);
  return { enabled: true, url: parsed.href, token, timeoutMs };
}

// Splits and checks a path. Returns { level, space, fileName } or throws a message the bot can show.
export function parseDocumentPath(path) {
  if (!path.startsWith(`${ROOT}/`)) throw new Error(`The file must be inside "${ROOT}/".`);
  const parts = path.slice(ROOT.length + 1).split('/');
  if (parts.length !== 3 || parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error('The path must be <Level>/<Space>/<File name>.');
  }
  const [levelFolder, space, fileName] = parts;
  const level = LEVEL_FOLDERS[levelFolder];
  if (!level) throw new Error(`Level folder must be one of: ${Object.keys(LEVEL_FOLDERS).join(', ')}.`);
  if (!SPACES.includes(space)) throw new Error(`Space must be one of: ${SPACES.join(', ')}.`);
  if (!FILE_NAME.test(fileName)) {
    throw new Error('File name must follow [SPACE]_[TYPE]_[Title]_V[n]_[YYYY-MM-DD].pdf|docx|txt|md, e.g. HR_POLICY_Leave-and-Attendance_V1_2026-11-18.pdf.');
  }
  return { level, levelFolder, space, fileName };
}

const VISIBLE_TO = { employee: 'everyone', leader: 'leaders and the Office of the CEO', oceo: 'the Office of the CEO only' };

export function createProcess(config, fetchImpl = fetch) {
  return async (rawInput, caller) => {
    if (!LEVELS.includes(caller?.level)) throw new Error('Starting processing needs a signed-in user.');
    const input = processSchema.parse(rawInput);
    const doc = parseDocumentPath(input.dropbox_path);
    // A person can only add documents at or below their own level.
    if (LEVELS.indexOf(doc.level) > LEVELS.indexOf(caller.level)) {
      const allowed = Object.keys(LEVEL_FOLDERS).filter(folder => LEVELS.indexOf(LEVEL_FOLDERS[folder]) <= LEVELS.indexOf(caller.level));
      throw new Error(`This level is above yours. Choose ${allowed.join(' or ')}.`);
    }
    // Exactly the body the email intake sent (see the last successful pipeline run).
    const body = {
      event_type: 'approved_document_uploaded',
      dropbox_file_id: input.dropbox_file_id,
      dropbox_revision: input.dropbox_revision,
      dropbox_path: input.dropbox_path,
      approval_status: 'approved',
      file_name: doc.fileName,
    };
    let response;
    try {
      response = await fetchImpl(config.url, {
        method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      if (['TimeoutError', 'AbortError'].includes(error.name)) throw new Error('Starting processing timed out. Please try again.');
      throw new Error('Processing is unavailable. Please try again later.');
    }
    if (!response.ok) throw new Error(`Starting processing failed (HTTP ${response.status}).`);
    const jobId = (await response.text()).trim().replace(/^"|"$/g, '');
    console.log(JSON.stringify({ event: 'process', key: caller.name, key_level: caller.level, uploaded_by: input.uploaded_by, level: doc.level, space: doc.space, file_name: doc.fileName, job_id: jobId }));
    return {
      started: true, job_id: jobId || null, file_name: doc.fileName,
      folder: `${doc.levelFolder} / ${doc.space}`, visible_to: VISIBLE_TO[doc.level],
      searchable_in: 'about 1-2 minutes',
    };
  };
}
