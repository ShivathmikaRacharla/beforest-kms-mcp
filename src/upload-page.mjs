// The upload page: shows where the file will go, then one file picker.
// No inline script (strict CSP); all text is set with textContent.
export const FONT_ORIGIN = 'https://files.ops.beforest.co';

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Add to Beforest KMS</title>
<style>
@font-face{font-family:"ABC Arizona Flare";src:url(${FONT_ORIGIN}/fonts_beforest_arizona/ABCArizonaFlare-Light.e9c1597c.woff2) format("woff2");font-weight:300}
@font-face{font-family:"ABC Arizona Flare";src:url(${FONT_ORIGIN}/fonts_beforest_arizona/ABCArizonaFlare-Regular.cbcc518c.woff2) format("woff2");font-weight:400}
@font-face{font-family:"ABC Arizona Flare";src:url(${FONT_ORIGIN}/fonts_beforest_arizona/ABCArizonaFlare-Medium.7ce0f1db.woff2) format("woff2");font-weight:500}
:root { --bg:#fdfbf7; --card:#ffffff; --fg:#000000; --muted:#51514d; --line:#e7e4df; --green:#344736; --green-mid:#415c43; --green-soft:#b8dc99; --red:#86312b; --red-soft:#ff774a; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:400 16px/1.55 "ABC Arizona Flare",Georgia,serif; }
main { max-width:540px; margin:0 auto; padding:32px 16px 48px; display:flex; flex-direction:column; gap:18px; }
.label { font-weight:500; font-size:.75rem; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); margin:0; }
h1 { font-weight:500; font-size:1.6rem; line-height:1.15; margin:0; }
.card { background:var(--card); border:1px solid var(--line); padding:18px; display:flex; flex-direction:column; gap:12px; }
dl { margin:0; display:grid; grid-template-columns:auto 1fr; gap:6px 16px; }
dt { color:var(--muted); font-weight:300; } dd { margin:0; overflow-wrap:anywhere; font-weight:500; }
label.pick { display:block; border:1px dashed var(--green-mid); padding:22px 16px; text-align:center; cursor:pointer; }
input[type=file] { display:block; margin:10px auto 0; max-width:100%; font:inherit; }
button { font:500 .85rem/1 "ABC Arizona Flare",Georgia,serif; letter-spacing:.14em; text-transform:uppercase; padding:15px; border:0; background:var(--green); color:#fdfbf7; cursor:pointer; }
button:disabled { opacity:.45; cursor:default; }
progress { width:100%; height:8px; accent-color:var(--green-mid); }
.muted { color:var(--muted); font-size:.9rem; font-weight:300; margin:0; }
.msg { padding:14px 16px; margin:0; }
.ok { background:var(--green); color:#fdfbf7; } .ok b { color:var(--green-soft); }
.bad { background:var(--red); color:#fdfbf7; }
[hidden] { display:none !important; }
</style>
</head>
<body>
<main>
  <p class="label">Beforest knowledge base</p>
  <h1>Add a document</h1>
  <p id="loading" class="muted">Checking your link…</p>
  <section id="form" class="card" hidden>
    <dl>
      <dt>Folder</dt><dd id="f-folder"></dd>
      <dt>Who can find it</dt><dd id="f-visible"></dd>
    </dl>
    <label class="pick">Choose the file
      <input id="file" type="file" accept=".pdf,.docx,.pptx,.xlsx,.txt,.md">
    </label>
    <p id="limits" class="muted"></p>
    <button id="send" disabled>Upload</button>
    <progress id="bar" max="100" value="0" hidden></progress>
  </section>
  <p id="result" class="msg" hidden></p>
  <p class="muted">This private link works once. Please don't forward it.</p>
</main>
<script src="/upload/app.js"></script>
</body>
</html>`;

export const PAGE_JS = `(() => {
  const $ = id => document.getElementById(id);
  const token = location.hash.slice(1);
  const show = (text, good) => {
    $('loading').hidden = true;
    $('result').textContent = text;
    $('result').className = 'msg ' + (good ? 'ok' : 'bad');
    $('result').hidden = false;
  };
  if (!token) return show('This link is incomplete. Open the full link from Claude.', false);
  let limits;
  fetch('/upload/check', { headers: { 'X-Upload-Token': token }, cache: 'no-store' })
    .then(r => r.json().then(data => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) return show(data.error || 'This link cannot be used.', false);
      limits = data;
      $('f-folder').textContent = data.folder;
      $('f-visible').textContent = data.visible_to;
      $('limits').textContent = 'PDF, Word, PowerPoint, Excel, TXT or MD · up to ' + Math.round(data.max_bytes / 1048576) + ' MB';
      $('loading').hidden = true;
      $('form').hidden = false;
    })
    .catch(() => show('Could not reach the KMS server. Please try again.', false));

  $('file').addEventListener('change', () => {
    const file = $('file').files[0];
    $('result').hidden = true;
    $('send').disabled = !file;
    if (file && file.size > limits.max_bytes) { $('send').disabled = true; show('This file is too large.', false); }
  });

  $('send').addEventListener('click', () => {
    const file = $('file').files[0];
    if (!file) return;
    $('send').disabled = true; $('file').disabled = true;
    $('bar').hidden = false;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload/file');
    xhr.setRequestHeader('X-Upload-Token', token);
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = e => { if (e.lengthComputable) $('bar').value = Math.round(e.loaded / e.total * 100); };
    xhr.onload = () => {
      $('bar').hidden = true;
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status !== 200) { $('send').disabled = false; $('file').disabled = false; return show(data.error || 'Upload failed. Please try again.', false); }
      $('form').hidden = true;
      history.replaceState(null, '', location.pathname);
      const where = data.file_name + ' was added to ' + data.level + ' / ' + data.department + '. ';
      if (data.indexing === 'started') show(where + 'Indexing has started; it will be searchable in ' + data.searchable_in + '.', true);
      else show(where + data.message, true);
    };
    xhr.onerror = () => { $('bar').hidden = true; $('send').disabled = false; $('file').disabled = false; show('Upload failed. Check your connection and try again.', false); };
    xhr.send(file);
  });
})();`;
