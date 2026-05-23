# Foundry Codex Bridge Market Positioning

Reviewed: 2026-05-21

Scope: public repository documentation and the local `FoundryCodexBridge 0.2.14` capability surface. This note compares public project positioning, not private implementation details or exhaustive source history.

## Positioning Summary

Foundry Codex Bridge is part of a growing ecosystem of AI-to-Foundry tooling. Public peers already demonstrate broad Foundry control, content generation, dice and combat workflows, MCP resources, hosted service models, and installer packaging.

This project is intentionally positioned around a narrower but commercially meaningful lane: local-first, safety-forward AI operations for serious Foundry worlds.

The public message is **Guarded Power**:

- make useful live-world work possible from Codex
- preserve local control and GM consent
- preview important changes before applying them
- keep diagnostics, backups, redaction, and explicit high-risk gates close to the workflow

## Public Peer Snapshot

| Project | Public posture | What it demonstrates |
| --- | --- | --- |
| [adambdooley/foundry-vtt-mcp](https://github.com/adambdooley/foundry-vtt-mcp) | Broad Claude/Desktop campaign bridge with installers, GM-only access, configurable permissions, campaign-management tools, system-oriented helpers, and optional image/map generation. | Strong public product surface, broad feature coverage, and user-friendly packaging. |
| [alexivenkov/foundry-api-bridge-module](https://github.com/alexivenkov/foundry-api-bridge-module) | GM-only Foundry module connected to a hosted Foundry MCP service with Patreon/API-key setup. Covers dice/chat, actors, actor rolls, combat, tokens, items, journals, scenes, effects, roll tables, doors, and compendiums. | Clear evidence that hosted Foundry AI bridges can be packaged as a supported/donation-backed service. |
| [laurigates/foundryvtt-mcp](https://github.com/laurigates/foundryvtt-mcp) | MCP-native server with a dedicated Foundry API user pattern, world search, data tools, dice, combat state, chat history, content generation, diagnostics, and `foundry://` resources. | Clean MCP ergonomics, useful resource exposure, and a strong developer/admin workflow shape. |

## Differentiators

The bridge's most distinctive work is operational trust rather than raw API breadth.

- **Preview/apply transactions**: `plan_journal_changes`, `plan_scene_changes`, `plan_document_changes`, and `plan_chat_messages` return caller-held `BridgePlan` previews with `planId`, `planHash`, `worldId`, expiration, compact before/after summaries, warnings, and explicit `apply_bridge_plan` confirmation.
- **Backup-first mutation posture**: destructive document operations create local backups, and transaction updates report backup metadata before mutation.
- **Self-diagnostics**: `bridge_self_check`, `list_bridge_tools`, registry checksums, capability manifests, direct MCP exposure flags, fallback-callable flags, and runtime summaries make drift and broken readiness visible.
- **Agent first-contact onboarding**: `get_bridge_quickstart`, MCP resources, and the `foundry_bridge_first_contact` prompt help a new agent learn the bridge before touching live-world tools.
- **MCP parity fallback**: `call_bridge_tool` keeps registry tools reachable when direct MCP discovery lags, while preserving each target tool's normal gates.
- **Local lifecycle restart**: `restart_foundry_world` can stop Foundry, relaunch the visible app, launch an explicit world, join as GM, restore a managed bridge GM client, and verify readiness with Windows Credential Manager-backed secrets.
- **Trusted-world model**: the daemon is localhost-only and token-gated; live-world tools require a trusted GM session; sensitive output is redacted; dangerous script and lifecycle actions require explicit `dangerous=true`.
- **Real-system validation**: development has been grounded in a live Foundry 14 / D35E validation environment, with disposable-world validation separated from private campaign work.

## Current Gaps

These are useful product signals, not criticisms of the architecture.

- Broader gameplay operations such as dice rolling, actor roll helpers, combat orchestration, roll tables, active effects, walls, tiles, sounds, scene activation, and map/image generation remain future work.
- Agent first-contact onboarding is now present in `0.2.14`, but public onboarding still needs packaging polish beyond the current local development scripts.
- Public docs still need richer end-to-end examples for real GM workflows beyond the first-contact checklist.
- Lifecycle restart is currently Windows-oriented.
- Several tools still expose broad JSON payloads and free-form outputs rather than tight schemas and public compatibility contracts.
- The project does not yet include a rollback browser, transaction history viewer, persistent session timeline, packaged installer, marketplace-ready docs, or polished GM workflow UI.

## Monetization View

The most compelling paid-product framing is not "another Foundry MCP." It is:

> A local-first AI GM operations assistant for Foundry that safely inspects, prepares, modifies, restarts, validates, and recovers real campaign worlds.

Likely interested audiences:

- professional GMs and paid tables with high-value campaign worlds
- power GMs running large, long-lived worlds
- Foundry module and system maintainers who need diagnostics and repeatable live validation
- DMs converting adventures, compendiums, or prep notes into Foundry-ready content
- privacy-sensitive users who prefer local campaign operations over hosted world access

A practical monetization path is open core plus paid convenience/workflow layers:

- free/open local bridge and safety model
- paid installer and guided setup
- paid support and managed updates
- paid workflow packs such as session prep, scene readiness, compendium import, rollback browser, macro install/update, encounter setup, and session secretary
- system-specific premium packs, starting with D35E because that is the first deeply validated environment

Hosted access could be a separate future product, but the clearest trust advantage today is local-first operation.

## Product Direction

For v1.0, avoid chasing raw operation parity as the main goal. Focus on the work that reinforces the distinct lane:

1. Finish preview/apply coverage for common GM workflows: walls, scene activation, actor/item patching, embedded item helpers, compendium-to-world imports, and macro install/update.
2. Add rollback browsing and assisted restore from backup metadata.
3. Add persistent session timeline and a session-secretary workflow that summarizes play without relying on raw chat/log dumps.
4. Tighten schemas and output contracts for transaction and high-value read tools.
5. Package setup for real users: installer, credential wizard polish, compatibility matrix, first-run self-check, and one-click disposable-world validation.
6. Produce a public demo that shows the bridge preventing a bad edit, previewing a good edit, applying it with confirmation, and verifying the resulting Foundry state.

The commercial message should stay practical: safer than raw scripting, more operational than a chat-only assistant, more private than hosted world access, more recoverable than direct mutation tools, and designed for real campaign worlds.
