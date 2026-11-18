import { z } from 'zod';
import { LEVELS } from './auth.mjs';
import { ROOT, SPACES } from './kms-folders.mjs';
import { passageLevel } from './search.mjs';

// The catalogue: which documents exist, for the caller's level only.
// Read from the Dropbox folders (the folders are the levels), never from search results,
// so the count is exact and nothing above the caller's level is named or counted.
const CACHE_MS = 5 * 60 * 1000;
const JUST_ADDED_MS = 5 * 60 * 1000;
const MAX_DOCUMENTS = 500;
const NAME = /^([A-Z][A-Z0-9]*)_([A-Z][A-Z0-9-]*)_([A-Za-z0-9][A-Za-z0-9-]*)_V([1-9]\d*)_(\d{4}-\d{2}-\d{2})\.([a-z0-9]+)$/i;
const LEVEL_LABEL = { employee: 'Team', leader: 'Leadership', oceo: 'Office of the CEO' };
const SEES = { employee: 'Team documents', leader: 'Team and Leadership documents', oceo: 'all documents' };

export const listShape = {
  space: z.enum(SPACES).optional().describe('Only this knowledge space. Leave out to list every space.'),
};
const listSchema = z.object(listShape).strict();

// One Dropbox file -> one catalogue entry, with the same level rule search uses.
export function describeFile(file) {
  const parts = file.path.split('/').filter(Boolean);
  const level = passageLevel({ dropbox_path: `${ROOT}${file.path}` });
  const space = SPACES.find(name => parts.slice(0, -1).some(part => part.toLowerCase() === name.toLowerCase())) || 'Other';
  const named = NAME.exec(file.name);
  return {
    level,
    entry: {
      title: named ? named[3].replace(/-/g, ' ') : file.name.replace(/\.[^.]+$/, ''),
      space, level: LEVEL_LABEL[level],
      type: named ? named[2].toUpperCase() : null,
      version: named ? Number(named[4]) : null,
      date: named ? named[5] : null,
      file_name: file.name,
      added: file.added || null,
    },
  };
}

export function createLister(dropbox, now = Date.now) {
  let cache;
  async function catalogue() {
    if (cache && cache.until > now()) return cache.files;
    const files = (await dropbox.listAll()).filter(file => !file.name.startsWith('.'));
    cache = { files, until: now() + CACHE_MS };
    return files;
  }

  async function list(rawInput, viewer) {
    if (!LEVELS.includes(viewer?.level)) throw new Error('Listing documents needs a signed-in user.');
    const input = listSchema.parse(rawInput ?? {});
    const visible = (await catalogue())
      .map(describeFile)
      .filter(({ level }) => LEVELS.indexOf(level) <= LEVELS.indexOf(viewer.level))
      .map(({ entry }) => ({ ...entry, just_added: entry.added ? now() - Date.parse(entry.added) < JUST_ADDED_MS : false }))
      .filter(entry => !input.space || entry.space === input.space)
      .sort((a, b) => a.space.localeCompare(b.space) || a.title.localeCompare(b.title) || (b.version ?? 0) - (a.version ?? 0));
    const bySpace = {};
    for (const entry of visible) bySpace[entry.space] = (bySpace[entry.space] || 0) + 1;
    console.log(JSON.stringify({ event: 'list', user: viewer.name, level: viewer.level, space: input.space ?? null, returned: visible.length }));
    return {
      shows: SEES[viewer.level], space: input.space ?? null,
      total: visible.length,
      by_space: Object.entries(bySpace).map(([space, count]) => ({ space, count })),
      documents: visible.slice(0, MAX_DOCUMENTS),
      truncated: visible.length > MAX_DOCUMENTS,
      note: 'Documents marked just_added may still be processing and not searchable for 1-2 minutes.',
    };
  }

  return { list, refresh: () => { cache = undefined; } };
}
