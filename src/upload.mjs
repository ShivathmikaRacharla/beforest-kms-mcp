import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { LEVELS } from './auth.mjs';
import { ROOT } from './kms-folders.mjs';
import { FOLDER_BY_LEVEL, departmentList, matchDepartment } from './departments.mjs';

// Upload flow in Claude:
// 1. list_departments -> Claude asks the person to pick one (never guesses).
// 2. upload_document(department) -> a private upload page link, locked to the person's own level and that department.
// 3. The person picks the file on the page. We check it, save it in Dropbox <Level>/<Department>/ (never overwrite)
//    and start the existing indexing pipeline with the Dropbox file id.
// Claude cannot pass a file to a tool, which is why the file goes through the page.

export const FILE_TYPES = ['pdf', 'docx', 'pptx', 'xlsx', 'csv', 'txt', 'md'];
const LINK_MS = 4 * 60 * 60 * 1000;
const VISIBLE_TO = { employee: 'everyone at Beforest', leader: 'leaders and the Office of the CEO', oceo: 'the Office of the CEO only' };

export class UploadError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const uploadShape = {
  department: z.string().trim().min(1).max(80).describe('The department the person chose from list_departments, e.g. "HR" or "Finance & Accounts". Ask them; never pick it yourself.'),
};
const uploadSchema = z.object(uploadShape).strict();

export function readUploadConfig(env = process.env) {
  const maxMb = Number(env.UPLOAD_MAX_MB || 150);
  // 150 MB is the most Dropbox accepts in one upload call.
  if (!Number.isInteger(maxMb) || maxMb < 1 || maxMb > 150) throw new Error('UPLOAD_MAX_MB must be a whole number from 1 to 150.');
  return { maxBytes: maxMb * 1024 * 1024 };
}

// Signing key for upload links, derived from the Dropbox app secret (different label from document links).
export const uploadKey = dropbox => createHash('sha256').update(`kms-upload-links:${dropbox.appSecret}`).digest();

// The person's own level folder, e.g. "Leadership". Uploads never go to another level.
export function levelFolderFor(caller) {
  if (!LEVELS.includes(caller?.level)) throw new UploadError(401, 'Uploading needs a signed-in user.');
  return FOLDER_BY_LEVEL[caller.level];
}

export function departmentsFor(caller) {
  const levelFolder = levelFolderFor(caller);
  return {
    level: levelFolder,
    visible_to: VISIBLE_TO[caller.level],
    departments: departmentList(),
    how_to_ask: `Show these departments and ask the person which one the document belongs to. Do not choose for them. It will be added to ${levelFolder} / <department>; the level comes from their key and cannot be changed.`,
  };
}

// Keeps the person's own file name, minus characters Dropbox does not allow.
export function safeFileName(original) {
  const base = String(original || '').split(/[\\/]/).pop().normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  if (!base || !/\.[A-Za-z0-9]+$/.test(base)) throw new UploadError(400, 'The file needs a name with an extension, e.g. report.pdf.');
  if (base.length <= 180) return base;
  const dot = base.lastIndexOf('.');
  return base.slice(0, 180 - (base.length - dot)).trim() + base.slice(dot);
}

// Dropbox's content hash: SHA-256 of each 4 MB block, then SHA-256 of those hashes joined.
// Same as the email intake uses, so the same file is refused by both.
export function dropboxContentHash(bytes) {
  const blocks = [];
  for (let i = 0; i < bytes.length; i += 4194304) blocks.push(createHash('sha256').update(bytes.subarray(i, i + 4194304)).digest());
  return createHash('sha256').update(Buffer.concat(blocks)).digest('hex');
}

// "Plan.pdf" -> "Plan (2).pdf"
const numbered = (name, n) => (n === 1 ? name : name.replace(/(\.[^.]+)$/, ` (${n})$1`));

// Checks the real bytes, not just the name.
export function checkFile(name, bytes, maxBytes) {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (!FILE_TYPES.includes(extension)) throw new UploadError(415, `Only ${FILE_TYPES.map(type => type.toUpperCase()).join(', ')} files can be added.`);
  if (!bytes?.length) throw new UploadError(400, 'The file is empty.');
  if (bytes.length > maxBytes) throw new UploadError(413, `The file is larger than ${Math.round(maxBytes / 1048576)} MB.`);
  const zip = bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const ok = {
    pdf: () => bytes.subarray(0, 5).toString('latin1') === '%PDF-',
    docx: () => zip && bytes.includes('word/'),
    pptx: () => zip && bytes.includes('ppt/'),
    xlsx: () => zip && bytes.includes('xl/'),
    csv: () => isText(bytes),
    txt: () => isText(bytes),
    md: () => isText(bytes),
  }[extension]();
  if (!ok) throw new UploadError(415, `This file does not look like a real .${extension} file.`);
  return extension;
}
function isText(bytes) {
  if (bytes.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; } catch { return false; }
}

export function createUploader(config, { key, dropbox, startProcess, auth, now = Date.now }) {
  const sign = body => createHmac('sha256', key).update(body).digest('base64url');
  // Links already used or uploading right now. A restart forgets them, but links still expire and never overwrite.
  const used = new Map();
  const sweep = () => { for (const [nonce, until] of used) if (until <= now()) used.delete(nonce); };

  // upload_document: checks the department and returns the private upload page link.
  function make(rawInput, caller, baseUrl) {
    const levelFolder = levelFolderFor(caller);
    const input = uploadSchema.parse(rawInput ?? {});
    const match = matchDepartment(input.department);
    if (!match.department) {
      const options = match.choices.length ? match.choices : departmentList().map(d => d.name);
      throw new UploadError(400, `"${input.department}" is not clearly one department. Ask the person to choose one of: ${options.join(', ')}.`);
    }
    const payload = { v: 1, l: caller.level, s: match.department, k: caller.name, n: randomBytes(12).toString('base64url'), e: Math.floor((now() + LINK_MS) / 1000) };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    console.log(JSON.stringify({ event: 'upload_link', user: caller.name, level: caller.level, department: match.department }));
    return {
      // The token sits after "#", so it never reaches proxy or server access logs.
      upload_link: `${baseUrl}/upload#${body}.${sign(body)}`,
      level: levelFolder,
      department: match.department,
      dropbox_destination: `${ROOT}/${levelFolder}/${match.department}/`,
      visible_to: VISIBLE_TO[caller.level],
      file_types: FILE_TYPES,
      max_mb: Math.round(config.maxBytes / 1048576),
      expires_at: new Date(payload.e * 1000).toISOString(),
      how_to_show: `Tell the person: open the link, choose the file and press Upload. It will be added to ${levelFolder} / ${match.department}. The page shows the result. The link works once and stops after 4 hours; do not share it.`,
    };
  }

  function read(token) {
    const invalid = new UploadError(403, 'This upload link is not valid. Ask Claude for a new one.');
    if (typeof token !== 'string' || token.length > 2000) throw invalid;
    const [body, mac, ...rest] = token.split('.');
    if (!body || !mac || rest.length) throw invalid;
    const expected = Buffer.from(sign(body));
    const given = Buffer.from(mac);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid;
    let payload;
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw invalid; }
    if (payload?.v !== 1 || !LEVELS.includes(payload.l) || !departmentList().some(d => d.name === payload.s)) throw invalid;
    if (payload.e * 1000 <= now()) throw new UploadError(410, 'This upload link has expired. Ask Claude for a new one.');
    return payload;
  }

  // The person must still have a key at exactly the same level; a changed level means a new link.
  function owner(payload) {
    if (!auth.enabled) return { name: 'local', level: payload.l };
    const user = auth.users.find(candidate => candidate.name === payload.k && candidate.level === payload.l);
    if (!user) throw new UploadError(403, 'This upload link is no longer valid. Ask Claude for a new one.');
    return { name: user.name, level: user.level };
  }

  // Everything that can be checked before the file arrives.
  function admit(token) {
    const payload = read(token);
    const caller = owner(payload);
    sweep();
    if (used.has(payload.n)) throw new UploadError(409, 'This upload link was already used. Ask Claude for a new one to add another file.');
    return { payload, caller };
  }

  function check(token) {
    const { payload } = admit(token);
    const levelFolder = FOLDER_BY_LEVEL[payload.l];
    return {
      folder: `${levelFolder} / ${payload.s}`, visible_to: VISIBLE_TO[payload.l],
      expires_at: new Date(payload.e * 1000).toISOString(), file_types: FILE_TYPES, max_bytes: config.maxBytes,
    };
  }

  async function upload(token, originalName, bytes) {
    const { payload, caller } = admit(token);
    const name = safeFileName(originalName);
    checkFile(name, bytes, config.maxBytes);
    used.set(payload.n, payload.e * 1000);
    const levelFolder = FOLDER_BY_LEVEL[payload.l];
    const folder = `/${levelFolder}/${payload.s}`;
    let saved;
    try {
      // The same file (same bytes, any name) already in this folder is not added again, like the email intake.
      const same = await dropbox.findSameContent(folder, dropboxContentHash(bytes));
      if (same) throw new UploadError(409, `Not added: this file is already in the KMS as "${same.name}" (${levelFolder} / ${payload.s}).`);
      // Never overwrite: if the name is taken, use "name (2).ext", "name (3).ext", ...
      for (let n = 1; n <= 20 && !saved; n++) {
        const fileName = numbered(name, n);
        const result = await dropbox.upload(`${folder}/${fileName}`, bytes);
        if (result) saved = { ...result, fileName };
      }
      if (!saved) throw new UploadError(409, 'A file with this name already exists many times. Please rename the file and try again.');
    } catch (error) {
      used.delete(payload.n);
      throw error;
    }
    const destination = `${ROOT}${folder}/${saved.fileName}`;
    const done = {
      saved: true, file_name: saved.fileName, level: levelFolder, department: payload.s,
      dropbox_destination: destination, visible_to: VISIBLE_TO[payload.l], size_bytes: bytes.length,
    };
    const log = { event: 'upload', user: caller.name, level: caller.level, department: payload.s, file_name: saved.fileName, size_bytes: bytes.length };
    try {
      const started = await startProcess({
        dropbox_path: destination, dropbox_file_id: saved.id, dropbox_revision: saved.rev,
        file_name: saved.fileName, file_size_bytes: bytes.length,
      });
      console.log(JSON.stringify({ ...log, indexing: 'started', job_id: started.job_id }));
      return { ...done, indexing: 'started', job_id: started.job_id, searchable_in: 'about 2-5 minutes' };
    } catch (error) {
      // The file is safely in Dropbox; only the start failed. The KMS team can start it again by file id.
      console.log(JSON.stringify({ ...log, indexing: 'not_started', error: error.message, dropbox_file_id: saved.id }));
      return { ...done, indexing: 'not_started', message: 'The file is saved, but indexing did not start. Please tell the KMS team.' };
    }
  }

  return { make, check, admit, upload };
}
