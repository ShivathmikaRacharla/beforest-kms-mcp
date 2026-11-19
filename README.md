# Beforest knowledge MCP wrapper

Standalone service exposing `search_knowledge(question, department?, limit=5)` over
Streamable HTTP. Calls only `f/kms/retrieve_qdrant_chunks` in the configured Windmill
workspace. Returns passages, scores and source locations as text JSON and structured
content. The connected AI generates the answer. No uploads or writes to Qdrant.
Windmill does record search jobs and Gemini usage may incur costs.

## Local setup (Node 22 or later)

Run commands from this folder. On Windows use `npm.cmd` if PowerShell blocks npm.ps1.

```
npm.cmd ci --cache .npm-cache
npm.cmd test
```

Set `WINDMILL_BASE_URL`, `WINDMILL_WORKSPACE`, `WINDMILL_TOKEN` in the process
environment, then run `npm.cmd start`. `.env.example` documents the settings; no
credentials are committed. Alternatively Node can load a separately configured
environment file: `node --env-file=.env src/server.mjs`.

By default the endpoint is `http://127.0.0.1:3100/mcp`; `GET /health` checks liveness only.
Uses stateless HTTP JSON responses. GET and DELETE on /mcp return 405 by design.
Official SDK v1.32.1 is pinned; this is the supported v1 maintenance line.

## Authentication and levels

`/mcp` requires `Authorization: Bearer <token>`. Each person gets their own token in
`MCP_USERS`, comma-separated `name:level:token` entries:

```
MCP_USERS=harsha:oceo:<token>,seshu:employee:<token>
```

Levels, lowest first: `employee`, `leader`, `oceo` (Office of the CEO). A person sees
passages at or below their level. Generate each token with `openssl rand -hex 32`
(at least 32 characters). To switch someone off, delete their entry; to move them, change
their level. Both take effect on redeploy. Each search logs one JSON line with the person's
name, level and how many passages were returned or hidden (never the question).

A passage's level is the stricter of:
- its Dropbox level folder anywhere in `dropbox_path`: `Office of the CEO` = oceo,
  `Leadership` or `Confidential` = leader, `Team` = employee (case-insensitive), and
- its `min_role` field, once `retrieve_qdrant_chunks` returns one.

A passage with neither is treated as `oceo`, so unsorted or misfiled documents start closed.
Below full access the server asks Windmill for up to 4x the limit (max 20), filters, then
trims to the limit, and hides the total document count.

`MCP_AUTH_TOKENS` (legacy shared secrets) still works and gives full access under the name
`shared`; remove it once everyone has their own token. The server refuses to start with
`HOST=0.0.0.0` unless `MCP_USERS` or `MCP_AUTH_TOKENS` is set. Wrong or missing tokens get
401 before the body is parsed. `/health` stays open. Local-only mode (127.0.0.1) without
tokens stays open for development, with full access.

Client examples:

```
claude mcp add --transport http beforest-knowledge https://kms-mcp.ops.beforest.co/mcp --header "Authorization: Bearer $KMS_MCP_TOKEN"
```

Claude Desktop (via `mcp-remote`): `npx mcp-remote https://kms-mcp.ops.beforest.co/mcp --header "Authorization:Bearer ${KMS_MCP_TOKEN}"`.

## Listing documents (`list_documents`)

`search_knowledge` returns only the passages closest to a question, so it cannot count or list documents.
`list_documents` is the catalogue: every document the caller's level may see, with the total and the
count per knowledge space (optional `space` filter). It reads the Dropbox folder names (read-only) with
the same level rule as search: Team -> everyone, Leadership -> leaders and up, Office of the CEO and
anything outside a level folder -> Office of the CEO only. Names and counts above the caller's level are
never returned. The listing is cached for 5 minutes. Files added in the last 5 minutes are marked
`just_added` (they may still be processing).

On when `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET` and `DROPBOX_REFRESH_TOKEN` are set (the KMS Dropbox app,
app folder `KMS-Documents (1)`; listing needs only read access).

## Opening a document (`get_document_link`)

For "open / view / download this document". Takes the exact file name from `list_documents` or a search
result (a full Dropbox path also works) and returns two links on this server:

- `view_link` (`/doc/<token>`): shows the file in the browser. PDF, TXT, MD and images are shown as they
  are. Word, PowerPoint and Excel files (.doc/.docx/.rtf/.odt, .ppt/.pptx/.odp, .xls/.xlsx/.ods) are shown
  as Dropbox's own preview (`files/get_preview`: a PDF, or an HTML table for spreadsheets, shown sandboxed).
  `null` for other types (for example .zip or .csv), which are download only.
- `download_link` (`/doc/<token>?download=1`): always saves the original file.

If Dropbox cannot make a preview, View answers with a plain message (503 "still preparing", 415 "not
available") pointing to the Download link. The server streams from Dropbox (read-only, the same permission
as before); the Dropbox address is never shown. Each link is
signed, lasts 4 hours, and is checked again when opened: the person who asked must still have a key whose
level allows the document. A document above the caller's level gets the same "not available" message as a
missing one, so its existence is not revealed. The signing key is derived from `DROPBOX_APP_SECRET`, so no
extra setting is needed; changing that secret invalidates open links. Links are logged (`event: link`), and
so are opens (`event: view` / `download`).

## Adding a document (`list_departments`, `upload_document`)

1. `list_departments` returns the 10 departments and the level the file will go to. The level is always the
   person's own level from their key (Team, Leadership or Office of the CEO); it cannot be changed. Claude
   asks the person to choose a department and never picks one from the document's content.
2. `upload_document(department)` accepts short names and small typos (`hr`, `fin`, `Finanace`, `BI`,
   "Team / HR"). Unclear text is refused with the list of departments, never guessed. It returns a private
   upload page link (`/upload#<signed token>`), valid once for 4 hours.
3. On the page the person picks the file: PDF, DOCX, PPTX, XLSX, TXT or MD, up to `UPLOAD_MAX_MB` (150).
   The real file type is checked. The file keeps its own name in `<Level>/<Department>/`; an existing file
   is never overwritten (`name (2).pdf` instead).
4. The server then starts the existing pipeline `f/kms/process_approved_document_pipeline` with the Dropbox
   **file id**, revision, full path and size (`approval_status: approved`, as uploads have no approver).
   The page shows the file name, folder, Dropbox destination and whether indexing started.

Both tools are on only when the Dropbox settings and `WINDMILL_WEBHOOK_URL` / `WINDMILL_WEBHOOK_TOKEN` are
set. Upload links are signed with a key derived from `DROPBOX_APP_SECRET`. Each link, upload and indexing
start is logged (`event: upload_link`, `upload`). If indexing cannot start, the file stays saved and the log
has its Dropbox file id so it can be started again.

## Tests

`npm.cmd test` uses fake backend responses: no live secrets or external calls.
Tests include official MCP client initialization, tool discovery and calls,
source formatting, invalid inputs, empty results, upstream errors and timeouts.

An opt-in real search test starts a temporary loopback server, connects an official
MCP client, discovers tools and asks "What is Beforest?" with limit 3, then stops
the server. Set the three Windmill variables and run `npm.cmd run test:live`.
For this workspace only, existing `.env` may instead be read without modification:

```powershell
$env:KMS_ENV_FILE = '../../../beforest knowledge assistant/.env'
npm.cmd run test:live
```

## Scope and limitations

- All new files, lockfile, dependencies and project npm cache are in this folder.
- Existing application files and deployed Windmill scripts are not changed.
- Per-person bearer tokens with levels (see above). Listener defaults to 127.0.0.1.
  Optional HOST=0.0.0.0 enables private container networking and requires explicit
  MCP_ALLOWED_HOSTS. Browser Origin and unrecognized Host headers are rejected.
- Department is a search filter, not permission enforcement.
- No full document-list tool is exposed. Upstream document listings are omitted
  from search responses; a dedicated listing tool can be added later.
- Page and section can be null when upstream metadata is unavailable.
- Compatibility with Claude, ChatGPT and Grok is not yet tested.
- Nixpacks configuration and private Coolify setup steps are in
  [COOLIFY-NIXPACKS.md](COOLIFY-NIXPACKS.md). No Dockerfile is needed.
- Host checks are not authentication; the bearer token is.
- Claude.ai custom connectors need OAuth and cannot send a bearer token; use Claude Code or Claude Desktop.
