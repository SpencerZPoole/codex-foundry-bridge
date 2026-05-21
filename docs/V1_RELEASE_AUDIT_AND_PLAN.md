# Foundry Codex Bridge v1.0 Audit + Roadmap

Last verified: 2026-05-21

## Summary

`FoundryCodexBridge` is currently a strong local-only FoundryVTT control bridge, not just a proof of concept. Version `0.2.10` exposes a shared registry of 44 MCP/daemon tools, supports direct MCP discovery plus `call_bridge_tool` fallback dispatch, includes a guarded local Foundry app lifecycle restart workflow for explicit worlds, adds high-level read-only live-world intelligence, and now supports previewable journal/page plus scene token/light/note transactions.

The v1.0 release goal is **Guarded Power**: expand practical live-project ability substantially while preserving the current safety model: localhost daemon, bridge token, trusted GM session gate, redaction, backups before destructive edits, and explicit `dangerous=true` for raw GM script execution.

This document is the durable local roadmap. Keep it updated as v1.0 work lands.

## Current Capability Audit

### Verified State

- Bridge/package/module version: `0.2.10`
- Registry version: `1`
- Registry checksum: `7789e25c0c034fe802c30d26ec13b98066962bde8fb302bb1eea2f496320908a`
- Registered tools: `44`
- Live validation world: `scratch`
- Live Foundry: `14.361`
- Live system: `D35E 3.0.2`
- Live bridge status: daemon verified at `0.2.10`; `bridge_self_check.ready=true`
- Live module script version: `0.2.10`
- Installed module manifest file version: `0.2.10`
- Trusted GM sessions: `2` after visible Electron GM login plus managed bridge GM client restart validation
- Runtime event health: no errors; Foundry deprecation warnings only from compatibility/runtime read paths
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
| High-level read intelligence | `summarize_world_index`, `search_world`, `audit_scene_readiness`, `audit_actor_readiness`, `get_runtime_timeline` | Added in `0.2.8`; compact, read-only, trusted-session gated |
| Previewable journal transactions | `plan_journal_changes`, `apply_bridge_plan` | Added in `0.2.9`; JournalEntry/Page create/update/append preview with explicit confirmed apply |
| Previewable scene prep transactions | `plan_scene_changes`, `apply_bridge_plan` | Added in `0.2.10`; scene token/light/note create/update preview with explicit confirmed apply |
| World/user/settings reads | `list_users`, `read_settings`, `export_world_snapshot` | Useful, redacted, still shallow |
| Runtime diagnostics | `tail_logs`, `get_runtime_events`, `get_runtime_timeline`, `clear_runtime_events` | Good bounded live-session visibility, not persisted to disk |
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
- Provides compact world index, world search, scene readiness, actor readiness, and bounded runtime timeline reads through live Foundry APIs.
- Provides the first guarded preview/apply write workflow for JournalEntry and JournalEntryPage create, update, and append operations.
- Provides a first guarded preview/apply scene prep workflow for scene tokens, ambient lights, and notes.
- Can restart the local Foundry application and re-establish a bridge-ready GM client through Windows Credential Manager-backed lifecycle automation.
- Has smoke coverage for MCP registration parity, dynamic trust gates, GM authorization, fallback dispatch, and revocation.

### Limitations

- Most write tools are raw Foundry document operations, so practical GM workflows still require knowing collection names, document shapes, and update payload structure.
- The preview/diff/apply transaction model currently covers journal entry/page create/update/append operations and first-pass scene token/light/note prep; broader document, wall, scene activation, macro, and compendium workflows still rely on low-level tools.
- There are no high-level guarded workflows yet for encounter setup packages, secret checks, macro authoring, compendium imports, actor/item patching, walls, or full rollback browsing.
- Complex arguments are still exposed with broad schemas in several places, which weakens MCP usability and makes client-side validation thin.
- `call_bridge_tool.args` works as a daemon object payload, but direct MCP exposure can be awkward in clients that flatten object args.
- Output is mostly free-form JSON text; important tools do not yet provide structured output schemas.
- Runtime diagnostics and timeline are bounded in memory for the current live session, not persisted as a durable disk history.
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

Status: completed for the `0.2.8` read-only development slice.

Goal: give Codex a richer understanding of live worlds without requiring raw document spelunking.

Deliverables:

- Completed: `summarize_world_index` returns compact live counts and health summary for world collections, users, active scene, compendium packs, samples, and runtime status.
- Completed: `audit_scene_readiness` performs read-only scene checks for missing background assets, unlinked or missing actor tokens, hidden tokens, grid/background state, and scene document counts.
- Completed: `audit_actor_readiness` performs read-only actor checks for images, inventories, embedded item gaps, ownership, D35E summary availability, and token linkage.
- Completed: `search_world` searches live world collections with compact stable-id results, folder names, UUIDs, and matched field names.
- Completed: `get_runtime_timeline` returns a bounded in-memory live-session timeline from runtime events, bridge requests, scene, chat, combat, and user hooks where available.

Acceptance:

- Completed: all five new tools require a trusted GM session and remain fallback-callable through `call_bridge_tool`.
- Completed: results are compact by default and pass through existing redaction.
- Completed: manifest/MCP/smoke tests cover metadata, direct exposure, fallback dispatch, and trust-gate refusal.
- Completed: live validation ran only on `scratch`.

Live findings from the `scratch` validation pass:

- Confirmed `bridge_self_check.ready=true`, active daemon world `scratch`, Foundry `14.361`, D35E `3.0.2`, module/script/manifest version `0.2.8`, and registry checksum `8d5f87740149976ed66b4b266fbdcafddb9880dd597dc9335ddbdb3b0929a996`.
- Confirmed `list_bridge_tools` exposes 41 tools and marks all five high-level read tools as category `live-read`, risk `read`, direct MCP exposed, trusted-session required, and fallback-callable.
- Confirmed `summarize_world_index({ includeSamples: true, sampleLimit: 3 })` returned world `scratch`, 1 actor, 1 scene, active scene `scratch`, 37 compendium packs, and runtime timeline status.
- Confirmed `search_world({ query: "Black Dragon", limit: 10 })` returned actor `Black Dragon, Ancient` with stable id `jPwFpRova3PUJju7` and UUID `Actor.jPwFpRova3PUJju7`.
- Confirmed `audit_scene_readiness({ includeTokens: true, tokenLimit: 5 })` returned the active `scratch` scene and correctly flagged one warning: `missing-background`.
- Confirmed `audit_actor_readiness({ includeItems: true, itemLimit: 5 })` returned actor `Black Dragon, Ancient`, ready `true`, 0 issues, and 1 token link.
- Confirmed `get_runtime_timeline({ limit: 10 })` returned 10 bounded live-session events.
- Confirmed `call_bridge_tool -> summarize_world_index` returned world `scratch` and 14 collection entries through fallback dispatch.

### Milestone 3: Previewable Write Workflows

Status: expanded through the `0.2.10` previewable scene prep transaction slice.

Goal: make mutation safer and more legible by separating planning from applying.

Deliverables:

- `plan_document_changes`: accepts high-level document intents and returns proposed Foundry operations without mutation.
- Completed in `0.2.10`: `plan_scene_changes` proposes scene token, ambient light, and note create/update operations without mutation.
- Still pending: wall, scene activation, broader scene update, document-generic, actor/item, macro, and compendium import plans.
- Completed in `0.2.9`: `plan_journal_changes` proposes journal entry/page create, update, and append operations with resolved target IDs, compact before/after previews, deterministic plan IDs and hashes, world ID, and expiration.
- Completed in `0.2.10`: `apply_bridge_plan` executes only `plan_journal_changes` and `plan_scene_changes` operations after explicit `planId`, `planHash`, and `worldId` confirmation.
- Transaction metadata with operation IDs, target document IDs, before/after summaries, backup path when applicable, and rollback references.

Acceptance:

- In progress: journal and scene plans are read-only and trusted-session gated.
- Completed for journals in `0.2.9` and scene prep in `0.2.10`: apply refuses stale, malformed, hash-mismatched, unconfirmed, cross-world, unknown-source, and unsupported-operation plans.
- Completed for journals in `0.2.9` and scene prep in `0.2.10`: existing-document or embedded-document updates create a backup first; pure creates do not.
- In progress: smoke tests cover preview, refusal, apply, backup metadata, and redaction for journal/page and first-pass scene prep plans.

Live findings from the `scratch` validation pass:

- Confirmed `bridge_self_check.ready=true`, active daemon world `scratch`, Foundry `14.361`, D35E `3.0.2`, module/script/manifest version `0.2.9`, and registry checksum `d756fb0d43467a4b82ee82f269c2b8efd72741eb1f37cff6456c722c82c27b9a`.
- Confirmed `list_bridge_tools` exposes 43 tools and includes `plan_journal_changes` and `apply_bridge_plan` as trusted-session gated, direct MCP exposed, fallback-callable transaction tools.
- Confirmed `plan_journal_changes -> create_entry` returned a read-only plan for a disposable journal named `Codex Slice 3 Disposable Validation <timestamp>`.
- Confirmed `apply_bridge_plan` created the disposable journal without requiring a backup for the pure create.
- Confirmed `plan_journal_changes -> create_page` and `apply_bridge_plan` created a text page under the disposable journal.
- Confirmed `plan_journal_changes -> append_page_section` and `apply_bridge_plan` appended content to the page and returned backup metadata for the existing-page update.
- Confirmed `get_document` verified the final journal name, two pages, and appended content.
- Confirmed `call_bridge_tool -> plan_journal_changes` returned a fallback preview plan.
- Confirmed cleanup with existing backup-first `delete_document` removed the disposable journal.

Live findings from the `scratch` Slice 4 validation pass:

- Confirmed `restart_foundry_world({ worldId: "scratch", dangerous: true })` reloaded the installed `0.2.10` module into the visible app and managed GM client.
- Confirmed `bridge_self_check.ready=true`, active daemon world `scratch`, Foundry `14.361`, D35E `3.0.2`, module/script/manifest version `0.2.10`, 2 trusted GM sessions, and registry checksum `7789e25c0c034fe802c30d26ec13b98066962bde8fb302bb1eea2f496320908a`.
- Confirmed `list_bridge_tools` exposes 44 tools and includes `plan_scene_changes` as a trusted-session gated, direct MCP exposed, fallback-callable, read-only transaction planner.
- Confirmed `plan_scene_changes -> create_token` and `apply_bridge_plan` created a disposable token on active `scratch` scene `MY3f7scvLqWb0vwA` using the live actor prototype when available.
- Confirmed `plan_scene_changes -> update_token` moved/unhid/rotated the disposable token and returned backup metadata for the existing embedded-document update.
- Confirmed `plan_scene_changes -> create_light` and `update_light` created and updated a disposable ambient light, with backup metadata for the update.
- Confirmed a disposable journal/page anchor was created, then `plan_scene_changes -> create_note` and `update_note` created and updated a scene note linked to that journal/page, with backup metadata for the update.
- Confirmed `inspect_scene` verified the final disposable token, light, and note state before cleanup.
- Confirmed `call_bridge_tool -> plan_scene_changes` returned a fallback preview plan for a token update.
- Confirmed cleanup removed the disposable token, light, note, and journal using existing backup-first delete tools.
- Runtime health after validation: no errors; deprecation warnings only from Foundry V1 Application, `Scene#background`, grid template settings, and `Scene#templates` compatibility paths.

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
{ "method": "summarize_world_index", "args": { "includeSamples": true, "sampleLimit": 3 } }
{ "method": "search_world", "args": { "query": "Black Dragon", "limit": 10 } }
{ "method": "audit_scene_readiness", "args": { "includeTokens": true, "tokenLimit": 5 } }
{ "method": "audit_actor_readiness", "args": { "includeItems": true, "itemLimit": 5 } }
{ "method": "get_runtime_timeline", "args": { "limit": 10 } }
{ "method": "plan_journal_changes", "args": { "action": "create_entry", "entryName": "Codex Disposable Validation", "pages": [{ "name": "Overview", "content": "<p>Disposable validation content.</p>" }] } }
{ "method": "plan_scene_changes", "args": { "changes": [{ "action": "create_token", "data": { "name": "Codex Disposable Token", "x": 100, "y": 100, "hidden": true } }] } }
{ "method": "apply_bridge_plan", "args": { "plan": "<returned plan>", "confirmation": { "planId": "<returned planId>", "planHash": "<returned planHash>", "worldId": "scratch" } } }
{ "method": "call_bridge_tool", "args": { "method": "summarize_world_index", "args": { "includeSamples": false } } }
```

## Deferred Decisions

These are intentionally not decided in this roadmap and should be resolved immediately before implementation:

- Whether v1.0 should introduce a separate `permissions.json` profile system or encode profiles in the trusted-world record.
- Whether transaction plans should be stored on disk, in memory, or both.
- Whether rollback should be automated for all supported operations or only assisted through backups and before/after metadata.
- Which high-level GM workflow should be implemented next after the first journal/page and scene token/light/note transaction slices. Current best next candidate: broader typed document plans or wall/scene-activation prep helpers.

## Non-Goals

- Do not remove localhost-only behavior.
- Do not remove token authentication.
- Do not remove GM-only connection requirements.
- Do not remove trusted-world authorization.
- Do not make `run_gm_script` easier to invoke accidentally.
- Do not validate or mutate `return-to-undermountain` without explicit instruction.
