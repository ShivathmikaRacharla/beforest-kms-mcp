import { LEVEL_FOLDERS, SPACES } from './kms-folders.mjs';

// The 10 departments (Dropbox "spaces") and the words people actually type for them.
// The same matcher is used by upload_document and, copied, by the Windmill inbox intake,
// so "hr", "fin" or "Finanace" all land in the same folder.
export const DEPARTMENTS = [
  { name: 'Bewild', short: 'BEWILD', aliases: ['bewild', 'be wild'] },
  { name: 'Business Intelligence', short: 'BI', aliases: ['bi', 'business intelligence', 'business intel', 'intelligence', 'data'] },
  { name: 'Collective Design & Support', short: 'CDS', aliases: ['cds', 'collective design and support', 'collective design', 'design', 'design and support'] },
  { name: 'Collective Operations', short: 'COPS', aliases: ['cops', 'collective operations', 'operations', 'ops'] },
  { name: 'Community Engagement', short: 'CE', aliases: ['ce', 'community engagement', 'community', 'engagement'] },
  { name: 'Content & Storytelling', short: 'CS', aliases: ['cs', 'content and storytelling', 'content', 'storytelling', 'stories'] },
  { name: 'Finance & Accounts', short: 'FIN', aliases: ['fin', 'finance and accounts', 'finance', 'accounts', 'accounting'] },
  { name: 'HR', short: 'HR', aliases: ['hr', 'human resources', 'people'] },
  { name: 'Legal & Liasoning', short: 'LEGAL', aliases: ['legal', 'legal and liasoning', 'legal and liaisoning', 'liasoning', 'liaisoning'] },
  { name: 'Regolith', short: 'REGOLITH', aliases: ['regolith'] },
];
if (DEPARTMENTS.map(d => d.name).join('|') !== SPACES.join('|')) throw new Error('DEPARTMENTS must match SPACES.');

export const FOLDER_BY_LEVEL = Object.fromEntries(Object.entries(LEVEL_FOLDERS).map(([folder, level]) => [level, folder]));

// "Finance & Accounts!" -> "finance and accounts"
const clean = text => String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');

function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[b.length];
}

// Returns { department } when the text clearly names one, { choices } when it could be several,
// or { choices: [] } when nothing matches. Never guesses between two departments.
export function matchDepartment(text) {
  // People may still type the level ("Team / HR"); the level always comes from their key or email, so drop it.
  const levelWords = Object.keys(LEVEL_FOLDERS).map(clean).concat(['team', 'leadership', 'leaders', 'ceo', 'office of the ceo']);
  let typed = clean(String(text ?? '').split('/').pop());
  if (!typed) typed = clean(text);
  if (levelWords.includes(typed)) return { choices: [] };
  if (!typed) return { choices: [] };
  const exact = DEPARTMENTS.filter(d => clean(d.name) === typed || d.aliases.includes(typed));
  if (exact.length === 1) return { department: exact[0].name };
  // Small typos: 1 letter off for short words, 2 for longer ones.
  const close = DEPARTMENTS.filter(d => [clean(d.name), ...d.aliases].some(word => word.length >= 3 && distance(word, typed) <= (word.length >= 7 ? 2 : 1)));
  if (close.length === 1) return { department: close[0].name, corrected: true };
  return { choices: close.map(d => d.name) };
}

export const departmentList = () => DEPARTMENTS.map(({ name, short }) => ({ name, short }));
