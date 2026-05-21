# Foundry Codex Bridge v1.0 Audit + Roadmap

Last verified: 2026-05-21

## Summary

`FoundryCodexBridge` is currently a strong local-only FoundryVTT control bridge, not just a proof of concept. Version `0.2.7` exposes a shared registry of 36 MCP/daemon tools, supports direct MCP discovery plus `call_bridge_tool` fallback dispatch, and adds a guarded local Foundry app lifecycle restart workflow for explicit worlds.

The v1.0 release goal is **Guarded Power**: expand practical live-project ability substantially while preserving the current safety model: localhost daemon, bridge token, trusted GM session gate, redaction, backups before destructive edits, and explicit `dangerous=true` for raw GM script execution.

This document is the durable local roadmap. Keep it updated as v1.0 work lands.

## Current Capability Audit

### Verified State

- Bridge/package/module version: `0.2.7`
- Registry version: `1`
- Registry checksum: `9aef8618dbcc034a1acef03cbfd3ffda4b0041325b7d75c5ff4931456204725e`
- Registered tools: `36`
- Live validation world: `scratch`
- Live Foundry: `14.361`
- Live system: `D35E 3.0.2`
- Live bridge status: daemon verified at `0.2.7`; `bridge_self_check.ready=true`
- Live module script version: `0.2.7`
- Installed module manifest file version: `0.2.7`
- Trusted GM sessions: `2` after visible Electron GM login plus managed bridge GM client restart validation
- Runtime event health: no errors; only Foundry V1 Application deprecation warnings from compatibility UI paths
- Current self-check action items: none

Do not use `return-to-undermountain` for validation unless explicitly requested.

### Tool Surface Delivered

The bridge currently provides:

| Category | Tools | Status |
| --- | --- | --- |
| Self-diagnostics | `foundry_status`, `bridge_self_check`, `list_bridge_tools` | Good current baseline |
| MCP parity fallback | `call_bridge_tool` | Works through daemon and MCP, but direct MCP arg ergonomics need v1 cleanup |
| Live document reads | `list_collections`, `get_document`, `search_documents`, `list_scenes`, `inspect_scene` | Useful but generic |
| Compendium reads | `list_compendium_packs`, `search_compendium`, `get_compendium_document` | Strong read-only baseline through live Foundry APIs |
| Compact summaries | `summarize_actor`, `summarize_scene` | Useful D35E/world overview layer |
| World/user/settings reads | `list_users`, `read_settings`, `export_world_snapshot` | Useful, redacted, still shallow |
| Runtime diagnostics | `tail_logs`, `get_runtime_events`, `clear_runtime_events` | Good recent-event visibility, not a durable session timeline |
| World mutation | `create_document`, `update_document`, `create_embedded_document`, `update_embedded_document` | Powerful but low-level |
| Destructive mutation | `delete_document`, `delete_embedded_document` | Backup-first, still needs rollback browsing/apply metadata |
| Chat/macros/scripts | `create_chat_message`, `run_macro`, `run_gm_script` | Powerful; `run_gm_script` remains emergency-only |
| Local lifecycle | `restart_foundry_world` | Guarded full-app restart and GM auto-login for explicit trusted worlds |
| Local maintenance | `list_installed_packages`, `read_foundry_options_sanitized`, `list_trusted_worlds`, `revoke_trusted_world`, `backup_world`, `install_or_update_bridge_module` | Practical local ops baseline |

### Strengths

- Uses live Foundry APIs rather than scraping world or compendium storage for normal operation.
- Preserves a clear security model: localhost only, token-authenticated daemon, GM-only client, trusted-world gate.
- Uses a shared registry for tool discovery, daemon dispatch, docs, and smoke tests.
- Provides `call_bridge_tool` fallback when MCP discovery lags.
- Redacts token-like and sensitive fields in normal outputs.
- Creates local backups before destructive document and embedded-document deletes.
- Captures live browser/runtime warnings, errors, UI notifications, and bridge request failures.
- Can restart the local Foundry application and re-establish a bridge-ready GM client through Windows Credential Manager-backed lifecycle automation.
- Has smoke coverage for MCP registration parity, dynamic trust gates, GM authorization, fallback dispatch, and revocation.

### Limitations

- Most write tools are raw Foundry document operations, so practical GM workflows still require knowing collection names, document shapes, and update payload structure.
- There is no preview/diff/apply transaction model; write safety depends on caller discipline plus backup coverage.
- There are no high-level guarded workflows for common campaign tasks such as journal/page prep, scene readiness, token placement, encounter setup, secret checks, or compendium imports.
- Complex arguments are still exposed with broad schemas in several places, which weakens MCP usability and makes client-side validation thin.
- `call_bridge_tool.args` works as a daemon object payload, but direct MCP exposure can be awkward in clients that flatten object args.
- Output is mostly free-form JSON text; important tools do not yet provide structured output schemas.
- Runtime diagnostics are recent and bounded, not a durable session event timeline.
- There is no rollback browser, restore assistant, or transaction history viewer.
- There are no permission/profile presets for different operating modes such as read-only, prep, session, maintenance, or dangerous-script-enabled.
- Lifecycle restart now targets both visible Electron-window GM login and a managed bridge GM client, but this CDP path still needs live hardening across more Foundry/Electron versions.
- Documentation is good for setup, but sparse for real GM workflows and v1 compatibility guarantees.

## v1.0 Release Target

### Release Principle

v1.0 should make normal live Foundry work possible through explicit, typed, reversible tools. `run_gm_script` should remain available, but it should stop being the normal way to bridge capability gaps.

### Public Contract

For v1.0, document and preserve:

- localhost daemon only by default
- required bridge token for daemon calls
- GM-only Foundry client connection
- trusted-world authorization before live-world reads or writes
- read/write/destructive/script risk classification for every tool
- redaction guarantees and known redaction limits
- backup guarantees for destructive tools
- `dangerous=true` requirement for raw GM script execution
- `scratch` as the default validation world
- no implicit validation or mutation of `return-to-undermountain`

### Lifecycle Hardening Slice

Status: expanded for the `0.2.7` development slice.

The `restart_foundry_world` tool is a guarded local lifecycle orchestrator, not a live-world mutation tool. It requires `dangerous=true`, an explicit `worldId`, and Windows Credential Manager credentials when Foundry administrator or GM passwords are configured. It preserves localhost, token auth, redaction, and trusted-world requirements: after restart, live-world tools become ready only if the launched world is already trusted.

The `0.2.7` slice changes the lifecycle end state from headless-only bridge recovery to visible-app plus bridge recovery. The daemon now launches the visible Electron app with a dedicated CDP port, drives it into the requested world as GM, and still maintains a separate managed GM client for reliable bridge connectivity. The module also exposes a GM-only lifecycle credential wizard that stores admin and per-world GM secrets through the localhost daemon into Windows Credential Manager.

Live findings from the `scratch` validation pass:

- Confirmed `restart_foundry_world({ worldId: "scratch", dangerous: true })` fully stopped Foundry, relaunched the Electron app with `--remote-debugging-port=39224`, launched `scratch`, joined the visible app as GM at `/game`, joined the managed bridge GM client, and verified `bridge_self_check.ready=true`.
- Confirmed registry checksum `9aef8618dbcc034a1acef03cbfd3ffda4b0041325b7d75c5ff4931456204725e` matches the live daemon, tool list, fallback dispatch, and committed capability manifest.
- Confirmed the tool fully gates on `dangerous=true`, explicit `worldId`, and the configured credential targets.
- Confirmed force-stop fallback only targets processes whose executable path exactly matches the configured Foundry executable.
- Added stale Foundry data lock recovery for `Config/options.json.lock` after force-stop, guarded by the same exact executable-process check.
- Confirmed Foundry 14 uses `Config/admin.txt` as the durable setup-admin lock indicator; `options.json` alone is not sufficient for admin-password detection.
- Current validation target: `scratch` only. Do not use `return-to-undermountain` for this lifecycle validation unless explicitly requested by exact world id.

## v1.0 Roadmap

### Milestone 1: Documentation and Manifest Hardening

Status: completed for the `0.2.5` development slice.

Goal: make the bridge surface self-describing enough that tool discovery, docs, tests, and release status cannot drift.

Deliverables:

- Completed: keep this document current as the v1.0 release checklist.
- Completed: add `docs/bridge-capabilities.json`, a deterministic machine-readable capability manifest generated from the tool registry.
- Completed: include per-tool category, risk, read/write flag, trusted-session requirement, input keys, output shape summary, direct MCP exposure, and fallback support.
- Completed: add README links for the roadmap and capability manifest, plus direct MCP versus `call_bridge_tool` fallback guidance.
- Completed: add tests that compare registry data, MCP generated schemas, fallback metadata, README references, and the docs manifest.

Acceptance:

- Completed: `npm test` fails if a registry tool is missing from MCP discovery, fallback compatibility, or the generated capability manifest.
- Completed: README links to the v1.0 roadmap and clearly explains when to use direct tools versus `call_bridge_tool`.

### Milestone 2: Safer High-Level Read Intelligence

Goal: give Codex a richer understanding of live worlds without requiring raw document spelunking.

Deliverables:

- `summarize_world_index`: compact counts and health summary for actors, items, scenes, journals, folders, macros, compendium packs, users, active scene, and runtime status.
- `audit_scene_readiness`: read-only scene checks for missing assets, unlinked actors, hidden/unconfigured tokens, lights/walls/sounds/notes presence, grid/background data, and D35E-relevant token state.
- `audit_actor_readiness`: read-only actor checks for missing images, empty inventories, unprepared or malformed D35E item data, broken embedded items, ownership, and token linkage.
- `search_world`: cross-collection search with compact results and stable IDs.
- `get_runtime_timeline`: durable session timeline built from runtime events, bridge requests, chat/message deltas, combat changes, and scene changes where available.

Acceptance:

- All new read tools require trusted GM session, except pure daemon diagnostics.
- Results are compact by default and redacted.
- Live validation runs only on `scratch`.

### Milestone 3: Previewable Write Workflows

Goal: make mutation safer and more legible by separating planning from applying.

Deliverables:

- `plan_document_changes`: accepts high-level document intents and returns proposed Foundry operations without mutation.
- `plan_scene_changes`: proposes token/light/wall/note/scene updates without mutation.
- `plan_journal_changes`: proposes journal entry/page create/update operations with stable IDs.
- `apply_bridge_plan`: executes a previously returned plan only with explicit confirmation data.
- Transaction metadata with operation IDs, target document IDs, before/after summaries, backup path when applicable, and rollback references.

Acceptance:

- Plan tools are read-only and can be used freely on trusted sessions.
- Apply tools refuse stale, malformed, or cross-world plans.
- Destructive operations always create a backup first.
- Smoke tests cover preview, refusal, apply, rollback metadata, and redaction.

### Milestone 4: GM Workflow Tools

Goal: replace raw script/document work with practical guarded tools for live campaign prep and session operation.

Deliverables:

- Journal/page tools for create, update, append section, reorder pages, and retrieve stable IDs.
- Scene prep tools for token placement, token relinking, lights, notes, folders, and visibility setup.
- Actor/item helpers for compact patching, embedded item add/update, token prototype sync, and ownership review.
- Chat helpers for GM whispers, blind/secret checks, player-facing handouts, and roll-result summaries.
- Compendium import helpers for copy-to-world with preview, duplicate detection, folder placement, and source metadata.
- Macro helpers for install/update/run by stable name, with dry-run preview and script body hashing.

Acceptance:

- Each workflow has a read-only preview path and a guarded apply path.
- Each workflow returns stable IDs and a concise verification summary.
- No tool silently writes to `return-to-undermountain` during v1 validation.

### Milestone 5: v1 Release Hardening

Goal: ship a bridge that is dependable enough to treat as the normal live Foundry control surface.

Deliverables:

- Full setup and operating docs.
- Capability manifest committed and checked by tests.
- Expanded fake GM websocket tests.
- Live `scratch` validation checklist.
- Local security scan closeout.
- Release notes that identify compatibility with Foundry `14.361` and D35E `3.0.2`.

Acceptance:

- Syntax checks pass for `src/tool-registry.js`, `src/mcp.js`, `src/server.js`, `module/scripts/bridge.js`, and tests.
- `npm test` passes.
- Live read-only validation on `scratch` passes.
- Opt-in live write validation on `scratch` passes for disposable test documents.
- Local security gate reports no blocking errors.

## Test Expansion Plan

Add test coverage for:

- registry parity across MCP, daemon dispatch, `call_bridge_tool`, docs manifest, and README examples
- direct MCP schema shape for object args, especially `call_bridge_tool.args`
- structured output schemas for important read tools
- trust-gate refusals before world authorization
- trusted-world success after fake GM authorization
- backup-before-delete behavior
- plan/apply refusal for missing confirmation, stale world, malformed plan, and dangerous operations
- rollback metadata and backup path reporting
- redaction of token-like fields in daemon, MCP, backup metadata, snapshots, and runtime events
- fake GM websocket failures, request timeouts, malformed responses, and disconnects
- local security scan as a closeout step after code, manifest, script, config, or doc changes

## Validation Commands

Use these as the baseline v1 closeout:

```powershell
node --check src/tool-registry.js
node --check src/lifecycle.js
node --check src/mcp.js
node --check src/server.js
node --check module/scripts/bridge.js
node --check scripts/generate-capability-manifest.mjs
node --check test/smoke.js
node --check test/manifest.js
node --check test/lifecycle.js
node scripts/generate-capability-manifest.mjs --check
npm test
node C:\Users\mrpoo\.codex\skills\local-security-gate\scripts\security-scan.mjs --root G:\DungeonsAndDragonsDMFolder\FoundryCodexBridge --changed-only
```

For live checks, use `scratch` unless explicitly redirected:

```json
{ "method": "bridge_self_check" }
{ "method": "list_bridge_tools" }
{ "method": "restart_foundry_world", "args": { "worldId": "scratch", "dangerous": true } }
{ "method": "search_compendium", "args": { "pack": "D35E.spells", "query": "acid arrow", "limit": 5 } }
{ "method": "summarize_scene", "args": { "includeTokens": true, "tokenLimit": 5 } }
```

## Deferred Decisions

These are intentionally not decided in this roadmap and should be resolved immediately before implementation:

- Whether v1.0 should introduce a separate `permissions.json` profile system or encode profiles in the trusted-world record.
- Whether transaction plans should be stored on disk, in memory, or both.
- Whether rollback should be automated for all supported operations or only assisted through backups and before/after metadata.
- Which high-level GM workflow should be implemented first after manifest hardening. Current best first candidate: read-only world/scene readiness audits, followed by previewable journal/page updates.

## Non-Goals

- Do not remove localhost-only behavior.
- Do not remove token authentication.
- Do not remove GM-only connection requirements.
- Do not remove trusted-world authorization.
- Do not make `run_gm_script` easier to invoke accidentally.
- Do not validate or mutate `return-to-undermountain` without explicit instruction.
