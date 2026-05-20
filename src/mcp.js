#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BRIDGE_VERSION, TOOL_DEFINITIONS } from "./tool-registry.js";

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

const server = new McpServer({
  name: "foundry-codex-bridge",
  version: BRIDGE_VERSION
});

function registerProxyTool(tool) {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema
    },
    async (args) => textResult(await callDaemon(tool.name, args ?? {}))
  );
}

for (const tool of TOOL_DEFINITIONS) {
  registerProxyTool(tool);
}

const transport = new StdioServerTransport();
await server.connect(transport);
