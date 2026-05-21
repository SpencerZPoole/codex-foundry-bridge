# Foundry Codex Bridge Market Positioning

Reviewed: 2026-05-21

Scope: public repository documentation and the local `FoundryCodexBridge 0.2.12` capability surface. This is a product-positioning note, not a legal, financial, or exhaustive source-code audit of peer projects.

## Bottom Line

`FoundryCodexBridge` is not the first Foundry MCP and should not try to win by raw tool count alone. Public peers already cover broad Foundry control, content generation, dice, combat, tokens, journals, scenes, and installer workflows.

The valuable lane for this bridge is different: a local-first, safety-forward AI operations layer for serious Foundry projects. The strongest commercial story is not "AI can talk to Foundry." The stronger story is "AI can be trusted to inspect, prepare, modify, restart, verify, and recover a real campaign world without making the GM nervous."

That position is best summarized as **Guarded Power**.

## Public Peer Snapshot

| Project | Public posture | Where it looks stronger than us | Commercial signal |
| --- | --- | --- | --- |
| [adambdooley/foundry-vtt-mcp](https://github.com/adambdooley/foundry-vtt-mcp) | Broad Claude/Desktop campaign bridge with Windows/Mac installers, GM-only access, configurable permissions, many campaign-management tools, D&D 5e/PF2e-oriented helpers, and optional ComfyUI map generation. | Broader polished feature surface today: character management, token manipulation, player roll requests, quest/campaign dashboards, actor ownership, map generation, installers, and multi-system positioning. | Patreon support link, installer packaging, and media/demo posture show a clearer public-product track. |
| [alexivenkov/foundry-api-bridge-module](https://github.com/alexivenkov/foundry-api-bridge-module) | GM-only Foundry module that connects to a hosted Foundry MCP service with Patreon/API-key setup. Covers dice/chat, actors, actor rolls, combat, tokens, items, journals, scenes, effects, roll tables, doors, and compendiums. | More direct live-session gameplay operations today, including combat and roll helpers, A* token movement around walls/doors, scene capture, effects, roll tables, and hosted-service integration. | Strongest direct monetization proof: Patreon-backed API key/service setup through `foundry-mcp.com`. |
| [laurigates/foundryvtt-mcp](https://github.com/laurigates/foundryvtt-mcp) | MCP-native server run by `bunx`/`npx`, with a dedicated Foundry API user pattern, world search, data tools, dice, combat state, chat history, content generation, diagnostics, and `foundry://` resources. | Cleaner broad MCP resource model and easier general MCP packaging. Good developer/admin shape for querying world data and exposing resources to AI clients. | Mostly open-source/tooling signal, but the package/install ergonomics are closer to public adoption than our local private bridge. |

## What We Are Doing Differently

Based on public documentation, our most distinctive work is not broad Foundry API exposure. It is operational trust.

- **Preview/apply transactions**: `plan_journal_changes`, `plan_scene_changes`, `plan_document_changes`, and `plan_chat_messages` return caller-held `BridgePlan` previews with `planId`, `planHash`, `worldId`, expiration, warnings, compact before/after summaries, and explicit `apply_bridge_plan` confirmation.
- **Backup-first mutation posture**: destructive document and embedded-document operations create local backups, and existing-document transaction updates report backup metadata before mutation.
- **Self-diagnostics**: `bridge_self_check`, `list_bridge_tools`, registry checksums, capability manifests, direct MCP exposure flags, fallback-callable flags, and runtime event summaries make drift and broken readiness visible.
- **MCP parity fallback**: `call_bridge_tool` makes every fallback-callable registry method reachable even when direct MCP discovery lags, while still preserving each target tool's normal gates.
- **Local lifecycle restart**: `restart_foundry_world` can fully stop Foundry, relaunch the visible app, launch an explicit world, join as GM, restore a managed bridge GM client, and verify readiness with Windows Credential Manager-backed secrets.
- **Trusted-world security model**: the daemon is localhost-only and token-gated; live-world tools require a trusted GM session; sensitive output is redacted; dangerous script and lifecycle actions require explicit `dangerous=true`.
- **Live D35E campaign orientation**: the bridge has been developed against a real Foundry 14.361 / D35E 3.0.2 environment, with validation isolated to `scratch` and explicit protection against accidental `return-to-undermountain` mutation.

## Current Weaknesses Versus Peers

- We are behind on broad, polished gameplay operations such as dice rolling, actor roll helpers, initiative/combat orchestration, roll tables, active effects, walls, tiles, sounds, scene activation, and map/image generation.
- Our install and public-user onboarding are still local-development shaped, even with the credential wizard and lifecycle config scripts.
- The lifecycle restart path is valuable but Windows-specific in this slice.
- Several tools still expose broad JSON payloads and free-form outputs rather than tight schemas and public compatibility contracts.
- We do not yet have a rollback browser, transaction history viewer, persistent session timeline, packaged installer, marketplace-ready docs, or a polished GM workflow UI.
- We are currently strongest for a power user or developer-GM, not yet for a casual Foundry user.

## Monetization Verdict

This is monetizable, but the product should not be framed as "another Foundry MCP."

The strongest paid product is:

> A local-first AI GM operations assistant for Foundry that safely inspects, prepares, modifies, restarts, validates, and recovers real campaign worlds.

Likely paying audiences:

- professional GMs and paid tables with high-value campaign worlds
- power GMs running large, long-lived worlds
- Foundry module/system maintainers who need diagnostics and repeatable live validation
- DMs converting adventures, compendiums, or prep notes into Foundry-ready content
- privacy-sensitive users who do not want campaign secrets or credentials routed through hosted services

The best monetization path is probably an **open core plus paid convenience/workflow layer**:

- free/open local bridge and core safety model
- paid Windows installer and guided setup
- paid support and managed updates
- paid workflow packs such as session prep, scene readiness, compendium import, rollback browser, macro install/update, encounter setup, and session secretary
- system-specific premium packs, starting with D35E because that is where our local expertise and validation environment are strongest

Avoid leading with a hosted bridge unless the security model is redesigned deliberately. Hosted access is a plausible business model, and one peer already demonstrates it, but our clearest trust advantage is local-first operation.

## v1.0 Product Direction

Do not chase every raw Foundry API operation just because peers expose it. Use peers as evidence that basic "AI controls Foundry" is already becoming commodity infrastructure.

For v1.0, prioritize the work that reinforces the distinct lane:

1. Finish preview/apply coverage for the most common GM workflows: walls, scene activation, actor/item patching, embedded item helpers, compendium-to-world imports, and macro install/update.
2. Add rollback browsing and assisted restore from backup metadata.
3. Add persistent session timeline and a session-secretary workflow that can summarize what happened without relying on raw chat/log dumps.
4. Tighten schemas and output contracts for every transaction and high-value read tool.
5. Package setup for real users: installer, credential wizard polish, compatibility matrix, first-run self-check, and one-click `scratch` validation.
6. Produce a public demo that shows the bridge preventing a bad edit, previewing a good edit, applying it with confirmation, and verifying the resulting Foundry state.

The commercial message should stay practical:

- safer than raw scripting
- more operational than a chat-only assistant
- more private than hosted world access
- more recoverable than direct mutation tools
- designed for real campaign worlds, not disposable demos

