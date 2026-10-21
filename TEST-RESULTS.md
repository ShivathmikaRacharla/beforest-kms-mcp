# Local build and test results

## Nixpacks preparation update

Added nixpacks.toml (Node 22, locked production dependency installation, npm start),
.dockerignore, private container networking configuration, and Coolify setup guide.
All 10 automated tests passed after this change, including official MCP client
calls, 0.0.0.0 binding, explicit hostname configuration, rejected unapproved hosts,
spoofed forwarding headers and browser origins. JavaScript syntax checks passed.
The existing KMS Git working-tree status remained unchanged.

Docker and Nixpacks executables are not available in this environment, so no
Nixpacks image build was performed. No Coolify deployment, GitHub push or Windmill
script modification occurred. The live search result below is the earlier local
integration check; it was not repeated for this networking-only update.

Verified on 21 October 2026.

## Built

- Standalone wrapper in local `f/kms/windmill-mcp`.
- One MCP tool: `search_knowledge`.
- Stateless Streamable HTTP endpoint `/mcp`, loopback-only listener.
- Server-side call to existing `f/kms/retrieve_qdrant_chunks` Windmill script.
- Required question, optional department filter, limit 1–20 (default 5).
- Returns chunk text, score, file name, Dropbox path, page and section.
- No generated final answer: the connected AI uses the returned evidence.

## Verification

All 7 automated tests passed. Includes an official SDK client performing MCP
initialization, tool discovery and tool calls against the actual local HTTP server.
Also verifies input rejection before backend calls, source formatting, empty results,
backend failure redaction, timeout handling and local Host/Origin restrictions.

Real end-to-end test passed through local MCP -> existing Windmill -> Gemini/Qdrant.
Question: "What is Beforest?"; limit: 3. Returned 3 passages, all containing text,
numeric scores, file names and Dropbox paths. Upstream reported 26 documents.
Tool-call duration was 1,471 ms for this single request, not a performance benchmark.
Test server stopped after verification. Credentials were read from the existing
application .env without editing or copying it into the wrapper.

## Scope

No existing application files, database schemas, deployed Windmill scripts or Coolify
resources changed. Dependencies and lockfile are isolated to this folder. The live
search creates a normal Windmill execution record and uses Gemini embedding quota.

Authentication, remote deployment, AI chat application compatibility and a future
list_documents tool remain outside this local build. No public endpoint exists.
