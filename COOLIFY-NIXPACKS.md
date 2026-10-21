# Nixpacks preparation (not deployed)

Upload the contents of this wrapper folder at the ROOT of the separate
`beforest-kms-mcp` repository. Include package-lock.json, nixpacks.toml, src,
package.json and instructions. Do not upload node_modules, .npm-cache, real .env
files or credentials. No existing KMS repository or Windmill change is required.

## New resource inside the existing KMS project

1. Use the separate MCP repository and main branch. Build pack: Nixpacks.
2. Base directory: `/` when package.json is at repository root. Output: web app,
   not static. nixpacks.toml selects Node 22, installs using
   `npm ci --omit=dev --no-audit --no-fund`, and starts using `npm start`.
   There is no compilation/build command; leave the build override empty.
3. Set runtime variables (not build-time secrets):

| Variable | Value |
| --- | --- |
| WINDMILL_BASE_URL | Existing reachable Windmill base URL |
| WINDMILL_WORKSPACE | beforest-automations |
| WINDMILL_TOKEN | Token permitted to run the retrieval script |
| WINDMILL_TIMEOUT_MS | 30000 |
| NODE_ENV | production |
| PORT | 3100 |
| HOST | 0.0.0.0 |
| MCP_ALLOWED_HOSTS | Exact hostname(s) the proxy/private client uses, comma-separated |

MCP_ALLOWED_HOSTS entries have no scheme, port or path. Localhost and 127.0.0.1
are always permitted for internal health checks. The proxy must preserve an
allowed Host header. Forwarded host headers are not trusted. Browser Origin
headers remain rejected; remote server-to-server MCP clients do not need CORS.

4. Set Ports Exposes to 3100. No public host-port mapping or persistent volume.
   Health check: HTTP GET `/health`, port 3100, expected status 200. This checks
   process liveness, not Windmill credentials or availability.
5. Authentication is deferred. Before any private deployment, confirm ingress is
   private and disable/remove any automatically assigned public domain. Being in
   the KMS project or omitting a custom domain alone does not establish privacy.
   Do not add a public domain/tunnel until authentication is implemented.
6. After separate approval, deploy this new resource only. Check health and use
   an MCP client on the private network to initialize, list tools, and call
   search_knowledge. Its endpoint is `/mcp`. A browser GET returning 405 is normal.

The hostname allowlist mitigates unwanted Host headers; it does NOT authorize
users. No OAuth, API key authentication or document access controls were added.

## Validation scope

Local tests verify default loopback startup, optional container binding, exact
Host allowlisting, rejection of spoofed forwarding headers and origins, MCP calls
and backend handling. Actual Nixpacks image build/Coolify routing must be verified
in that environment; no claim of a successful image build or deployment is made.

References: https://nixpacks.com/docs/configuration/file and
https://nixpacks.com/docs/providers/node
