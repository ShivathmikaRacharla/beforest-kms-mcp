// f/kms/notify_indexing_failure
// Runs only when a step of f/kms/process_approved_document_pipeline fails (the flow's "error handler").
// 1. Records the file as FAILED, with the step and reason, in kms_document_processing
//    (same table and same document_key as f/kms/update_document_status, so a later successful run sets READY again).
// 2. Emails an alert to KMS_FAILURE_ALERT_TO (default shivathmika.r@beforest.co) using the SMTP settings the intake uses.
// It never changes Dropbox, Qdrant or the other pipeline steps.
import postgres from 'postgres@3'
import nodemailer from 'nodemailer@7'
import { getVariable } from 'windmill-client@1'

const variable = (name: string) => getVariable(`f/kms/${name}`)
const optional = (name: string) => variable(name).catch(() => '')
const ROOT = '/Apps/KMS-Documents (1)/'
const STEPS: Record<string, string> = {
  download: 'download from Dropbox', extract: 'read the text', chunk: 'split into pieces',
  index: 'add to search', status_ready: 'mark as ready',
}

// "Error: Spreadsheet extraction failed: no readable rows found in x.xlsx\n    at ..." -> first line, no "Error:"
const reasonFrom = (message?: string) => String(message || 'Unknown error').split('\n')[0].replace(/^\w*Error:\s*/, '').slice(0, 500)

export async function main(
  file_name?: string,
  dropbox_path?: string,
  dropbox_file_id?: string,
  dropbox_revision?: string,
  error_message?: string,
  error_step?: string,
) {
  const name = file_name || dropbox_path?.split('/').pop() || 'Unknown file'
  const path = dropbox_path ? (dropbox_path.startsWith(ROOT) ? dropbox_path : ROOT + dropbox_path.replace(/^\/+/, '')) : ''
  const [level, department] = path.slice(ROOT.length).split('/')
  const reason = reasonFrom(error_message)
  const step = error_step ? `${error_step} (${STEPS[error_step] || 'pipeline step'})` : 'unknown step'
  const jobId = process.env.WM_ROOT_FLOW_JOB_ID || process.env.WM_FLOW_JOB_ID || ''
  const jobLink = jobId && process.env.WM_BASE_URL ? `${process.env.WM_BASE_URL}/run/${jobId}?workspace=${process.env.WM_WORKSPACE}` : ''
  const problems: string[] = []

  // 1. Record FAILED (same key as update_document_status).
  try {
    const sql = postgres(await variable('DATABASE_URL'), { max: 1 })
    try {
      const documentKey = `${dropbox_file_id ?? path}:${dropbox_revision ?? 'latest'}`
      await sql`
        INSERT INTO kms_document_processing (document_key, file_name, dropbox_path, dropbox_file_id, dropbox_revision, department, status, error_message)
        VALUES (${documentKey}, ${name}, ${path}, ${dropbox_file_id ?? null}, ${dropbox_revision ?? null}, ${department ?? null}, 'FAILED', ${`${step}: ${reason}`})
        ON CONFLICT (document_key) DO UPDATE SET
          status = 'FAILED', error_message = EXCLUDED.error_message, updated_at = NOW(), ready_at = NULL
      `
    } finally { await sql.end() }
  } catch (error) {
    problems.push(`record: ${error instanceof Error ? error.message : String(error)}`)
  }

  // 2. Email the alert.
  const to = (await optional('KMS_FAILURE_ALERT_TO')) || 'shivathmika.r@beforest.co'
  try {
    const port = Number((await optional('SMTP_PORT')) || 587)
    const mailer = nodemailer.createTransport({
      host: await variable('SMTP_HOST'), port, secure: ((await optional('SMTP_SECURE')) || String(port === 465)) === 'true',
      auth: { user: await variable('SMTP_USER'), pass: await variable('SMTP_PASSWORD') },
    })
    await mailer.sendMail({
      from: await variable('SMTP_FROM'), to,
      subject: `KMS indexing failed: ${name}`,
      text: [
        `${name} was not added to search.`,
        '',
        `Folder: ${level && department ? `${level} / ${department}` : path || 'unknown'}`,
        `Step: ${step}`,
        `Reason: ${reason}`,
        dropbox_file_id ? `Dropbox file id: ${dropbox_file_id}` : '',
        jobLink ? `Windmill run: ${jobLink}` : '',
        '',
        'The file is still in Dropbox; only search is affected. Fix the file or the step, then run the pipeline again for it.',
        '',
        'Beforest AI',
      ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n'),
    })
  } catch (error) {
    problems.push(`email: ${error instanceof Error ? error.message : String(error)}`)
  }

  // If both failed, fail loudly so the run shows red in Windmill.
  if (problems.length === 2) throw new Error(`Could not record or report the indexing failure (${problems.join('; ')})`)
  return { file_name: name, step: error_step ?? null, reason, alerted: to, problems }
}
