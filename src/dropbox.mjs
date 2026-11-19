// Minimal Dropbox client for the KMS app folder ("KMS-Documents (1)").
// The app is app-folder scoped, so API paths start at the app folder: "/Team/HR/<file>".
// Auth uses the refresh token; the short-lived access token is kept in memory only.
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';

// Dropbox-API-Arg is an HTTP header, so anything outside ASCII must be escaped.
export function readDropboxConfig(env = process.env) {
  const appKey = env.DROPBOX_APP_KEY?.trim();
  const appSecret = env.DROPBOX_APP_SECRET?.trim();
  const refreshToken = env.DROPBOX_REFRESH_TOKEN?.trim();
  if (!appKey && !appSecret && !refreshToken) return { enabled: false };
  if (!appKey || !appSecret || !refreshToken) throw new Error('Set all of DROPBOX_APP_KEY, DROPBOX_APP_SECRET and DROPBOX_REFRESH_TOKEN, or none.');
  return { enabled: true, appKey, appSecret, refreshToken, timeoutMs: 120000 };
}

const asciiJson = value => JSON.stringify(value).replace(/[\u007f-￿]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

export function createDropbox(config, fetchImpl = fetch, now = Date.now) {
  let cached;
  const call = async (url, options, what) => {
    try {
      return await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs) });
    } catch (error) {
      if (['TimeoutError', 'AbortError'].includes(error.name)) throw new Error(`Dropbox timed out (${what}). Please try again.`);
      throw new Error(`Dropbox is unavailable (${what}). Please try again later.`);
    }
  };
  const errorSummary = async response => {
    try { return String((await response.json()).error_summary || ''); } catch { return ''; }
  };

  async function accessToken() {
    if (cached && cached.until > now()) return cached.token;
    const response = await call(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.appKey}:${config.appSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: config.refreshToken }).toString(),
    }, 'sign-in');
    if (!response.ok) throw new Error(`Dropbox sign-in failed (HTTP ${response.status}).`);
    const data = await response.json();
    if (typeof data.access_token !== 'string') throw new Error('Dropbox sign-in returned an unexpected response.');
    // Refresh five minutes early so a token never expires mid-upload.
    cached = { token: data.access_token, until: now() + Math.max(60, Number(data.expires_in || 14400) - 300) * 1000 };
    return cached.token;
  }

  const rpc = async (endpoint, body, what = 'list') => call(`${API}/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, what);

  // File names in a folder. A missing folder is an error: we never create level or space folders.
  async function listNames(folder) {
    const names = [];
    let response = await rpc('files/list_folder', { path: folder, limit: 2000 });
    for (;;) {
      if (response.status === 409 && (await errorSummary(response)).startsWith('path/not_found')) {
        throw new Error(`The folder "${folder}" does not exist in Dropbox.`);
      }
      if (!response.ok) throw new Error(`Dropbox folder check failed (HTTP ${response.status}).`);
      const data = await response.json();
      for (const entry of data.entries || []) if (entry['.tag'] === 'file') names.push(entry.name);
      if (!data.has_more) return names;
      response = await rpc('files/list_folder/continue', { cursor: data.cursor });
    }
  }

  // Every file under the app folder (read-only): path, size and when it was added.
  async function listAll() {
    const files = [];
    let response = await rpc('files/list_folder', { path: '', recursive: true, limit: 2000 });
    for (;;) {
      if (!response.ok) throw new Error(`Dropbox listing failed (HTTP ${response.status}).`);
      const data = await response.json();
      for (const entry of data.entries || []) {
        if (entry['.tag'] === 'file') files.push({ path: entry.path_display, name: entry.name, size: entry.size, added: entry.server_modified });
      }
      if (!data.has_more) return files;
      response = await rpc('files/list_folder/continue', { cursor: data.cursor });
    }
  }

  // Opens one file for reading (read-only). Returns the response, whose body streams the file.
  async function download(path) {
    const response = await call(`${CONTENT}/files/download`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Dropbox-API-Arg': asciiJson({ path }) },
    }, 'download');
    if (response.status === 409) {
      const summary = await errorSummary(response);
      if (summary.startsWith('path/not_found')) throw new Error('That file is no longer in Dropbox.');
      throw new Error(`Dropbox could not open the file (${summary.split('/')[0] || 'HTTP 409'}).`);
    }
    if (!response.ok || !response.body) throw new Error(`Dropbox could not open the file (HTTP ${response.status}).`);
    return response;
  }

  // Adds a new file. Returns null if the name is already taken (never overwrites).
  async function upload(path, bytes) {
    const response = await call(`${CONTENT}/files/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': asciiJson({ path, mode: 'add', autorename: false, mute: true, strict_conflict: true }),
      },
      body: bytes,
    }, 'upload');
    if (response.status === 409) {
      const summary = await errorSummary(response);
      if (summary.includes('conflict')) return null;
      throw new Error(`Dropbox upload failed (${summary.split('/')[0] || 'HTTP 409'}).`);
    }
    if (!response.ok) throw new Error(`Dropbox upload failed (HTTP ${response.status}).`);
    const data = await response.json();
    if (typeof data.id !== 'string' || typeof data.rev !== 'string') throw new Error('Dropbox upload returned an unexpected response.');
    return { id: data.id, rev: data.rev, name: data.name };
  }

  return { download, listAll, listNames, upload };
}
