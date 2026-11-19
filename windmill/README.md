# KMS inbox intake (Windmill) — deployed 19 Nov 2026, every 10 minutes

`kms_inbox_intake.ts` becomes `f/kms/kms_inbox_intake` in the `beforest-automations` workspace, run every
10 minutes. It reads `beforestai@gmail.com` and adds documents that arrive in two ways:

| Way in | What the person does | What is added |
|---|---|---|
| Email | Sends the file as an attachment; types the department in the subject (e.g. `HR`) | The attachment (PDF, DOCX, PPTX, XLSX, TXT, MD) |
| Google share | Shares a Sheet / Doc / Slides / Drive file with the inbox, "Notify people" ticked, department in the message box | An export: Sheet `.xlsx`, Doc `.docx`, Slides `.pptx` (Drive exports up to 10 MB); other Drive files as they are |

Then: level from the sender's email (`KMS_SENDER_LEVELS`, else Team for `KMS_ALLOWED_DOMAINS`) → department
(short names and typos accepted, same matcher as the MCP) → Dropbox `<Level>/<Department>/` (never overwritten;
an identical copy is skipped) → `f/kms/process_approved_document_pipeline` with the Dropbox file id → reply email.
If the department is unclear, the sender is asked and simply replies with it.

Nothing existing changes: emails are not marked read or moved (the manual check still works), and the pipeline,
retrieval and the Dropbox → Windmill handoff are untouched. `acknowledge_incoming_email` stays switched off.
State is kept in the Postgres table `kms_inbox_intake` (created on first run).

## Variables (`f/kms/…`)

| Variable | New? | Value |
|---|---|---|
| `GMAIL_INTAKE_ADDRESS`, `DATABASE_URL`, `SMTP_*`, `DROPBOX_*`, `DROPBOX_MAX_FILE_SIZE_MB` | existing | unchanged |
| `KMS_INTAKE_GOOGLE_CREDENTIALS_JSON` | new (secret) | OAuth JSON (`client_id`, `client_secret`, `refresh_token`) for beforestai@gmail.com with scopes `gmail.readonly` and `drive.readonly`. If empty, `GMAIL_CREDENTIALS_JSON` is used (Google shares then fail without Drive access). |
| `KMS_SENDER_LEVELS` | new | JSON of people above Team, e.g. `{"name@beforest.co":"leader","ceo@beforest.co":"oceo"}` |
| `KMS_ALLOWED_DOMAINS` | new, optional | `beforest.co` (default). Senders outside these domains are ignored, with no reply. |

## Rollout

1. Create the script and variables. Do not schedule yet.
2. Phase 0: send one test email and one test share, then run with `dry_run = true`. It only reads and reports
   (kind, sender, level, department, files). Check that the share message reached the email and that the
   sender (Reply-To) is right.
3. Run once with `dry_run = false` and check Dropbox, the pipeline run and the reply email.
4. Add the 10-minute schedule.
