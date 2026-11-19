import { z } from 'zod';
import { ROOT } from './kms-folders.mjs';

// A view/download link to one original document, only if the caller's level allows it.
// Dropbox temporary links last 4 hours, so a forwarded link stops working the same day.
const LINK_MS = 4 * 60 * 60 * 1000;
const OPENS_IN_BROWSER = ['pdf', 'txt', 'md', 'png', 'jpg', 'jpeg'];

export const linkShape = {
  file_name: z.string().trim().min(1).max(500).describe('Exact file name from list_documents or a search result, e.g. "HR_POLICY_Leave-and-Attendance_V2_2026-10-01.pdf". A full Dropbox path from a search result also works.'),
};
const linkSchema = z.object(linkShape).strict();

// Same message whether the file does not exist or is above the caller's level, so nothing leaks.
const NOT_AVAILABLE = 'No document with that name is available to you. Use list_documents to find the exact file name.';

export function createLinker(lister, dropbox, now = Date.now) {
  return async (rawInput, viewer) => {
    const input = linkSchema.parse(rawInput ?? {});
    // Accept a bare name or a full path ("/Apps/KMS-Documents (1)/Team/HR/<name>"); match on the name.
    const wanted = input.file_name.replace(/^.*\//, '').toLowerCase();
    const wantedPath = input.file_name.startsWith(`${ROOT}/`) ? input.file_name.slice(ROOT.length).toLowerCase() : null;
    const matches = (await lister.visibleFiles(viewer)).filter(({ entry }) => entry.file_name.toLowerCase() === wanted);
    const chosen = matches.find(({ path }) => path.toLowerCase() === wantedPath)
      // The same name in two folders is rare; take the most recently added copy.
      ?? matches.sort((a, b) => String(b.entry.added).localeCompare(String(a.entry.added)))[0];
    if (!chosen) throw new Error(NOT_AVAILABLE);
    const link = await dropbox.temporaryLink(chosen.path);
    const extension = chosen.entry.file_name.split('.').pop().toLowerCase();
    const { entry } = chosen;
    console.log(JSON.stringify({ event: 'link', user: viewer.name, level: viewer.level, file_name: entry.file_name, space: entry.space, doc_level: entry.level }));
    return {
      file_name: entry.file_name, title: entry.title, space: entry.space, level: entry.level,
      version: entry.version, date: entry.date,
      link, expires_at: new Date(now() + LINK_MS).toISOString(),
      opens: OPENS_IN_BROWSER.includes(extension) ? 'Opens in the browser; it can be downloaded from there.' : 'Downloads the file.',
      note: 'Give this link only to the person who asked. It stops working after 4 hours.',
    };
  };
}
