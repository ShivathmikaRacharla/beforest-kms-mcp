// After a file is saved in Dropbox, start the existing Windmill pipeline
// (f/kms/process_approved_document_pipeline) for it. The pipeline itself is unchanged.
// We always send the Dropbox file id, so the download step never depends on the path.
const FLOW = '/jobs/run/f/f/kms/process_approved_document_pipeline';

export function readProcessConfig(env = process.env) {
  const url = env.WINDMILL_WEBHOOK_URL?.trim();
  const token = env.WINDMILL_WEBHOOK_TOKEN?.trim();
  if (!url && !token) return { enabled: false };
  if (!url || !token) throw new Error('Set both WINDMILL_WEBHOOK_URL and WINDMILL_WEBHOOK_TOKEN, or neither.');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('WINDMILL_WEBHOOK_URL is not a valid URL.'); }
  // Only the KMS pipeline flow can be started; anything else is a configuration mistake.
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.pathname.endsWith(FLOW)) {
    throw new Error('WINDMILL_WEBHOOK_URL must be the https run URL of f/kms/process_approved_document_pipeline.');
  }
  return { enabled: true, url: parsed.href, token, timeoutMs: Number(env.WINDMILL_TIMEOUT_MS || 30000) };
}

// doc: { dropbox_path (full, with the app folder), dropbox_file_id, dropbox_revision, file_name, file_size_bytes }
export function createProcess(config, fetchImpl = fetch) {
  return async doc => {
    // The same body the existing handoff sends; uploads have no separate approver, so they arrive approved.
    const body = {
      event_type: 'approved_document_uploaded',
      approval_status: 'approved',
      dropbox_file_id: doc.dropbox_file_id,
      dropbox_revision: doc.dropbox_revision,
      dropbox_path: doc.dropbox_path,
      file_name: doc.file_name,
      file_size_bytes: doc.file_size_bytes,
    };
    let response;
    try {
      response = await fetchImpl(config.url, {
        method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      if (['TimeoutError', 'AbortError'].includes(error.name)) throw new Error('Starting indexing timed out.');
      throw new Error('Indexing is unavailable right now.');
    }
    if (!response.ok) throw new Error(`Starting indexing failed (HTTP ${response.status}).`);
    return { job_id: (await response.text()).trim().replace(/^"|"$/g, '') || null };
  };
}
