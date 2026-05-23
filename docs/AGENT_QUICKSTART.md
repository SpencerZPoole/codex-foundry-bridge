# Foundry Codex Bridge Agent Quickstart

Use this file when an agent encounters a new Foundry Codex Bridge installation for the first time.

This guide is intentionally conservative. It teaches discovery and safety before it teaches power. The live source of truth is always the current bridge response from `bridge_self_check` and `list_bridge_tools`.

## First Contact Checklist

1. Call `bridge_self_check`.
2. Call `list_bridge_tools`.
3. Call `get_bridge_quickstart({ format: "json" })` when a compact machine-readable guide is useful.
4. Read `foundry://bridge/quickstart` and `foundry://bridge/capabilities` if MCP resources are available.
5. Prefer direct MCP tools when they are visible.
6. Use `call_bridge_tool` only when direct MCP discovery is stale or incomplete.
7. Do not use trusted-session tools until a GM has opened the target world, enabled the module, set the bridge token, and authorized the world.
8. Prefer `plan_*` tools plus `apply_bridge_plan` for writes.
9. Validate disposable behavior on `scratch` unless the user explicitly names another world.
10. Treat `restart_foundry_world` and `run_gm_script` as explicit-danger workflows.

## Safety Rules

- The daemon is local-first and token-authenticated with `CODEX_FOUNDRY_BRIDGE_TOKEN`.
- Live-world reads and writes require a connected trusted GM session.
- `call_bridge_tool` is a fallback dispatcher, not a privilege bypass.
- `apply_bridge_plan` requires the full returned plan plus matching `planId`, `planHash`, and `worldId`.
- `run_gm_script` and `restart_foundry_world` require `dangerous=true`.
- Outputs are redacted for token-like and credential-like fields, but agents should still avoid requesting or echoing secrets.
- Do not validate, launch, or mutate a private production campaign world unless the user explicitly names that world.

## Preferred Workflow

For diagnostics, call `bridge_self_check` first and then `list_bridge_tools`.

For read-only work, prefer compact tools such as `summarize_world_index`, `search_world`, `summarize_actor`, `summarize_scene`, readiness audits, compendium search, and runtime timeline reads before raw document reads.

For writes, prefer previewable transactions:

- `plan_journal_changes`
- `plan_scene_changes`
- `plan_document_changes`
- `plan_chat_messages`
- `apply_bridge_plan`

Use low-level document write tools only when the user explicitly needs raw Foundry document control and the target world/session is trusted.

For lifecycle recovery, use `restart_foundry_world` only with an explicit `worldId` and `dangerous=true`. This fully restarts the local Foundry app and should not be treated like a normal live-world tool.

## What Agents Should Learn From Discovery

`bridge_self_check` tells you whether the daemon, Foundry API, module install path, trusted GM session, module version, registry checksum, and runtime diagnostics look ready.

`list_bridge_tools` tells you each tool's category, risk, read/write status, trusted-session requirement, direct MCP exposure, fallback compatibility, input keys, output-shape name, and examples when available.

`get_bridge_quickstart` gives a compact JSON or markdown summary of first-contact steps, safety rules, preferred workflow, MCP resource URIs, prompt name, and example-heavy tools.

`call_bridge_tool` can reach registered tools when direct MCP discovery is stale, but it still runs the target tool through the same daemon dispatch and safety gates.

## Useful First Calls

```json
{ "method": "bridge_self_check" }
```

```json
{ "method": "list_bridge_tools" }
```

```json
{ "method": "get_bridge_quickstart", "args": { "format": "json" } }
```

```json
{ "method": "call_bridge_tool", "args": { "method": "list_bridge_tools" } }
```

## MCP Resources And Prompt

The MCP adapter exposes:

- `foundry://bridge/quickstart`
- `foundry://bridge/capabilities`
- `foundry://bridge/readme`

It also exposes the `foundry_bridge_first_contact` prompt for clients that support MCP prompts.

## Release Notes

This onboarding surface was added in `0.2.14`. It adds no new live Foundry powers. It only makes the existing bridge capability surface easier to discover on new installations and new computers.
