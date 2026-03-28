# AGENTS.md

Instructions for AI agents working on this codebase.

## Repository Layout

```
packages/          Protocol stack — 8 independently publishable npm packages
  webrtc/          @agentdance/node-webrtc   — RTCPeerConnection public API
  ice/             @agentdance/node-webrtc-ice
  dtls/            @agentdance/node-webrtc-dtls
  sctp/            @agentdance/node-webrtc-sctp
  srtp/            @agentdance/node-webrtc-srtp
  rtp/             @agentdance/node-webrtc-rtp
  stun/            @agentdance/node-webrtc-stun
  sdp/             @agentdance/node-webrtc-sdp

apps/
  demo-web/        Express + WebSocket signaling server demo
  bench/           500 MB DataChannel throughput benchmark
  mcp/             @agentdance/node-webrtc-mcp — MCP server for agent discovery
  demo-flutter/    Flutter macOS client

features/          Cucumber BDD acceptance tests (living specification)
  webrtc/          peer-connection.feature, dtls-role-interop.feature
  ice/             ice-connectivity.feature
  dtls/            dtls-handshake.feature
  sctp/            sctp-channels.feature
  step_definitions/
```

## Dev Environment

- **Node.js** 18+
- **pnpm** 10+ (not npm, not yarn)

```bash
pnpm install      # install all workspace dependencies
pnpm build        # compile all packages (required before typecheck/test)
pnpm typecheck    # TypeScript strict check (run after build)
pnpm test         # Vitest unit tests across all packages
pnpm test:bdd     # Cucumber BDD acceptance tests (29 scenarios)
pnpm lint         # ESLint 9 + @typescript-eslint
pnpm clean        # remove all dist/ directories
```

> **Always run `pnpm build` before `pnpm typecheck` or `pnpm test:bdd`.**
> The BDD step definitions import from `packages/*/dist/`, not `src/`.

## Key Constraints

- **TypeScript strict mode** with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` — both are intentional and must stay on
- **ESM only** — `"type": "module"` everywhere, no `require()` in `.ts` files
- **Zero native dependencies** — never add packages that require native compilation (`node-gyp`, OpenSSL bindings, etc.)
- **RFC first** — every protocol behavior must be traceable to an RFC section; add inline comments like `// RFC 8445 §6.1.2.3`

## Making Changes

### Adding a feature to a protocol package
1. Write or update the relevant `.feature` file under `features/`
2. Implement in `packages/<pkg>/src/`
3. Write unit tests in `packages/<pkg>/__tests__/`
4. Run `pnpm build && pnpm test && pnpm test:bdd`

### Adding a new package
1. Create `packages/<name>/` with `src/index.ts`, `package.json`, `tsconfig.json`, `vitest.config.ts`
2. Package name must follow the pattern `@agentdance/node-webrtc-<name>`
3. Add to `pnpm-workspace.yaml`

### Changing public API
- `packages/webrtc/src/` is the public surface — mirror the browser `RTCPeerConnection` API
- Do not break existing event names, method signatures, or property names

## Testing Philosophy

- **Unit tests** (`pnpm test`) — cover individual algorithms, codecs, and state machines
- **BDD scenarios** (`pnpm test:bdd`) — cover end-to-end integration across the full stack
- Cryptographic primitives must have RFC test vector coverage (see `packages/srtp/__tests__/` for examples)

## Commit Style

```
<type>(<scope>): <description>

feat(sctp): add partial reliability (maxPacketLifeTime)
fix(ice): handle TSN wrap-around near 2³²
test(dtls): add RFC 5763 §5 role negotiation vectors
chore: bump version to 1.0.4
```

Scopes: `webrtc`, `ice`, `dtls`, `sctp`, `srtp`, `rtp`, `stun`, `sdp`, `mcp`, `ci`

## Publishing

Releases are fully automated via GitHub Actions. To publish a new version:

```bash
# 1. Bump version in all packages
node -e "
  const fs = require('fs');
  const dirs = [...require('fs').readdirSync('packages').map(d=>'packages/'+d), 'apps/mcp'];
  for (const d of dirs) {
    const f = d+'/package.json';
    const p = JSON.parse(fs.readFileSync(f,'utf8'));
    p.version = 'X.Y.Z';
    fs.writeFileSync(f, JSON.stringify(p,null,2)+'\n');
  }
"

# 2. Commit, tag, push — CI handles npm publish + GitHub Release creation
git commit -am "chore: bump version to X.Y.Z"
git push
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

## MCP Server

An MCP server lives at `apps/mcp/`. It allows AI agents to:
- Evaluate this library against alternatives
- Read full API documentation
- Generate ready-to-run code examples

When modifying the MCP server, test it with:
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' \
  | node apps/mcp/dist/index.js
```
