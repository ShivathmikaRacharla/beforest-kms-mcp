import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { LEVELS } from './auth.mjs';
import { ROOT } from './kms-folders.mjs';
import { passageLevel } from './search.mjs';

// View and download links for one original document, only if the caller's level allows it.
// Links point at this server (/doc/<token>), which reads the file from Dropbox (read-only):
// "view" shows it in the browser, "download" saves the original. Each link is signed and lasts 4 hours.
const LINK_MS = 4 * 60 * 60 * 1000;
// Types a browser can show safely. Everything else is always sent as a download.
const VIEWABLE = { pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
// Office types Dropbox can preview (files/get_preview): PDF for documents and slides, HTML for spreadsheets.
const PREVIEW = new Set(['doc', 'docx', 'docm', 'rtf', 'odt', 'ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'ppsm', 'odp', 'xls', 'xlsx', 'xlsm', 'ods']);
const DOWNLOAD_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export const linkShape = {
  file_name: z.string().trim().min(1).max(500).describe('Exact file name from list_documents or a search result, e.g. "HR_POLICY_Leave-and-Attendance_V2_2026-10-01.pdf". A full Dropbox path from a search result also works.'),
};
const linkSchema = z.object(linkShape).strict();

// Same message whether the file does not exist or is above the caller's level, so nothing leaks.
const NOT_AVAILABLE = 'No document with that name is available to you. Use list_documents to find the exact file name.';
const EXPIRED = 'This link has expired or is not valid. Ask Claude for a new link to the document.';

const extensionOf = name => name.split('.').pop().toLowerCase();
const canView = name => Boolean(VIEWABLE[extensionOf(name)]) || PREVIEW.has(extensionOf(name));

// The signing key is derived from the Dropbox app secret, so no extra setting is needed and links
// survive restarts. Changing that secret invalidates every open link.
export const linkKey = dropbox => createHash('sha256').update(`kms-document-links:${dropbox.appSecret}`).digest();

export function createLinker(lister, key, now = Date.now) {
  const sign = body => createHmac('sha256', key).update(body).digest('base64url');

  async function make(rawInput, viewer, baseUrl) {
    const input = linkSchema.parse(rawInput ?? {});
    // Accept a bare name or a full path ("/Apps/KMS-Documents (1)/Team/HR/<name>"); match on the name.
    const wanted = input.file_name.replace(/^.*\//, '').toLowerCase();
    const wantedPath = input.file_name.startsWith(`${ROOT}/`) ? input.file_name.slice(ROOT.length).toLowerCase() : null;
    const matches = (await lister.visibleFiles(viewer)).filter(({ entry }) => entry.file_name.toLowerCase() === wanted);
    const chosen = matches.find(({ path }) => path.toLowerCase() === wantedPath)
      // The same name in two folders is rare; take the most recently added copy.
      ?? matches.sort((a, b) => String(b.entry.added).localeCompare(String(a.entry.added)))[0];
    if (!chosen) throw new Error(NOT_AVAILABLE);
    const { entry } = chosen;
    const expires = now() + LINK_MS;
    const body = Buffer.from(JSON.stringify({ v: 1, p: chosen.path, u: viewer.name, e: Math.floor(expires / 1000) })).toString('base64url');
    const url = `${baseUrl}/doc/${body}.${sign(body)}`;
    const viewable = canView(entry.file_name);
    console.log(JSON.stringify({ event: 'link', user: viewer.name, level: viewer.level, file_name: entry.file_name, space: entry.space, doc_level: entry.level }));
    return {
      file_name: entry.file_name, title: entry.title, space: entry.space, level: entry.level,
      version: entry.version, date: entry.date,
      view_link: viewable ? url : null,
      download_link: `${url}?download=1`,
      expires_at: new Date(expires).toISOString(),
      how_to_show: viewable
        ? 'Show both links: "View" opens the document in the browser, "Download" saves the original file.'
        : 'This file type cannot be shown in a browser. Show the "Download" link only.',
      note: 'Give these links only to the person who asked. They stop working after 4 hours.',
    };
  }

  // Checks a link from the browser. The person who asked must still have a key that allows the document.
  function open(token, auth) {
    if (typeof token !== 'string' || token.length > 3000) throw Object.assign(new Error(EXPIRED), { status: 404 });
    const [body, mac, ...rest] = token.split('.');
    const expected = Buffer.from(sign(body || ''));
    const given = Buffer.from(mac || '');
    if (!body || rest.length || given.length !== expected.length || !timingSafeEqual(given, expected)) throw Object.assign(new Error(EXPIRED), { status: 404 });
    let data;
    try { data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw Object.assign(new Error(EXPIRED), { status: 404 }); }
    if (data?.v !== 1 || typeof data.p !== 'string' || data.e * 1000 <= now()) throw Object.assign(new Error(EXPIRED), { status: 410 });
    const level = passageLevel({ dropbox_path: `${ROOT}${data.p}` });
    const stillAllowed = !auth.enabled || auth.users.some(user => user.name === data.u && LEVELS.indexOf(level) <= LEVELS.indexOf(user.level));
    if (!stillAllowed) throw Object.assign(new Error(EXPIRED), { status: 403 });
    return { path: data.p, user: data.u };
  }

  return { make, open };
}

const safeName = name => name.replace(/[^\x20-\x7e]|["\\]/g, '_');
const disposition = (kind, name) => `${kind}; filename="${safeName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`;
const BASE_HEADERS = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

// Sends the file to the browser. View: the original for PDF, text and images, Dropbox's preview for Office
// files. Download (?download=1): always the original file.
export async function sendDocument(res, dropbox, { path }, download) {
  const name = path.split('/').pop();
  const extension = extensionOf(name);
  const headers = { ...BASE_HEADERS };
  let upstream;
  if (!download && PREVIEW.has(extension)) {
    upstream = await dropbox.preview(path);
    // Dropbox says the preview format can change, so trust what it sends rather than the extension.
    const type = String(upstream.headers.get('content-type') || '').toLowerCase();
    const base = name.replace(/\.[^.]+$/, '');
    if (type.startsWith('application/pdf')) {
      Object.assign(headers, { 'Content-Type': 'application/pdf', 'Content-Disposition': disposition('inline', `${base}.pdf`) });
    } else if (type.startsWith('text/html')) {
      // Spreadsheet preview: shown with scripts, forms and outside requests blocked.
      Object.assign(headers, {
        'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': disposition('inline', `${base}.html`),
        'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      });
    } else {
      await upstream.body?.cancel().catch(() => {});
      throw Object.assign(new Error('A preview is not available for this file. Please use the Download link.'), { status: 415 });
    }
  } else {
    const inline = !download && Boolean(VIEWABLE[extension]);
    upstream = await dropbox.download(path);
    Object.assign(headers, {
      'Content-Type': VIEWABLE[extension] || DOWNLOAD_TYPES[extension] || 'application/octet-stream',
      'Content-Disposition': disposition(inline ? 'inline' : 'attachment', name),
    });
  }
  res.set(headers);
  const length = upstream.headers.get('content-length');
  if (length) res.set('Content-Length', length);
  await new Promise((resolve, reject) => {
    Readable.fromWeb(upstream.body).on('error', reject).pipe(res).on('finish', resolve).on('error', reject);
  });
}
