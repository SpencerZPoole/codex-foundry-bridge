# Foundry Codex Bridge

Local-first MCP tooling for safely operating a trusted Foundry VTT GM session from Codex.

Foundry Codex Bridge connects AI coding agents to live Foundry VTT worlds without turning campaign data into an unguarded remote-control surface. It can inspect world state, search compendiums, preview and apply confirmed changes, post guarded chat messages, restart the local Foundry app, restore a bridge-ready GM session, and teach new agents how to discover the available tools on first contact.

The project direction is **Guarded Power**: useful live-world capability with localhost transport, token auth, explicit GM trust, redaction, backups, preview/apply transactions, and `dangerous=true` gates for high-risk workflows.

## How It Works

The bridge has four cooperating pieces:

1. **MCP adapter**: `src/mcp.js` exposes the tool surface to Codex and other MCP clients over stdio. It registers tools, resources, and prompts from the shared registry and onboarding docs.
2. **Local daemon**: `src/server.js` runs on localhost, accepts token-authenticated `/call` requests, hosts the Foundry WebSocket endpoint at `/foundry`, enforces trust gates, dispatches tools, redacts output, manages backups, and supports lifecycle restart.
3. **Foundry module**: `module/` installs into Foundry and runs inside an opened world. A GM client connects back to the local daemon and executes trusted-session requests through live Foundry APIs.
4. **Shared tool registry**: `src/tool-registry.js` is the source of truth for tool metadata, MCP registration, daemon dispatch, docs, tests, examples, and `docs/bridge-capabilities.json`.

Typical request flow:

```text
Codex or MCP client
  -> src/mcp.js stdio adapter
  -> src/server.js localhost daemon with CODEX_FOUNDRY_BRIDGE_TOKEN
  -> module/scripts/bridge.js in a trusted GM Foundry session
  -> live Foundry API
```

Read the full system map in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Current Status

- Version: `0.2.15`
- Foundry compatibility target: Foundry `14`
- Registered tools: `48`
- Public capability manifest: [docs/bridge-capabilities.json](docs/bridge-capabilities.json)
- Agent first-contact guide: [docs/AGENT_QUICKSTART.md](docs/AGENT_QUICKSTART.md)
- v1 roadmap: [docs/V1_RELEASE_AUDIT_AND_PLAN.md](docs/V1_RELEASE_AUDIT_AND_PLAN.md)
- Default disposable validation world used by this repo's workflow: `scratch`

Latest live validation baseline is Foundry `14.362` with D35E `3.0.2` during the `0.2.13` lifecycle pass. The `0.2.15` changes are docs, onboarding, manifest parity, and screenshot-workflow guidance only; they add no new live-world powers.

## Install

There are three separate setup layers. First install the Foundry module, then set up the local bridge process, then authorize a GM world.

### 1. Release Install For Foundry

In Foundry, open **Add-on Modules > Install Module**, paste this manifest URL, and install:

```text
https://github.com/SpencerZPoole/codex-foundry-bridge/releases/latest/download/module.json
```

That installs only the Foundry module. It does not install Node dependencies, start the local daemon, or configure Codex/MCP by itself.

The release zip is shaped like a normal Foundry module package, with `module.json` and `scripts/bridge.js` at the archive root.

### 2. Local Bridge Setup From Source

Until this project has a packaged desktop installer, the local MCP adapter and daemon are installed from this repository:

```powershell
git clone https://github.com/SpencerZPoole/codex-foundry-bridge.git
cd codex-foundry-bridge
npm install
powershell -ExecutionPolicy Bypass -File scripts\new-token.ps1
```

`scripts\new-token.ps1` creates a local `CODEX_FOUNDRY_BRIDGE_TOKEN` in the Windows user environment. Restart Codex or your shell after running it so the token is visible to new processes.

Register the MCP server with Codex:

```powershell
$repo = (Get-Location).Path
codex mcp add foundryVTT -- node "$repo\src\mcp.js"
```

If your MCP client does not use `codex mcp add`, configure a stdio MCP server whose command is `node` and whose first argument is the absolute path to `src/mcp.js`.

Start the daemon manually when you want a preflight check:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-daemon.ps1
```

The MCP adapter can also start the daemon automatically when a tool call needs it.

### 3. Foundry GM World Setup

1. Restart Foundry after installing the module.
2. Open the target world as a GM user.
3. Enable the `Codex Foundry Bridge` module in that world.
4. Start the local daemon if it is not already running.
5. Copy the bridge token:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\copy-token-to-clipboard.ps1
```

6. Open the browser developer console in the Foundry client and run:

```js
await CodexFoundryBridge.setToken(await navigator.clipboard.readText())
```

On first connection in a world, the module prompts the GM to authorize that world for Codex MCP access. Until the GM approves, the daemon keeps the browser session pending and refuses trusted-session tools.

Useful in-client helpers:

```js
await CodexFoundryBridge.authorizeCurrentWorld()
await CodexFoundryBridge.revokeCurrentWorld()
CodexFoundryBridge.authorizationStatus()
```

Verify from Codex or another MCP client:

```json
{ "method": "bridge_self_check" }
```

```json
{ "method": "list_bridge_tools" }
```

### Source/Development Module Install

For local development, this command copies `module/` into your Foundry data folder:

```powershell
npm run install:module
```

Use this only when developing from the repository. Normal Foundry users should use the release manifest URL above.

## Tool Families

Diagnostics and discovery:

- `foundry_status`
- `bridge_self_check`
- `get_bridge_quickstart`
- `list_bridge_tools`
- `call_bridge_tool`

Read-only intelligence:

- compendium pack listing, search, and document reads
- actor and scene summaries
- world index, world search, scene readiness, actor readiness, and runtime timeline
- local package/config/log inspection with redaction

Guarded workflows:

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

Use `list_bridge_tools` for the complete current registry, including each tool's category, risk, read/write flag, trusted-session requirement, direct MCP exposure flag, fallback support, input keys, output-shape name, and examples.

## Agent First Contact

New agents should not guess the bridge surface from memory. Start with:

```json
{ "method": "bridge_self_check" }
```

Then inspect the registry:

```json
{ "method": "list_bridge_tools" }
```

For a compact onboarding payload:

```json
{ "method": "get_bridge_quickstart", "args": { "format": "json" } }
```

MCP clients that support resources can also read:

- `foundry://bridge/quickstart`
- `foundry://bridge/capabilities`
- `foundry://bridge/readme`

MCP clients that support prompts can use `foundry_bridge_first_contact`.

Prefer direct MCP tools when they are visible. Use `call_bridge_tool` only when MCP discovery is stale or incomplete; it still runs through normal daemon dispatch and normal safety gates.

## Previewable Transactions

The safest write path is preview first, apply second.

`plan_journal_changes`, `plan_scene_changes`, `plan_document_changes`, and `plan_chat_messages` are read-only planning tools. They return a `BridgePlan` with `planId`, `planHash`, `worldId`, expiration, resolved targets, compact before/after previews, warnings, and backup requirements.

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

Document plans currently cover top-level Actor, Item, Scene, and Folder create/update operations. Chat plans create messages only and support `notice`, `handout`, `gm_note`, and `secret_check_prompt`. Scene prep currently covers tokens, ambient lights, and notes.

## Live App Screenshot Workflow

When an agent needs a Foundry screenshot, it should prefer the already-open visible live Foundry app on the host computer when that app is available. Browser-based screenshots are fallback behavior because browser reproductions can render Foundry scenes and UI poorly.

Recommended flow:

1. Call `bridge_self_check` or `foundry_status` to confirm whether a live trusted Foundry session is available.
2. Use bridge tools or visible UI control to set up the requested scene, canvas position, token, sheet, journal, sidebar, dialog, tab, or sub-tab.
3. Open or close sheets, journals, sidebars, dialogs, and other windows as needed.
4. Hide distracting windows only when it helps the requested screenshot.
5. Capture the visible host app/window once the view is ready.
6. Use browser-based screenshots only as fallback when the visible app is unavailable or the requested target is a setup, login, or browser-only page.

UI-only view manipulation is fine for screenshot preparation. Persistent world changes still need preview/apply workflows or explicit user approval. Do not launch, validate, or mutate a private production campaign world just to obtain a screenshot unless the user explicitly requests that exact world.

## Foundry Lifecycle Restart

`restart_foundry_world` is a local lifecycle tool for recovering the bridge when Foundry must fully quit and relaunch. It is not a normal live-world tool because the GM WebSocket is gone while Foundry is closed.

The tool requires:

- explicit `worldId`
- `dangerous=true`
- local lifecycle config
- Windows Credential Manager secrets when Foundry admin or GM passwords are configured

Configure lifecycle settings:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\set-lifecycle-credentials.ps1 -WorldId scratch -GmUserId <gm-user-id> -SkipAdminPassword -AllowBlankGmPassword
```

Use `-SkipAdminPassword` only when Foundry has no administrator password configured. Use `-AllowBlankGmPassword` only for a GM user with an empty access key. Otherwise omit those switches and the script prompts locally for credentials and stores them in Windows Credential Manager targets such as `FoundryCodexBridge/AdminPassword` and `FoundryCodexBridge/World/<worldId>/GM`.

The module also includes a GM-only lifecycle credential wizard from the module settings once a world is trusted. The wizard sends secrets only to the localhost daemon over the token-authenticated trusted GM bridge connection, and the daemon returns only redacted status booleans and target names.

Example:

```json
{ "method": "restart_foundry_world", "args": { "worldId": "scratch", "dangerous": true } }
```

On Windows, restart preserves the visible Foundry Electron window's monitor, bounds, and normal/maximized/minimized state by default. It also snapshots `game.paused` when a trusted same-world GM bridge session is connected before shutdown and restores that pause state after the world is bridge-ready.

## Safety Model

- Localhost daemon only by default.
- Token-authenticated daemon calls through `CODEX_FOUNDRY_BRIDGE_TOKEN`.
- GM-only Foundry module connection.
- Trusted-world authorization before live-world reads or writes.
- Redacted outputs for token-like and credential-like fields.
- Backup-first destructive document operations.
- `dangerous=true` required for raw GM script execution and lifecycle restart.
- Preview/apply transactions require matching `planId`, `planHash`, and `worldId`.
- Runtime diagnostics are observational; they do not change Foundry behavior or world data.

## Capability Manifest

[docs/bridge-capabilities.json](docs/bridge-capabilities.json) records bridge version, registry version, checksum, fallback tool, and public metadata for every registered tool.

Regenerate it with:

```powershell
npm run manifest
```

Verify committed content with:

```powershell
node scripts\generate-capability-manifest.mjs --check
```

## Development And Release Checks

```powershell
node --check src\agent-bootstrap.js
node --check src\tool-registry.js
node --check src\lifecycle.js
node --check src\mcp.js
node --check src\server.js
node --check module\scripts\bridge.js
node --check scripts\generate-capability-manifest.mjs
node scripts\generate-capability-manifest.mjs --check
npm test
```

Build the Foundry module release assets:

```powershell
npm run package:release
```

That creates `dist\codex-foundry-bridge-v<version>.zip`. Release artifacts in `dist/` are intentionally ignored by Git.

## Offline Module Enable Helper

If the module cannot be enabled from the Foundry UI, close Foundry completely and run the offline helper with an explicit world id:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\enable-world-module-offline.ps1 -WorldId <world-id>
```

The helper refuses to run while Foundry is open and backs up `settings.db` first. Prefer Foundry's Manage Modules UI for normal setup.

## Project Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): zoomed-out project map and request flow
- [docs/AGENT_QUICKSTART.md](docs/AGENT_QUICKSTART.md): first-contact checklist for agents
- [docs/bridge-capabilities.json](docs/bridge-capabilities.json): generated registry manifest
- [docs/V1_RELEASE_AUDIT_AND_PLAN.md](docs/V1_RELEASE_AUDIT_AND_PLAN.md): v1 roadmap and validation history
- [docs/MARKET_POSITIONING_AND_MONETIZATION.md](docs/MARKET_POSITIONING_AND_MONETIZATION.md): public positioning and monetization notes

## License

MIT. See [LICENSE](LICENSE).

## Donate

If this project helped your local GM workflow, donations are welcome. GitHub Sponsors is best for recurring sponsorships; PayPal works well for one-time donations.

[![Sponsor on GitHub](https://img.shields.io/badge/GitHub%20Sponsors-Donate-ea4aaa?style=flat&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/SpencerZPoole)
[![Donate with PayPal](https://img.shields.io/badge/PayPal-One--time%20donation-00457C?style=flat&logo=paypal&logoColor=white)](https://paypal.me/mrpooley92)

The bridge remains local-first, open source, and usable without donations.
