// Shows a CSV file as a simple table page (the "View" link). Built here, not by Dropbox, because Dropbox's
// preview is unreliable for CSV. All cell text is escaped and the page is served sandboxed (no scripts).
export const CSV_MAX_ROWS = 5000;
export const CSV_MAX_BYTES = 25 * 1024 * 1024;
const FONT_ORIGIN = 'https://files.ops.beforest.co';

// Bytes -> text: UTF-8 (BOM removed), or Windows-1252 for files saved by older Excel versions.
export function decodeCsv(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, ''); }
  catch { return new TextDecoder('windows-1252').decode(bytes); }
}

// Comma, semicolon or tab: whichever appears most in the first line (outside quotes).
function delimiterOf(text) {
  const first = text.slice(0, text.search(/\r?\n/) === -1 ? text.length : text.search(/\r?\n/)).replace(/"[^"]*"/g, '');
  const counts = [',', ';', '\t'].map(d => [d, first.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

// RFC 4180 parsing (quoted fields, "" escapes, line breaks inside quotes). Keeps at most maxRows rows,
// but counts them all so the page can say "showing 5,000 of 12,000".
export function parseCsv(text, maxRows = CSV_MAX_ROWS + 1) { // + the header row
  const delimiter = delimiterOf(text);
  const rows = [];
  let row = [], field = '', quoted = false, total = 0;
  const endRow = () => {
    row.push(field); field = '';
    if (row.length > 1 || row[0] !== '') { total++; if (rows.length < maxRows) rows.push(row); }
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n') endRow();
    else if (c === '\r') { if (text[i + 1] !== '\n') endRow(); }
    else field += c;
  }
  if (field !== '' || row.length) endRow();
  return { rows, total };
}

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = n => n.toLocaleString('en-IN');

export function renderCsvPage(name, { rows, total }) {
  const [head = [], ...body] = rows;
  const width = Math.max(1, ...rows.map(r => r.length));
  const cells = (r, tag) => Array.from({ length: width }, (_, i) => `<${tag}>${escape(r[i] ?? '')}</${tag}>`).join('');
  const dataRows = Math.max(0, total - 1);
  const note = total > rows.length
    ? `Showing the first ${number(body.length)} of ${number(dataRows)} rows. Use the Download link for the full file.`
    : `${number(dataRows)} rows · ${number(width)} columns`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(name)}</title>
<style>
@font-face{font-family:"ABC Arizona Flare";src:url(${FONT_ORIGIN}/fonts_beforest_arizona/ABCArizonaFlare-Regular.cbcc518c.woff2) format("woff2");font-weight:400}
@font-face{font-family:"ABC Arizona Flare";src:url(${FONT_ORIGIN}/fonts_beforest_arizona/ABCArizonaFlare-Medium.7ce0f1db.woff2) format("woff2");font-weight:500}
body{margin:0;background:#fdfbf7;color:#000;font:400 14px/1.45 "ABC Arizona Flare",Georgia,serif}
header{padding:20px 16px 12px}
.label{margin:0;font-weight:500;font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;color:#51514d}
h1{margin:4px 0 6px;font-weight:500;font-size:1.25rem;overflow-wrap:anywhere}
.note{margin:0;color:#51514d}
.wrap{overflow:auto;max-height:calc(100vh - 110px);border-top:1px solid #e7e4df}
table{border-collapse:collapse;min-width:100%}
th,td{padding:6px 10px;border-bottom:1px solid #e7e4df;border-right:1px solid #e7e4df;text-align:left;vertical-align:top;white-space:pre-wrap;max-width:420px}
th{position:sticky;top:0;background:#344736;color:#fdfbf7;font-weight:500}
tr:nth-child(even) td{background:#f4f1ec}
</style></head>
<body><header><p class="label">Beforest knowledge base</p><h1>${escape(name)}</h1><p class="note">${note}</p></header>
<div class="wrap"><table><thead><tr>${cells(head, 'th')}</tr></thead><tbody>
${body.map(r => `<tr>${cells(r, 'td')}</tr>`).join('\n')}
</tbody></table></div></body></html>`;
}

export const CSV_PAGE_CSP = `sandbox; default-src 'none'; style-src 'unsafe-inline'; font-src ${FONT_ORIGIN}`;
