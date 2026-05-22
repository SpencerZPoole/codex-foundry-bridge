# Foundry Codex Bridge

Local-first MCP tooling for safely operating a trusted Foundry VTT GM session from Codex.

Foundry Codex Bridge is a security-conscious bridge between AI coding agents and live Foundry VTT worlds. It is designed for real campaign operations, not just demos: inspect the world, diagnose the bridge, preview changes, apply confirmed plans, restart the local Foundry app, and keep private campaign data behind a trusted GM session gate.

The project direction is **Guarded Power**: expose useful live-world capability while keeping localhost transport, token auth, GM authorization, redaction, explicit high-risk gates, and backup-first behavior in the workflow.

## Highlights

- Shared MCP/daemon tool registry with deterministic capability manifest and checksum.
- Localhost-only daemon with `CODEX_FOUNDRY_BRIDGE_TOKEN` authentication.
- Foundry module connects only from GM clients and requires explicit trusted-world authorization.
- `bridge_self_check` and `list_bridge_tools` report readiness, version, registry, runtime, and tool metadata.
- `call_bridge_tool` fallback keeps registered tools reachable when direct MCP discovery lags.
- Read-only world intelligence for compendiums, actors, scenes, world search, readiness audits, and runtime timeline.
- Preview/apply transactions for journals, scene prep, top-level documents, and chat messages.
- Backup-first destructive document operations.
- Guarded local lifecycle restart that can relaunch Foundry, join an explicit world as GM, preserve visible-window/pause state, and restore bridge readiness.

## Current Status

- Version: `0.2.13`
- Foundry compatibility target: Foundry `14`
- Live validation baseline: Foundry `14.361` with D35E `3.0.2`
- Registered tools: `47`
- Default validation world in this repo's workflow: `scratch`

This is active local tooling. Treat it as power-user software: review the safety model, run tests, and start with a disposable Foundry world before pointing it at anything important.

## Repository Shape

- `src/server.js` runs the localhost daemon and Foundry WebSocket endpoint.
- `src/mcp.js` exposes the MCP stdio adapter.
- `src/tool-registry.js` is the shared tool registry used by MCP, daemon dispatch, docs, and tests.
- `module/` is the Foundry module installed into the local Foundry data folder.
- `docs/bridge-capabilities.json` is generated from the registry.
- `docs/V1_RELEASE_AUDIT_AND_PLAN.md` tracks the v1.0 roadmap.
- `docs/MARKET_POSITIONING_AND_MONETIZATION.md` records public market-positioning notes.

## Install

Clone the repository, install dependencies, create a local bridge token, install the Foundry module, register the MCP server, and start the daemon:

```powershell
git clone https://github.com/SpencerZPoole/codex-foundry-bridge.git
cd codex-foundry-bridge
npm install
powershell -ExecutionPolicy Bypass -File scripts\new-token.ps1
npm run install:module
codex mcp add foundryVTT -- node .\src\mcp.js
powershell -ExecutionPolicy Bypass -File scripts\start-daemon.ps1
```

The MCP adapter and daemon read `CODEX_FOUNDRY_BRIDGE_TOKEN` from the current process environment or from the Windows user environment. The token is local machine authentication only. Do not share it.

## Foundry GM Setup

1. Restart Foundry after installing the module.
2. Open the target world as a GM user.
3. Enable the `Codex Foundry Bridge` module in the world.
4. Start the local daemon if it is not already running:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-daemon.ps1
```

5. Copy the token:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\copy-token-to-clipboard.ps1
```

6. Open the browser developer console in the Foundry client and run:

```js
await CodexFoundryBridge.setToken(await navigator.clipboard.readText())
```

On first connection in a world, the module prompts the GM to authorize that world for Codex MCP access. Until the GM approves, the daemon keeps the browser session pending and refuses live-world tools such as document edits, macro execution, snapshots, and `run_gm_script`.

Useful in-client helpers:

```js
await CodexFoundryBridge.authorizeCurrentWorld()
await CodexFoundryBridge.revokeCurrentWorld()
CodexFoundryBridge.authorizationStatus()
```

## Tool Surface

Diagnostics and registry:

- `foundry_status`
- `bridge_self_check`
- `list_bridge_tools`
- `call_bridge_tool`

Read-only intelligence:

- `list_compendium_packs`, `search_compendium`, `get_compendium_document`
- `summarize_actor`, `summarize_scene`
- `summarize_world_index`, `search_world`
- `audit_scene_readiness`, `audit_actor_readiness`
- `get_runtime_events`, `get_runtime_timeline`, `tail_logs`

Guarded workflow tools:

- `plan_journal_changes`
- `plan_scene_changes`
- `plan_document_changes`
- `list_chat_targets`
- `plan_chat_messages`
- `apply_bridge_plan`

Operations and maintenance:

- live document and embedded-document CRUD helpers
- backup-first delete helpers
- chat creation, macro execution, and explicit `dangerous=true` GM script execution
- trusted-world management
- module install/update helper
- guarded `restart_foundry_world` lifecycle restart

Use `list_bridge_tools` for the current complete registry, including each tool's category, risk flags, trusted-session requirement, direct MCP exposure, fallback support, and output shape.

## Capability Manifest

`docs/bridge-capabilities.json` records bridge version, registry version, checksum, fallback tool, and public metadata for every registered tool.

Regenerate it with:

```powershell
npm run manifest
```

Verify committed content with:

```powershell
node scripts\generate-capability-manifest.mjs --check
```

Prefer direct MCP tools when they are visible. Use `call_bridge_tool` when MCP discovery is stale or incomplete; it still runs the target tool through normal daemon dispatch and safety gates.

Fallback examples:

```json
{ "method": "bridge_self_check" }
{ "method": "search_compendium", "args": { "pack": "D35E.spells", "query": "acid arrow", "limit": 5 } }
{ "method": "summarize_world_index", "args": { "includeSamples": true, "sampleLimit": 3 } }
{ "method": "plan_journal_changes", "args": { "action": "create_entry", "entryName": "Codex Prep Notes", "pages": [{ "name": "Overview", "content": "<p>Draft notes.</p>" }] } }
{ "method": "plan_scene_changes", "args": { "changes": [{ "action": "create_token", "data": { "name": "Codex Marker", "x": 100, "y": 100, "hidden": true } }] } }
{ "method": "plan_document_changes", "args": { "changes": [{ "action": "create", "documentName": "Item", "data": { "name": "Codex Marker Item", "type": "loot" } }] } }
{ "method": "plan_chat_messages", "args": { "messages": [{ "kind": "secret_check_prompt", "checkName": "Listen", "dc": 15, "prompt": "Resolve privately." }] } }
```

The fallback is not a privilege bypass. High-risk tools still require their normal arguments and gates, such as `run_gm_script` requiring `dangerous=true` and a trusted GM session. `apply_bridge_plan` still requires the full plan plus matching confirmation values returned by the preview step.

## Previewable Transactions

`plan_journal_changes`, `plan_scene_changes`, `plan_document_changes`, and `plan_chat_messages` are preview-only. They return a `BridgePlan` with `planId`, `planHash`, `worldId`, expiration, resolved targets, compact before/after previews, warnings, and backup requirements.

To mutate the world, pass the full plan to `apply_bridge_plan` with matching confirmation:

```json
{
  "plan": "<returned BridgePlan>",
  "confirmation": {
    "planId": "<returned planId>",
    "planHash": "<returned planHash>",
    "worldId": "scratch"
  }
}
```

Document plans currently cover top-level Actor, Item, Scene, and Folder create/update operations. Chat plans create messages only and support `notice`, `handout`, `gm_note`, and `secret_check_prompt` kinds. Scene prep currently covers tokens, ambient lights, and notes.

## Foundry Lifecycle Restart

`restart_foundry_world` is a local lifecycle tool for recovering the bridge when Foundry must fully quit and relaunch. It is separate from live-world tools because the GM websocket is gone while Foundry is closed.

On Windows, restart preserves the visible Foundry Electron window's monitor, bounds, and normal/maximized/minimized state by default. It also snapshots `game.paused` before shutdown when a trusted same-world GM bridge session is connected, then restores that paused/unpaused state after the world is back and bridge-ready. Window restore is best-effort and reported in the result; pause restore is strict once a pause snapshot was captured.

The visible Electron app is driven without the managed headless viewport override, so the app should render to its real window size. The separate managed bridge GM client still uses a fixed headless viewport for reliable automation. If an older managed browser instance is still holding the bridge's dedicated browser profile, the lifecycle launcher clears only those profile-scoped Edge/Chrome processes before starting the requested CDP port.

Configure non-secret lifecycle settings and Windows Credential Manager secrets with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\set-lifecycle-credentials.ps1 -WorldId scratch -GmUserId <gm-user-id> -SkipAdminPassword -AllowBlankGmPassword
```

Use `-SkipAdminPassword` only when Foundry has no administrator password configured. Use `-AllowBlankGmPassword` only for a GM user with an empty access key. Otherwise omit those switches and the script prompts locally for the administrator password and GM access key, storing them under Windows Credential Manager targets such as `FoundryCodexBridge/AdminPassword` and `FoundryCodexBridge/World/<worldId>/GM`.

You can also configure this from Foundry after the module is enabled and the world is trusted:

1. Open the `Codex Foundry Bridge` module settings.
2. Choose `Lifecycle Credential Setup`.
3. Select the GM user, enter the Foundry administrator password if required, enter the world GM access key or mark it blank, and store the settings.

The module wizard sends credentials only to the localhost daemon over the token-authenticated trusted GM bridge connection. The daemon writes Windows Credential Manager entries and returns only redacted status booleans and target names.

Example fallback call:

```json
{ "method": "restart_foundry_world", "args": { "worldId": "scratch", "dangerous": true } }
```

Optional lifecycle quality-of-life flags default to `true`: `preserveWindowState`, `preservePauseState`, and `preserveForegroundFocus`. Set one to `false` only when troubleshooting local window automation or intentionally changing the paused state during restart.

If the module cannot be enabled from the Foundry UI, close Foundry completely and run the offline helper with an explicit world id:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\enable-world-module-offline.ps1 -WorldId <world-id>
```

The helper refuses to run while Foundry is open and backs up `settings.db` first. Prefer Foundry's Manage Modules UI for normal setup.

## Safety Model

- Localhost daemon only by default.
- Token-authenticated daemon calls.
- GM-only Foundry module connection.
- Trusted-world authorization before live-world reads or writes.
- Redacted outputs for token-like and credential-like fields.
- Backup-first destructive document operations.
- `dangerous=true` required for raw GM script execution and lifecycle restart.
- Preview/apply transactions require matching `planId`, `planHash`, and `worldId` confirmation.
- Runtime diagnostics are observational only; they do not change Foundry behavior or world data.

## Development Checks

```powershell
node --check src\tool-registry.js
node --check src\lifecycle.js
node --check src\mcp.js
node --check src\server.js
node --check module\scripts\bridge.js
node --check scripts\generate-capability-manifest.mjs
node scripts\generate-capability-manifest.mjs --check
npm test
```

## License

MIT. See `LICENSE`.

## Donate

If Foundry Codex Bridge helped your local GM workflow, you can donate through [GitHub Sponsors](https://github.com/sponsors/SpencerZPoole) or [PayPal](https://paypal.me/mrpooley92). GitHub Sponsors is best for recurring sponsorships; PayPal works well for one-time donations.

The bridge remains local-first, open source, and usable without donations.
