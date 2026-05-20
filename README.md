# Foundry Codex Bridge

Local-only bridge between Codex MCP tools and a trusted FoundryVTT GM client.

## Shape

- `src/server.js` runs the Codex MCP server over stdio and a localhost WebSocket endpoint for Foundry.
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
- `list_trusted_worlds` lists authorized world ids and metadata.
- `revoke_trusted_world` removes a world from the trusted list.

If the module cannot be enabled from the Foundry UI, close Foundry completely and run:

```powershell
powershell -ExecutionPolicy Bypass -File G:\DungeonsAndDragonsDMFolder\FoundryCodexBridge\scripts\enable-world-module-offline.ps1
```

That helper refuses to run while Foundry is open and backs up `settings.db` first.

## Safety

- Live world edits go through Foundry document APIs, not raw `.db` writes.
- Destructive document tools create a timestamped backup under `backups/`.
- Secrets, hashes, license/admin keys, and token-like fields are redacted from tool results.
- `run_gm_script` requires `dangerous=true`.
- Live-world tools require a connected, trusted GM session; unknown worlds stay pending until authorized by the GM.
- Runtime diagnostics are observational only; they do not change Foundry behavior or world data.
