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

## Authentication

`/mcp` requires `Authorization: Bearer <secret>` whenever `MCP_AUTH_TOKENS` is set,
and the server refuses to start with `HOST=0.0.0.0` unless it is. Generate a secret with
`openssl rand -hex 32` (at least 32 characters). To rotate, set `old,new`, move clients to
`new`, then remove `old`. Wrong or missing secrets get 401 before the body is parsed.
`/health` stays open. Local-only mode (127.0.0.1) without a secret stays open for development.

This is one shared secret, not per-user sign-in: anyone holding it sees every document.
Role-based access needs per-user identity (OAuth) and is the next step.

Client examples:

```
claude mcp add --transport http beforest-knowledge https://kms-mcp.ops.beforest.co/mcp --header "Authorization: Bearer $KMS_MCP_TOKEN"
```

Claude Desktop (via `mcp-remote`): `npx mcp-remote https://kms-mcp.ops.beforest.co/mcp --header "Authorization:Bearer ${KMS_MCP_TOKEN}"`.

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
- Shared-secret bearer authentication (see above). Listener defaults to 127.0.0.1.
  Optional HOST=0.0.0.0 enables private container networking and requires explicit
  MCP_ALLOWED_HOSTS. Browser Origin and unrecognized Host headers are rejected.
- Department is a search filter, not permission enforcement.
- No full document-list tool is exposed. Upstream document listings are omitted
  from search responses; a dedicated listing tool can be added later.
- Page and section can be null when upstream metadata is unavailable.
- Compatibility with Claude, ChatGPT and Grok is not yet tested.
- Nixpacks configuration and private Coolify setup steps are in
  [COOLIFY-NIXPACKS.md](COOLIFY-NIXPACKS.md). No Dockerfile is needed.
- Host checks are not authentication; the bearer secret is. Per-user roles are not yet enforced.
