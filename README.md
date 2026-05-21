# Foundry Codex Bridge

Local-only bridge between Codex MCP tools and a trusted FoundryVTT GM client.

## Shape

- `src/server.js` runs the Codex MCP server over stdio and a localhost WebSocket endpoint for Foundry.
- `src/tool-registry.js` is the shared tool registry used by both MCP entrypoints.
- `module/` is the Foundry module installed into the local Foundry data folder.
- The MCP server requires `CODEX_FOUNDRY_BRIDGE_TOKEN`.
- The Foundry module connects for GM users with a configured local token, then the daemon only activates full tools for worlds explicitly authorized by the GM.
- Trusted worlds are stored locally in `config/trusted-worlds.json`; the file contains world metadata only, never the bridge token.
- The module keeps a bounded live runtime buffer for GM-client console errors/warnings, unhandled promise rejections, Foundry UI notifications, and bridge request failures. Use `get_runtime_events` to inspect it and `clear_runtime_events` to reset it.

## Install

```powershell
cd G:\DungeonsAndDragonsDMFolder\FoundryCodexBridge
npm install
powershell -ExecutionPolicy Bypass -File scripts\new-token.ps1
npm run install:module
codex mcp add foundryVTT -- node G:\DungeonsAndDragonsDMFolder\FoundryCodexBridge\src\mcp.js
powershell -ExecutionPolicy Bypass -File G:\DungeonsAndDragonsDMFolder\FoundryCodexBridge\scripts\start-daemon.ps1
```

The MCP adapter and daemon read `CODEX_FOUNDRY_BRIDGE_TOKEN` from the current process environment or from the Windows user environment.

## Foundry GM Setup

1. Restart Foundry after installing the module.
2. Open the target world as `Gamemaster`.
3. Enable the `Codex Foundry Bridge` module in the world.
4. Start the local daemon if it is not already running:

```powershell
powershell -ExecutionPolicy Bypass -File G:\DungeonsAndDragonsDMFolder\FoundryCodexBridge\scripts\start-daemon.ps1
```

5. Copy the token:

```powershell
powershell -ExecutionPolicy Bypass -File G:\DungeonsAndDragonsDMFolder\FoundryCodexBridge\scripts\copy-token-to-clipboard.ps1
```

6. Open the browser developer console in the Foundry client and run:

```js
await CodexFoundryBridge.setToken(await navigator.clipboard.readText())
```

The token is local machine authentication only. Do not share it.

On first connection in a world, the module prompts the GM to authorize that world for Codex MCP access. Until the GM approves, the daemon keeps the browser session pending and refuses live-world tools such as document edits, macro execution, snapshots, and `run_gm_script`.

Useful in-client helpers:

```js
await CodexFoundryBridge.authorizeCurrentWorld()
await CodexFoundryBridge.revokeCurrentWorld()
CodexFoundryBridge.authorizationStatus()
```

Useful MCP/daemon tools:

- `foundry_status` shows trusted and pending sessions plus the trusted-world config path.
- `bridge_self_check` reports daemon, module, version, runtime, path, log, and trusted-world health.
- `list_bridge_tools` returns the shared tool registry with category, output shape, risk flags, direct MCP exposure, fallback support, and checksum.
- `call_bridge_tool` invokes any fallback-callable registered bridge tool by name when direct MCP discovery lags.
- `list_trusted_worlds` lists authorized world ids and metadata.
- `revoke_trusted_world` removes a world from the trusted list.
- `restart_foundry_world` fully restarts the local Foundry app, launches an explicit world, joins as GM, and verifies bridge readiness. It requires `dangerous=true` and local lifecycle credentials.
- `list_compendium_packs`, `search_compendium`, and `get_compendium_document` read live Foundry compendium APIs without scraping pack storage.
- `summarize_actor` and `summarize_scene` provide compact read-only D35E/world summaries.
- `summarize_world_index`, `search_world`, `audit_scene_readiness`, `audit_actor_readiness`, and `get_runtime_timeline` provide higher-level read-only world intelligence through the live trusted GM session.
- `plan_journal_changes` previews JournalEntry and JournalEntryPage create/update/append operations without mutating the world.
- `plan_scene_changes` previews scene token, ambient light, and note create/update operations without mutating the world.
- `plan_document_changes` previews Actor, Item, Scene, and Folder create/update operations without mutating the world.
- `apply_bridge_plan` applies a returned journal, scene, or document plan only after explicit `planId`, `planHash`, and `worldId` confirmation. Existing-document updates create a backup first.

## Capability Manifest

- The v1.0 audit and roadmap are tracked in `docs/V1_RELEASE_AUDIT_AND_PLAN.md`.
- `docs/bridge-capabilities.json` is generated from `src/tool-registry.js` and records bridge version, registry version, checksum, fallback tool, and public metadata for every registered tool.
- Regenerate it with `npm run manifest`; verify committed content with `node scripts/generate-capability-manifest.mjs --check` or `npm test`.
- Prefer direct MCP tools when they are visible. Use `call_bridge_tool` when MCP discovery is stale or incomplete; it still runs the target tool through the normal daemon dispatch and safety gates.

Fallback examples:

```json
{ "method": "bridge_self_check" }
{ "method": "search_compendium", "args": { "pack": "D35E.spells", "query": "acid arrow", "limit": 5 } }
{ "method": "summarize_world_index", "args": { "includeSamples": true, "sampleLimit": 3 } }
{ "method": "plan_journal_changes", "args": { "action": "create_entry", "entryName": "Codex Prep Notes", "pages": [{ "name": "Overview", "content": "<p>Draft notes.</p>" }] } }
{ "method": "plan_scene_changes", "args": { "changes": [{ "action": "create_token", "data": { "name": "Codex Marker", "x": 100, "y": 100, "hidden": true } }] } }
{ "method": "plan_document_changes", "args": { "changes": [{ "action": "create", "documentName": "Item", "data": { "name": "Codex Marker Item", "type": "loot" } }] } }
```

The fallback is not a privilege bypass. High-risk tools still require their normal arguments and gates, such as `run_gm_script` requiring `dangerous=true` and a trusted GM session. `apply_bridge_plan` still requires the full plan plus matching confirmation values returned by the preview step.

## Previewable Transactions

`plan_journal_changes`, `plan_scene_changes`, and `plan_document_changes` are preview-only. They return a `BridgePlan` with `planId`, `planHash`, `worldId`, expiration, resolved targets, compact before/after previews, warnings, and backup requirements. To mutate the world, pass the full plan to `apply_bridge_plan` with matching confirmation:

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

Document plans currently cover top-level Actor, Item, Scene, and Folder create/update operations. Folder creates require a `folderType` or `data.type` of `Actor`, `Item`, `Scene`, or `JournalEntry`. Macro create/update is intentionally deferred to a dedicated macro workflow. Scene prep currently covers tokens, ambient lights, and notes only. It intentionally does not add walls, deletes, scene activation, field-level actor/item rules automation, macro authoring, or compendium import behavior.

## Foundry Lifecycle Restart

`restart_foundry_world` is a local lifecycle tool for recovering the bridge when Foundry must fully quit and relaunch. It is intentionally separate from live-world tools because the GM websocket is gone while Foundry is closed. The restart workflow now drives the visible Foundry Electron app into the requested world as GM and also keeps a managed headless GM client available for bridge reliability.

Configure non-secret lifecycle settings and Windows Credential Manager secrets with:

```powershell
powershell -ExecutionPolicy Bypass -File G:\DungeonsAndDragonsDMFolder\FoundryCodexBridge\scripts\set-lifecycle-credentials.ps1 -WorldId scratch -GmUserId <gm-user-id> -SkipAdminPassword -AllowBlankGmPassword
```

Use `-SkipAdminPassword` only when Foundry has no administrator password configured. On Foundry 14, a non-empty `Config/admin.txt` in the Foundry user-data directory means the admin credential is required even though `options.json` no longer contains the hash. Use `-AllowBlankGmPassword` only for a GM user with an empty access key. Otherwise omit those switches and the script prompts locally for the administrator password and GM access key, storing them under Windows Credential Manager targets such as `FoundryCodexBridge/AdminPassword` and `FoundryCodexBridge/World/<worldId>/GM`. The generated `config/lifecycle.json` contains only non-secret settings, including the visible app CDP port `39224` and bridge GM client CDP port `39223`, and is ignored by git.

You can also configure this from Foundry after the module is enabled and the world is trusted:

1. Open the `Codex Foundry Bridge` module settings.
2. Choose `Lifecycle Credential Setup`.
3. Select the GM user, enter the Foundry administrator password if required, enter the world GM access key or mark it blank, and store the settings.

The module wizard sends credentials only to the localhost daemon over the already token-authenticated trusted GM bridge connection. The daemon writes Windows Credential Manager entries and returns only redacted status booleans and target names.

Example daemon fallback call:

```json
{ "method": "restart_foundry_world", "args": { "worldId": "scratch", "dangerous": true } }
```

The restart tool still preserves the trusted-world model. It can launch and join the visible app plus the managed GM client, but live-world bridge tools become ready only for worlds already authorized in `config/trusted-worlds.json`.

If the module cannot be enabled from the Foundry UI, close Foundry completely and run:

```powershell
powershell -ExecutionPolicy Bypass -File G:\DungeonsAndDragonsDMFolder\FoundryCodexBridge\scripts\enable-world-module-offline.ps1
```

That helper refuses to run while Foundry is open and backs up `settings.db` first.

## Safety

- Live world edits go through Foundry document APIs, not raw `.db` writes.
- Destructive document tools create a timestamped backup under `backups/`.
- Secrets, credential hashes, license/admin keys, and token-like fields are redacted from tool results. Transaction `planHash` values are intentionally returned because they are confirmation IDs, not secrets.
- `run_gm_script` requires `dangerous=true`.
- `restart_foundry_world` requires `dangerous=true`, explicit `worldId`, and Windows Credential Manager credentials when passwords are configured.
- `plan_journal_changes`, `plan_scene_changes`, and `plan_document_changes` are preview-only. `apply_bridge_plan` is the only transaction writer and refuses missing confirmation, hash mismatch, world mismatch, expired plans, malformed operations, and plans not produced by those preview tools.
- Lifecycle credential setup requires a trusted GM session and stores secrets only in Windows Credential Manager.
- Live-world tools require a connected, trusted GM session; unknown worlds stay pending until authorized by the GM.
- Read-only intelligence tools require the same trusted GM session as other live-world inspection tools.
- Runtime diagnostics are observational only; they do not change Foundry behavior or world data.
