// f/kms/kms_inbox_intake  (Windmill, Bun)  — NOT DEPLOYED. Review, then add to Windmill with a 5-minute schedule.
//
// Reads the KMS intake inbox (beforestai@gmail.com) and handles two kinds of message:
//   1. An email with attachments  -> the attachments are added.
//   2. A Google share notification (Sheets / Docs / Slides / Drive file shared with the inbox,
//      "Notify people" ticked)      -> the file is exported (Sheet .xlsx, Doc .docx, Slides .pptx) and added.
// The person types the department (subject or message box, e.g. "HR"); short names and typos are accepted.
// The level comes from the sender's email (KMS_SENDER_LEVELS), never from what they type.
// Each file goes to Dropbox <Level>/<Department>/ (never overwritten; an identical copy is skipped) and the
// existing pipeline f/kms/process_approved_document_pipeline is started with the Dropbox file id.
// If the department is unclear, the sender gets "which department?" and simply replies with it.
//
// Nothing existing changes: emails are not marked read or moved, so the manual check still works, and the
// pipeline, retrieval and the Dropbox -> Windmill handoff are untouched. State is kept in Postgres.
//
// Run with dry_run = true first: it reads and reports what it would do, and adds, starts and sends nothing.

import postgres from 'postgres@3'
import nodemailer from 'nodemailer@7'
import { getVariable, JobService } from 'windmill-client@1'

const variable = (name: string) => getVariable(`f/kms/${name}`)
const optional = async (name: string) => { try { return String(await variable(name) ?? '').trim() } catch { return '' } }
const WORKSPACE = process.env.WM_WORKSPACE || 'beforest-automations'
const ROOT = '/Apps/KMS-Documents (1)'
const PIPELINE = 'f/kms/process_approved_document_pipeline'
const LOOKBACK_DAYS = 7
const FILE_TYPES = new Set(['pdf', 'docx', 'pptx', 'xlsx', 'txt', 'md'])
const LEVEL_FOLDER: Record<string, string> = { employee: 'Team', leader: 'Leadership', oceo: 'Office of the CEO' }
// Google files are exported to Office formats; Drive allows exports up to 10 MB.
const EXPORTS: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  'application/vnd.google-apps.document': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' },
  'application/vnd.google-apps.presentation': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' },
}

// ---------- Departments (same list and matching as the KMS MCP, src/departments.mjs) ----------
const DEPARTMENTS: Array<{ name: string; aliases: string[] }> = [
  { name: 'Bewild', aliases: ['bewild', 'be wild'] },
  { name: 'Business Intelligence', aliases: ['bi', 'business intelligence', 'business intel', 'intelligence', 'data'] },
  { name: 'Collective Design & Support', aliases: ['cds', 'collective design and support', 'collective design', 'design', 'design and support'] },
  { name: 'Collective Operations', aliases: ['cops', 'collective operations', 'operations', 'ops'] },
  { name: 'Community Engagement', aliases: ['ce', 'community engagement', 'community', 'engagement'] },
  { name: 'Content & Storytelling', aliases: ['cs', 'content and storytelling', 'content', 'storytelling', 'stories'] },
  { name: 'Finance & Accounts', aliases: ['fin', 'finance and accounts', 'finance', 'accounts', 'accounting'] },
  { name: 'HR', aliases: ['hr', 'human resources', 'people'] },
  { name: 'Legal & Liasoning', aliases: ['legal', 'legal and liasoning', 'legal and liaisoning', 'liasoning', 'liaisoning'] },
  { name: 'Regolith', aliases: ['regolith'] },
]
const clean = (text: string) => String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')
function distance(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 2) return 3
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    previous = row
  }
  return previous[b.length]
}
const LEVEL_WORDS = ['team', 'leadership', 'leaders', 'ceo', 'office of the ceo']
export function matchDepartment(text: string): string | null {
  const typed = clean(String(text ?? '').split('/').pop() || '')
  if (!typed || LEVEL_WORDS.includes(typed)) return null
  const exact = DEPARTMENTS.filter((d) => clean(d.name) === typed || d.aliases.includes(typed))
  if (exact.length === 1) return exact[0].name
  const close = DEPARTMENTS.filter((d) => [clean(d.name), ...d.aliases].some((w) => w.length >= 3 && distance(w, typed) <= (w.length >= 7 ? 2 : 1)))
  return close.length === 1 ? close[0].name : null
}
// Words that are too common to count inside a sentence ("please add this content") — only as the whole answer.
const WEAK = new Set(['data', 'people', 'design', 'content', 'community', 'engagement', 'operations', 'accounts', 'accounting', 'stories', 'intelligence', 'design and support', 'storytelling'])
// Departments named inside a sentence, e.g. "Please add this to the CDS department" -> Collective Design & Support.
function departmentsInSentence(line: string) {
  const words = clean(line.replace(/\//g, ' ')).split(' ')
  const found = new Set<string>()
  for (let size = 1; size <= 4; size++) {
    for (let i = 0; i + size <= words.length; i++) {
      const phrase = words.slice(i, i + size).join(' ')
      if (WEAK.has(phrase)) continue
      for (const d of DEPARTMENTS) if (clean(d.name) === phrase || d.aliases.includes(phrase)) found.add(d.name)
    }
  }
  return [...found]
}
// The department, from the first line that names exactly one (the whole line, or a sentence that mentions it).
function departmentFrom(lines: string[]) {
  for (const line of lines) {
    if (!line || /https?:\/\//i.test(line) || line.length > 200) continue
    const whole = line.length <= 60 ? matchDepartment(line) : null
    if (whole) return whole
    const inSentence = departmentsInSentence(line)
    if (inSentence.length === 1) return inSentence[0]
  }
  return null
}

// Reads a JSON setting; on a mistake, names the setting and the likely cause, never the value.
function parseSetting(name: string, raw: string) {
  try { return JSON.parse(raw) } catch {
    const hints = []
    if (/[\u201c\u201d\u2018\u2019]/.test(raw)) hints.push('it has curly quotes; use straight quotes "')
    if (!raw.trim().startsWith('{')) hints.push('it must start with {')
    if (!raw.trim().endsWith('}')) hints.push('it must end with }')
    if (/,\s*}/.test(raw)) hints.push('remove the comma before }')
    throw new Error(`Windmill variable f/kms/${name} is not valid JSON${hints.length ? `: ${hints.join('; ')}` : ''}.`)
  }
}

// KMS_SENDER_LEVELS, either JSON {"name@beforest.co":"leader"} or one person per line / comma:
//   harsha@beforest.co - OCEO
//   shivathmika.r@beforest.co - Leadership
//   seshu@beforest.co - Team
const LEVEL_WORDS_TO_KEY: Record<string, string> = {
  oceo: 'oceo', ceo: 'oceo', 'office of the ceo': 'oceo',
  leader: 'leader', leaders: 'leader', leadership: 'leader',
  employee: 'employee', team: 'employee', staff: 'employee',
}
function parseSenderLevels(raw: string) {
  const text = raw.trim().replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'")
  if (!text) return {} as Record<string, string>
  const pairs: Array<[string, string]> = text.startsWith('{')
    ? Object.entries(parseSetting('KMS_SENDER_LEVELS', text)).map(([k, v]) => [k, String(v)])
    : text.split(/[\n,;]+/).map((line) => line.trim()).filter(Boolean).map((line, i) => {
        const match = line.match(/^["']?([^\s"':=]+@[^\s"':=]+?)["']?\s*[-:=–—\s]\s*["']?([A-Za-z ]+?)["']?$/)
        if (!match) throw new Error(`KMS_SENDER_LEVELS entry ${i + 1} should look like: name@beforest.co - Leadership`)
        return [match[1], match[2]]
      })
  const levels: Record<string, string> = {}
  for (const [email, word] of pairs) {
    const level = LEVEL_WORDS_TO_KEY[clean(word)]
    if (!level) throw new Error(`KMS_SENDER_LEVELS: level for ${email} must be Team, Leadership or OCEO.`)
    levels[email.trim().toLowerCase()] = level
  }
  return levels
}

// ---------- Google (Gmail read-only + Drive read-only) ----------
// The Google credential: JSON, JSON without the outer { }, or one "key: value" per line.
function parseGoogleCredential(name: string, raw: string) {
  const text = raw.trim().replace(/[\u201c\u201d]/g, '"')
  if (text.startsWith('{')) return parseSetting(name, text)
  if (text.includes('"client_id"')) return parseSetting(name, `{${text.replace(/,\s*$/, '')}}`)
  const found: Record<string, string> = {}
  for (const line of text.split(/[\n,]+/)) {
    const match = line.trim().match(/^["']?(client_id|client_secret|refresh_token)["']?\s*[:=]\s*["']?([^"'\s]+)["']?$/i)
    if (match) found[match[1].toLowerCase()] = match[2]
  }
  if (found.client_id && found.client_secret && found.refresh_token) return found
  throw new Error(`Windmill variable f/kms/${name} needs client_id, client_secret and refresh_token, e.g. {"client_id":"...","client_secret":"...","refresh_token":"..."}.`)
}
async function googleToken(raw: string, name: string) {
  const parsed = parseGoogleCredential(name, raw)
  const c = parsed.installed || parsed.web || parsed
  const body = new URLSearchParams({ client_id: c.client_id || parsed.client_id, client_secret: c.client_secret || parsed.client_secret, refresh_token: c.refresh_token || parsed.refresh_token, grant_type: 'refresh_token' })
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
  if (!response.ok) throw new Error(`Google sign-in failed: HTTP ${response.status}`)
  return (await response.json()).access_token as string
}
async function google(token: string, url: string, binary = false) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  if (!response.ok) throw new Error(`Google API failed: HTTP ${response.status} - ${(await response.text()).slice(0, 300)}`)
  return binary ? Buffer.from(await response.arrayBuffer()) : response.json()
}
const gmail = (token: string, path: string) => google(token, `https://gmail.googleapis.com/gmail/v1/users/me${path}`)

type Part = { mimeType?: string; filename?: string; body?: { attachmentId?: string; data?: string; size?: number }; parts?: Part[]; headers?: Array<{ name: string; value: string }> }
const header = (part: Part, name: string) => part.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value?.trim() || ''
const address = (value: string) => ((value.match(/<([^>]+)>/)?.[1] || value).trim().toLowerCase())
const walk = (part: Part, out: Part[] = []) => { out.push(part); for (const child of part.parts || []) walk(child, out); return out }
const decode = (data?: string) => (data ? Buffer.from(data, 'base64url').toString('utf8') : '')
function plainText(payload: Part) {
  const parts = walk(payload)
  const text = parts.find((p) => p.mimeType === 'text/plain' && !p.filename)
  if (text) return decode(text.body?.data)
  const html = parts.find((p) => p.mimeType === 'text/html' && !p.filename)
  return decode(html?.body?.data).replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
}
// The person's own words only: stop at the first quoted earlier message ("On ... wrote:" or "> ").
function ownLines(text: string) {
  const lines = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (/^on .+wrote:$/i.test(line) || /^on .+<$/i.test(line) || line.startsWith('>') || line === '--' || /^disclaimer\b/i.test(line)) break
    lines.push(line)
  }
  return lines.filter(Boolean)
}
// A Google share notification: the link to the shared file, e.g. docs.google.com/spreadsheets/d/<id>/edit
function sharedFileId(text: string) {
  return text.match(/https:\/\/(?:docs|drive)\.google\.com\/(?:document|spreadsheets|presentation|file)\/d\/([A-Za-z0-9_-]{20,})/)?.[1] || null
}

// ---------- Dropbox (app folder: API paths start at the app folder, e.g. /Team/HR/x.pdf) ----------
async function dropboxToken(appKey: string, appSecret: string, refreshToken: string) {
  const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${appKey}:${appSecret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  })
  if (!response.ok) throw new Error(`Dropbox sign-in failed: HTTP ${response.status}`)
  return (await response.json()).access_token as string
}
const asciiJson = (value: unknown) => JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
// Dropbox content hash: SHA-256 of the concatenated SHA-256 of each 4 MB block.
async function contentHash(bytes: Buffer) {
  const blocks = []
  for (let i = 0; i < Math.max(bytes.length, 1); i += 4 * 1024 * 1024) blocks.push(Buffer.from(await crypto.subtle.digest('SHA-256', bytes.subarray(i, i + 4 * 1024 * 1024))))
  return Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.concat(blocks))).toString('hex')
}
const numbered = (name: string, n: number) => (n === 1 ? name : name.replace(/(\.[^.]+)$/, ` (${n})$1`))
// Adds the file; never overwrites. If the same name exists with identical content, it is already in the KMS.
async function addToDropbox(token: string, folder: string, name: string, bytes: Buffer) {
  const hash = await contentHash(bytes)
  // Same content already in this folder under any name (e.g. "Report (8).pdf")? Then it is already in the KMS.
  let listing = await fetch('https://api.dropboxapi.com/2/files/list_folder', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: folder, limit: 2000 }) })
  while (listing.ok) {
    const page = await listing.json()
    const same = (page.entries || []).find((e: { '.tag': string; content_hash?: string }) => e['.tag'] === 'file' && e.content_hash === hash)
    if (same) return { duplicate: true, name: same.name as string, path: `${folder}/${same.name}` }
    if (!page.has_more) break
    listing = await fetch('https://api.dropboxapi.com/2/files/list_folder/continue', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ cursor: page.cursor }) })
  }
  for (let n = 1; n <= 20; n++) {
    const path = `${folder}/${numbered(name, n)}`
    const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': asciiJson({ path, mode: 'add', autorename: false, mute: true, strict_conflict: true }) },
      body: bytes,
    })
    if (response.ok) { const data = await response.json(); return { duplicate: false, id: data.id as string, rev: data.rev as string, name: data.name as string, path } }
    const summary = String((await response.json().catch(() => ({}))).error_summary || '')
    if (response.status !== 409 || !summary.includes('conflict')) throw new Error(`Dropbox upload failed: HTTP ${response.status} ${summary}`)
    const meta = await fetch('https://api.dropboxapi.com/2/files/get_metadata', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) })
    if (meta.ok && (await meta.json()).content_hash === hash) return { duplicate: true, name: numbered(name, n), path }
  }
  throw new Error('Too many files with this name already exist.')
}
const safeName = (name: string) => name.split(/[\\/]/).pop()!.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(-180)

// ---------- Main ----------
type Found = { name: string; bytes?: Buffer; fetch: () => Promise<Buffer>; size?: number }

export async function main(dry_run = false, max_messages = 30) {
  const intake = (await variable('GMAIL_INTAKE_ADDRESS')).trim().toLowerCase()
  // Needs Gmail read and Drive read; a separate variable keeps the existing GMAIL_CREDENTIALS_JSON untouched.
  const ownCreds = await optional('KMS_INTAKE_GOOGLE_CREDENTIALS_JSON')
  const credsName = ownCreds ? 'KMS_INTAKE_GOOGLE_CREDENTIALS_JSON' : 'GMAIL_CREDENTIALS_JSON'
  const googleCreds = ownCreds || (await variable('GMAIL_CREDENTIALS_JSON'))
  // {"name@beforest.co": "leader", ...}; any other address in KMS_ALLOWED_DOMAINS is Team (employee).
  const senderLevels = parseSenderLevels(await optional('KMS_SENDER_LEVELS'))
  const allowedDomains = ((await optional('KMS_ALLOWED_DOMAINS')) || 'beforest.co').toLowerCase().split(',').map((d) => d.trim()).filter(Boolean)
  const maxBytes = (Number(await optional('DROPBOX_MAX_FILE_SIZE_MB')) || 100) * 1024 * 1024
  const sql = postgres(await variable('DATABASE_URL'), { max: 1 })
  const g = await googleToken(googleCreds, credsName)
  const smtpPort = Number((await optional('SMTP_PORT')) || 587)
  const mailer = nodemailer.createTransport({
    host: await variable('SMTP_HOST'), port: smtpPort, secure: ((await optional('SMTP_SECURE')) || String(smtpPort === 465)) === 'true',
    auth: { user: await variable('SMTP_USER'), pass: await variable('SMTP_PASSWORD') },
  })
  const smtpFrom = await variable('SMTP_FROM')
  let dbx: string | null = null
  const dropbox = async () => (dbx ??= await dropboxToken(await variable('DROPBOX_APP_KEY'), await variable('DROPBOX_APP_SECRET'), await variable('DROPBOX_REFRESH_TOKEN')))

  const levelOf = (email: string) => {
    const level = senderLevels[email]
    if (level && LEVEL_FOLDER[level]) return level
    return allowedDomains.includes(email.split('@')[1] || '') ? 'employee' : null
  }
  const reply = async (to: string, inReplyTo: string, subject: string, lines: string[]) => {
    if (dry_run) return null
    const sent = await mailer.sendMail({ from: smtpFrom, to, replyTo: intake, subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`, inReplyTo, references: inReplyTo, text: [...lines, '', 'Beforest AI'].join('\n') })
    return String(sent?.messageId || '') || null
  }
  const departmentHelp = ['Departments: ' + DEPARTMENTS.map((d) => d.name).join(', ') + '.', 'Short names work too, for example HR, Finance, BI, CDS, Ops.']

  await sql`
    CREATE TABLE IF NOT EXISTS kms_inbox_intake (
      gmail_message_id TEXT PRIMARY KEY,
      thread_id TEXT, kind TEXT, sender_email TEXT, level TEXT, department TEXT,
      status TEXT NOT NULL,           -- waiting_department | pending | added | duplicate | failed | ignored
      files JSONB NOT NULL DEFAULT '[]'::jsonb, detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  await sql`ALTER TABLE kms_inbox_intake ADD COLUMN IF NOT EXISTS question_message_id TEXT`

  const report: Array<Record<string, unknown>> = []
  try {
    const query = encodeURIComponent(`to:${intake} newer_than:${LOOKBACK_DAYS}d`)
    const listed = await gmail(g, `/messages?maxResults=${max_messages}&q=${query}`)
    for (const { id } of (listed.messages || []).reverse()) {
      const seen = await sql`SELECT status FROM kms_inbox_intake WHERE gmail_message_id = ${id}`
      if (seen.length) continue
      const message = await gmail(g, `/messages/${id}?format=full`)
      const payload: Part = message.payload || {}
      const subject = header(payload, 'Subject')
      const messageId = header(payload, 'Message-ID')
      const fromHeader = header(payload, 'From')
      const fromAddress = address(fromHeader)
      if (fromAddress === intake) continue // our own replies
      const text = plainText(payload)
      const lines = ownLines(text)

      // What was sent: attachments, or a Google share notification.
      const files: Found[] = []
      let kind = 'other'
      let sender = fromAddress
      for (const part of walk(payload)) {
        const ext = part.filename?.split('.').pop()?.toLowerCase() || ''
        if (part.filename && part.body?.attachmentId && FILE_TYPES.has(ext)) {
          kind = 'attachment'
          const attachmentId = part.body.attachmentId
          files.push({ name: safeName(part.filename), size: part.body.size, fetch: async () => Buffer.from((await gmail(g, `/messages/${id}/attachments/${attachmentId}`)).data, 'base64url') })
        }
      }
      const shared = files.length === 0 && /drive-shares.*noreply@google\.com/i.test(fromAddress) ? sharedFileId(text) : null
      if (shared) {
        kind = 'share'
        sender = address(header(payload, 'Reply-To'))
        const meta = await google(g, `https://www.googleapis.com/drive/v3/files/${shared}?fields=name,mimeType,size&supportsAllDrives=true`)
        const exported = EXPORTS[meta.mimeType]
        const ext = exported?.ext || String(meta.name).split('.').pop()?.toLowerCase() || ''
        if (exported || FILE_TYPES.has(ext)) {
          const name = safeName(exported ? `${meta.name}.${exported.ext}` : meta.name)
          files.push({
            name, size: meta.size ? Number(meta.size) : undefined,
            fetch: () => google(g, exported
              ? `https://www.googleapis.com/drive/v3/files/${shared}/export?mimeType=${encodeURIComponent(exported.mime)}`
              : `https://www.googleapis.com/drive/v3/files/${shared}?alt=media&supportsAllDrives=true`, true),
          })
        }
      }

      const level = sender ? levelOf(sender) : null
      // A reply to "which department?": the latest waiting submission from the same person.
      if (files.length === 0 && level && kind !== 'share') {
        // Which question is this a reply to? The question's Message-ID, then the Gmail thread,
        // then (only if the person has exactly one open question) that one. Never a guess between two.
        const refs = `${header(payload, 'In-Reply-To')} ${header(payload, 'References')}`
        const open = await sql`SELECT gmail_message_id, thread_id, question_message_id FROM kms_inbox_intake WHERE sender_email = ${sender} AND status = 'waiting_department' ORDER BY created_at DESC`
        const byQuestion = open.filter((row) => row.question_message_id && refs.includes(String(row.question_message_id).replace(/^<|>$/g, '')))
        const byThread = open.filter((row) => row.thread_id === message.threadId)
        const waiting = byQuestion.length === 1 ? byQuestion : byThread.length === 1 ? byThread : open.length === 1 ? open : []
        const department = departmentFrom(lines)
        if (open.length && !waiting.length) {
          report.push({ id, kind: 'reply', sender, status: 'ignored', reason: 'reply could not be matched to one question' })
          if (!dry_run) await sql`INSERT INTO kms_inbox_intake (gmail_message_id, thread_id, kind, sender_email, status, detail) VALUES (${id}, ${message.threadId}, 'reply', ${sender}, 'ignored', 'reply could not be matched to one question')`
          continue
        }
        if (waiting.length && department) {
          report.push({ id, kind: 'reply', sender, department, for: waiting[0].gmail_message_id, status: dry_run ? 'would add' : 'adding' })
          if (dry_run) continue
          await sql`UPDATE kms_inbox_intake SET department = ${department}, status = 'pending', updated_at = NOW() WHERE gmail_message_id = ${waiting[0].gmail_message_id}`
          await sql`INSERT INTO kms_inbox_intake (gmail_message_id, thread_id, kind, sender_email, status, detail) VALUES (${id}, ${message.threadId}, 'reply', ${sender}, 'ignored', ${'department reply for ' + waiting[0].gmail_message_id})`
          await addSubmission(waiting[0].gmail_message_id)
          continue
        }
      }
      if (files.length === 0 || !level) {
        // Not a submission, or not from a Beforest address: record it and do nothing else.
        if (!dry_run) await sql`INSERT INTO kms_inbox_intake (gmail_message_id, thread_id, kind, sender_email, status, detail) VALUES (${id}, ${message.threadId}, ${kind}, ${sender || fromAddress}, 'ignored', ${files.length ? 'sender not allowed' : 'no supported file'})`
        report.push({ id, kind, sender, status: 'ignored', reason: files.length ? 'sender not allowed' : 'no supported file' })
        continue
      }

      const department = departmentFrom([subject.replace(/^(re|fwd?):\s*/i, ''), ...lines])
      const record = { id, threadId: message.threadId, kind, sender, level, subject, messageId, files }
      pendingFiles.set(id, record)
      if (!department) {
        report.push({ id, kind, sender, level: LEVEL_FOLDER[level], files: files.map((f) => f.name), status: 'waiting_department' })
        if (dry_run) continue
        await sql`INSERT INTO kms_inbox_intake (gmail_message_id, thread_id, kind, sender_email, level, status, files) VALUES (${id}, ${message.threadId}, ${kind}, ${sender}, ${level}, 'waiting_department', ${JSON.stringify(files.map((f) => f.name))}::jsonb)`
        const question = await reply(sender, messageId, subject || 'Your KMS document', [
          `Thanks. Which department should ${files.map((f) => `"${f.name}"`).join(', ')} go to?`,
          `It will be added to ${LEVEL_FOLDER[level]} / <department>.`,
          'Just reply to this email with the department name, for example: HR',
          '', ...departmentHelp,
        ])
        await sql`UPDATE kms_inbox_intake SET question_message_id = ${question} WHERE gmail_message_id = ${id}`
        continue
      }
      report.push({ id, kind, sender, level: LEVEL_FOLDER[level], department, files: files.map((f) => f.name), status: dry_run ? 'would add' : 'adding' })
      if (dry_run) continue
      await sql`INSERT INTO kms_inbox_intake (gmail_message_id, thread_id, kind, sender_email, level, department, status, files) VALUES (${id}, ${message.threadId}, ${kind}, ${sender}, ${level}, ${department}, 'pending', ${JSON.stringify(files.map((f) => f.name))}::jsonb)`
      await addSubmission(id)
    }
    return { dry_run, handled: report.length, report }
  } finally {
    await sql.end({ timeout: 5 })
  }

  // Adds the files of one submission whose department is known, starts indexing and replies.
  async function addSubmission(messageId: string) {
    const [row] = await sql`SELECT * FROM kms_inbox_intake WHERE gmail_message_id = ${messageId}`
    let record = pendingFiles.get(messageId)
    if (!record) {
      // A submission from an earlier run (waiting for its department): read it again.
      const message = await gmail(g, `/messages/${messageId}?format=full`)
      record = await rebuild(messageId, message, row)
    }
    const folder = `/${LEVEL_FOLDER[row.level]}/${row.department}`
    const added: string[] = []
    const skipped: string[] = []
    try {
      for (const file of record.files) {
        const bytes = await file.fetch()
        if (bytes.length > maxBytes) { skipped.push(`${file.name} (larger than ${Math.round(maxBytes / 1048576)} MB)`); continue }
        const saved = await addToDropbox(await dropbox(), folder, file.name, bytes)
        if (saved.duplicate) { skipped.push(`${saved.name} (already in the KMS)`); continue }
        await JobService.runFlowByPath({
          workspace: WORKSPACE, path: PIPELINE,
          requestBody: {
            event_type: 'approved_document_uploaded', approval_status: 'approved',
            dropbox_file_id: saved.id, dropbox_revision: saved.rev, dropbox_path: `${ROOT}${saved.path}`,
            file_name: saved.name, file_size_bytes: bytes.length, uploaded_by: row.sender_email,
          },
        })
        added.push(saved.name)
      }
      const status = added.length ? 'added' : 'duplicate'
      await sql`UPDATE kms_inbox_intake SET status = ${status}, files = ${JSON.stringify({ added, skipped })}::jsonb, updated_at = NOW() WHERE gmail_message_id = ${messageId}`
      await reply(row.sender_email, record.messageId, record.subject || 'Your KMS document', [
        ...(added.length ? [`Added to ${LEVEL_FOLDER[row.level]} / ${row.department}:`, ...added.map((n) => `- ${n}`), '', 'Indexing has started. It will be searchable in Claude in a few minutes.'] : []),
        ...(skipped.length ? ['', 'Not added:', ...skipped.map((n) => `- ${n}`)] : []),
      ])
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await sql`UPDATE kms_inbox_intake SET status = 'failed', detail = ${detail}, files = ${JSON.stringify({ added, skipped })}::jsonb, updated_at = NOW() WHERE gmail_message_id = ${messageId}`
      await reply(row.sender_email, record.messageId, record.subject || 'Your KMS document', [
        'Sorry, your document could not be added right now. The KMS team has been notified and will add it.',
        ...(added.length ? ['', 'Already added:', ...added.map((n) => `- ${n}`)] : []),
      ])
    }
  }

  async function rebuild(messageId: string, message: { payload: Part }, row: { kind: string }) {
    const payload = message.payload
    const files: Found[] = []
    for (const part of walk(payload)) {
      const ext = part.filename?.split('.').pop()?.toLowerCase() || ''
      if (row.kind === 'attachment' && part.filename && part.body?.attachmentId && FILE_TYPES.has(ext)) {
        const attachmentId = part.body.attachmentId
        files.push({ name: safeName(part.filename), fetch: async () => Buffer.from((await gmail(g, `/messages/${messageId}/attachments/${attachmentId}`)).data, 'base64url') })
      }
    }
    if (row.kind === 'share') {
      const shared = sharedFileId(plainText(payload))!
      const meta = await google(g, `https://www.googleapis.com/drive/v3/files/${shared}?fields=name,mimeType&supportsAllDrives=true`)
      const exported = EXPORTS[meta.mimeType]
      files.push({
        name: safeName(exported ? `${meta.name}.${exported.ext}` : meta.name),
        fetch: () => google(g, exported
          ? `https://www.googleapis.com/drive/v3/files/${shared}/export?mimeType=${encodeURIComponent(exported.mime)}`
          : `https://www.googleapis.com/drive/v3/files/${shared}?alt=media&supportsAllDrives=true`, true),
      })
    }
    return { files, subject: header(payload, 'Subject'), messageId: header(payload, 'Message-ID') }
  }
}

const pendingFiles = new Map<string, { files: Found[]; subject: string; messageId: string }>()
