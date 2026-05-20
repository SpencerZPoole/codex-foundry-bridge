#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const DAEMON_PATH = path.join(ROOT, "src", "server.js");
const BRIDGE_HOST = process.env.FOUNDRY_BRIDGE_HOST || "127.0.0.1";
const BRIDGE_PORT = Number(process.env.FOUNDRY_BRIDGE_PORT || 30123);
const BRIDGE_URL = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;
const BRIDGE_TOKEN = getBridgeToken();

function getBridgeToken() {
  if (process.env.CODEX_FOUNDRY_BRIDGE_TOKEN) return process.env.CODEX_FOUNDRY_BRIDGE_TOKEN;
  if (process.platform !== "win32") return "";

  try {
    return execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "[Environment]::GetEnvironmentVariable('CODEX_FOUNDRY_BRIDGE_TOKEN','User')"
      ],
      { encoding: "utf8", windowsHide: true }
    ).trim();
  } catch {
    return "";
  }
}

if (!BRIDGE_TOKEN) {
  console.error("CODEX_FOUNDRY_BRIDGE_TOKEN is required.");
  process.exit(1);
}

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function daemonStatus() {
  const response = await fetch(`${BRIDGE_URL}/status`);
  if (!response.ok) throw new Error(`Bridge daemon status failed: ${response.status}`);
  return response.json();
}

async function ensureDaemon() {
  try {
    return await daemonStatus();
  } catch {
    const child = spawn(process.execPath, [DAEMON_PATH, "--daemon"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        CODEX_FOUNDRY_BRIDGE_TOKEN: BRIDGE_TOKEN,
        FOUNDRY_BRIDGE_HOST: BRIDGE_HOST,
        FOUNDRY_BRIDGE_PORT: String(BRIDGE_PORT)
      }
    });
    child.unref();
  }

  let lastError = null;
  for (let i = 0; i < 30; i += 1) {
    try {
      return await daemonStatus();
    } catch (error) {
      lastError = error;
      await sleep(200);
    }
  }
  throw new Error(`Bridge daemon did not start: ${lastError?.message ?? "unknown error"}`);
}

async function callDaemon(method, args = {}) {
  await ensureDaemon();
  const response = await fetch(`${BRIDGE_URL}/call`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bridge-token": BRIDGE_TOKEN
    },
    body: JSON.stringify({ method, args })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error ?? `Bridge daemon call failed: ${response.status}`);
  }
  return payload.result;
}

const AnyJson = z.any().optional();
const server = new McpServer({
  name: "foundry-codex-bridge",
  version: "0.2.2"
});

function registerProxyTool(name, title, description, inputSchema = {}) {
  server.registerTool(
    name,
    { title, description, inputSchema },
    async (args) => textResult(await callDaemon(name, args ?? {}))
  );
}

registerProxyTool("foundry_status", "Foundry status", "Report Foundry runtime status, bridge daemon state, and active GM session metadata.");
registerProxyTool("list_collections", "List Foundry collections", "List live Foundry world collections from the connected GM session.");
registerProxyTool("get_document", "Get Foundry document", "Read a Foundry document by collection and id or name.", {
  collection: z.string(),
  id: z.string(),
  includeEmbedded: z.boolean().optional()
});
registerProxyTool("search_documents", "Search Foundry documents", "Search live documents in a collection.", {
  collection: z.string(),
  query: z.string().optional(),
  limit: z.number().optional()
});
registerProxyTool("list_scenes", "List scenes", "List scenes in the active world.");
registerProxyTool("inspect_scene", "Inspect scene", "Read a scene including embedded scene documents.", {
  id: z.string().optional()
});
registerProxyTool("list_users", "List users", "List Foundry users from the live world with sensitive fields redacted.");
registerProxyTool("read_settings", "Read settings", "Read live Foundry settings with sensitive fields redacted.", {
  namespace: z.string().optional()
});
registerProxyTool("tail_logs", "Tail Foundry logs", "Read recent Foundry log lines from local log files with secret-like fields redacted.", {
  file: z.string().optional(),
  limit: z.number().optional()
});
registerProxyTool("get_runtime_events", "Get runtime events", "Read recent live GM-client runtime warnings, errors, notifications, and bridge request failures.", {
  limit: z.number().optional(),
  level: z.string().optional(),
  source: z.string().optional(),
  since: z.string().optional()
});
registerProxyTool("clear_runtime_events", "Clear runtime events", "Clear the live GM-client runtime event buffer.");
registerProxyTool("export_world_snapshot", "Export world snapshot", "Create a sanitized live snapshot of collections and basic server metadata.");
registerProxyTool("create_document", "Create document", "Create a Foundry world document through the live GM session.", {
  documentName: z.string(),
  data: AnyJson
});
registerProxyTool("update_document", "Update document", "Update a Foundry world document through the live GM session.", {
  collection: z.string(),
  id: z.string(),
  data: AnyJson
});
registerProxyTool("delete_document", "Delete document", "Delete a Foundry world document after creating a local backup.", {
  collection: z.string(),
  id: z.string()
});
registerProxyTool("create_embedded_document", "Create embedded document", "Create an embedded Foundry document such as a TokenDocument on a Scene.", {
  parentCollection: z.string(),
  parentId: z.string(),
  embeddedName: z.string(),
  data: AnyJson
});
registerProxyTool("update_embedded_document", "Update embedded document", "Update an embedded Foundry document such as a TokenDocument on a Scene.", {
  parentCollection: z.string(),
  parentId: z.string(),
  embeddedName: z.string(),
  data: AnyJson
});
registerProxyTool("delete_embedded_document", "Delete embedded document", "Delete an embedded Foundry document after creating a local backup.", {
  parentCollection: z.string(),
  parentId: z.string(),
  embeddedName: z.string(),
  embeddedId: z.string()
});
registerProxyTool("create_chat_message", "Create chat message", "Create a chat message in the active world.", {
  content: z.string(),
  speaker: AnyJson,
  whisper: AnyJson,
  blind: z.boolean().optional()
});
registerProxyTool("run_macro", "Run macro", "Run a Foundry macro by id or name through the GM session.", {
  id: z.string().optional(),
  name: z.string().optional(),
  context: AnyJson
});
registerProxyTool("run_gm_script", "Run GM script", "Run explicit JavaScript in the live GM client. Requires dangerous=true.", {
  script: z.string(),
  context: AnyJson,
  dangerous: z.boolean()
});
registerProxyTool("list_installed_packages", "List installed packages", "List installed local systems, modules, and worlds from Foundry data.");
registerProxyTool("read_foundry_options_sanitized", "Read sanitized Foundry options", "Read Foundry options.json with secrets redacted.");
registerProxyTool("list_trusted_worlds", "List trusted worlds", "List Foundry worlds authorized to connect through this local bridge.");
registerProxyTool("revoke_trusted_world", "Revoke trusted world", "Remove a Foundry world from the local bridge trusted-world list.", {
  worldId: z.string()
});
registerProxyTool("backup_world", "Backup world", "Copy the active world directory to the bridge backup folder.");
registerProxyTool("install_or_update_bridge_module", "Install or update bridge module", "Copy the bridge Foundry module into the local Foundry modules directory.");

const transport = new StdioServerTransport();
await server.connect(transport);
