# Foundry Codex Bridge Architecture

This document is the zoomed-out map of how the bridge is put together. Use it when you need to understand where a behavior belongs before changing code or writing docs.

## One Sentence

Foundry Codex Bridge is a local MCP-to-Foundry control path: an MCP client calls a local Node adapter, the adapter talks to a localhost daemon, the daemon routes trusted live-world requests to a GM-owned Foundry module connection, and the module executes through live Foundry APIs.

## Runtime Pieces

### MCP Adapter: `src/mcp.js`

`src/mcp.js` is the stdio MCP server exposed to Codex and other MCP clients.

It:

- reads `CODEX_FOUNDRY_BRIDGE_TOKEN` from the process environment or Windows user environment
- starts or contacts the local daemon when needed
- registers public tools from `src/tool-registry.js`
- exposes onboarding resources such as `foundry://bridge/quickstart`
- exposes the `foundry_bridge_first_contact` prompt
- forwards tool calls to the daemon instead of talking to Foundry directly

### Local Daemon: `src/server.js`

`src/server.js` is the localhost authority boundary.

It:

- hosts HTTP `/call` for MCP and local automation callers
- hosts WebSocket `/foundry` for Foundry module clients
- requires the bridge token for daemon calls
- tracks pending and trusted Foundry worlds
- dispatches methods through the shared registry
- redacts sensitive output
- writes backups for backup-first destructive paths
- manages lifecycle restart support and Windows Credential Manager status/write requests

The daemon is the part that decides whether a request can run locally, whether it requires a trusted GM session, and which connected Foundry client should receive it.

### Foundry Module: `module/`

`module/` is the Foundry VTT add-on module that users install into Foundry data.

Important files:

- `module/module.json`: Foundry module manifest, version, compatibility, release URLs, and script entry
- `module/scripts/bridge.js`: browser-side bridge code loaded inside an opened Foundry world

The module runs inside the Foundry game view, not the Setup or Join pages. It connects back to the local daemon only after Foundry has loaded a world. Live-world tools require a GM client and explicit trusted-world authorization.

### Shared Registry: `src/tool-registry.js`

`src/tool-registry.js` is the public capability source of truth.

It drives:

- MCP tool registration
- daemon method validation
- `list_bridge_tools`
- `call_bridge_tool` fallback eligibility
- risk/read-only/trusted-session metadata
- examples for complex tool calls
- `docs/bridge-capabilities.json`
- manifest and smoke tests

When adding or changing a tool, update the registry first, then adjust daemon/module handling and tests around that registry entry.

### Generated Manifest: `docs/bridge-capabilities.json`

`docs/bridge-capabilities.json` is generated from `src/tool-registry.js` by `scripts/generate-capability-manifest.mjs`.

It records:

- bridge version
- registry version
- checksum
- fallback tool name
- tool count
- public metadata for each registered tool

Regenerate it with `npm run manifest` and verify drift with:

```powershell
node scripts\generate-capability-manifest.mjs --check
```

### Scripts: `scripts/`

`scripts/` contains local setup, packaging, and maintenance helpers.

Common scripts:

- `new-token.ps1`: creates a Windows user `CODEX_FOUNDRY_BRIDGE_TOKEN`
- `copy-token-to-clipboard.ps1`: copies that token for Foundry module setup
- `start-daemon.ps1`: starts the localhost daemon
- `install-module.ps1`: copies `module/` into the local Foundry data folder for development
- `set-lifecycle-credentials.ps1`: stores non-secret lifecycle config and Windows Credential Manager secrets
- `enable-world-module-offline.ps1`: emergency offline module enable helper for an explicit world id
- `generate-capability-manifest.mjs`: regenerates the public capability manifest
- `package-release.ps1`: builds the flat Foundry module release zip

## Request Flow

Typical direct MCP call:

```text
Codex or MCP client
  -> MCP stdio server (`src/mcp.js`)
  -> localhost daemon HTTP `/call` (`src/server.js`)
  -> registry validation (`src/tool-registry.js`)
  -> trusted GM WebSocket `/foundry` when live Foundry state is required
  -> module request handler (`module/scripts/bridge.js`)
  -> live Foundry API
  -> redacted response back through daemon and MCP
```

`call_bridge_tool` uses the same daemon dispatch path. It is an exposure fallback, not a second authorization system and not a privilege bypass.

## Trusted-World Flow

The trust model is intentionally layered:

1. A caller must know the local `CODEX_FOUNDRY_BRIDGE_TOKEN` to use daemon `/call`.
2. A Foundry client must load a world with the module enabled.
3. The module must connect from a GM client.
4. The GM must authorize the current world.
5. Trusted-session tools can run only through that connected trusted GM session.

Tools that do not need live Foundry state, such as `bridge_self_check`, `list_bridge_tools`, and `get_bridge_quickstart`, can run before a world is trusted. Tools that inspect or mutate live world state report missing trusted-session prerequisites instead of silently doing partial work.

## Write Safety

The bridge has both low-level and high-level write paths.

Preferred high-level writes use:

- `plan_journal_changes`
- `plan_scene_changes`
- `plan_document_changes`
- `plan_chat_messages`
- `apply_bridge_plan`

Planning tools are read-only. Applying a plan requires matching `planId`, `planHash`, and `worldId`. Existing-document updates and destructive operations create backup metadata before mutation where supported.

Raw scripting remains available through `run_gm_script`, but it requires a trusted GM session and `dangerous=true`. It is intended as an emergency escape hatch, not the normal workflow.

## Lifecycle Restart

`restart_foundry_world` belongs to the local daemon/lifecycle layer, not the live-world tool layer. Closing Foundry destroys the current GM WebSocket, so the tool is responsible for recreating the visible Foundry app session and a managed bridge GM client.

On Windows, lifecycle restart can:

- snapshot and restore the visible Foundry Electron window state
- use Windows Credential Manager targets for admin and per-world GM credentials
- launch an explicit world id
- join as the configured GM user
- verify `bridge_self_check.ready=true`
- restore the prior pause state when it was captured from a trusted same-world session

This workflow is always explicit-danger: it requires `dangerous=true` and an explicit `worldId`.

## Foundry Module Packaging

The public release asset is a flat Foundry module zip. The archive root contains:

```text
module.json
scripts/bridge.js
```

Build it with:

```powershell
npm run package:release
```

Normal Foundry users install through:

```text
https://github.com/SpencerZPoole/codex-foundry-bridge/releases/latest/download/module.json
```

Developers can install from the checkout with:

```powershell
npm run install:module
```

## Where Future Changes Belong

- MCP resources, prompts, and direct tool exposure: `src/mcp.js` and `src/agent-bootstrap.js`
- Tool metadata and public capability shape: `src/tool-registry.js`
- Daemon-local behavior, trust gates, backups, redaction, dispatch, lifecycle: `src/server.js` and `src/lifecycle.js`
- Live Foundry API behavior: `module/scripts/bridge.js`
- Capability manifest generation: `scripts/generate-capability-manifest.mjs`
- Release packaging: `scripts/package-release.ps1`
- Agent-facing onboarding: `docs/AGENT_QUICKSTART.md` and README
- Public roadmap and release discipline: `docs/V1_RELEASE_AUDIT_AND_PLAN.md`
