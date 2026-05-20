#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const MODULE_SOURCE_DIR = path.join(ROOT, "module");
const DEFAULT_FOUNDRY_DATA = path.join(os.homedir(), "AppData", "Local", "FoundryVTT");
const FOUNDRY_DATA_DIR = process.env.FOUNDRY_DATA_DIR || DEFAULT_FOUNDRY_DATA;
const CONFIG_DIR = process.env.FOUNDRY_BRIDGE_CONFIG_DIR || path.join(ROOT, "config");
const TRUSTED_WORLDS_FILE = process.env.FOUNDRY_BRIDGE_TRUSTED_WORLDS_FILE || path.join(CONFIG_DIR, "trusted-worlds.json");
const BRIDGE_HOST = process.env.FOUNDRY_BRIDGE_HOST || "127.0.0.1";
const BRIDGE_PORT = Number(process.env.FOUNDRY_BRIDGE_PORT || 30123);
const BRIDGE_TOKEN = getBridgeToken();
const REQUEST_TIMEOUT_MS = Number(process.env.FOUNDRY_BRIDGE_TIMEOUT_MS || 30000);
const MCP_NAME = "foundry-codex-bridge";
const SENSITIVE_FIELD_PATTERN = /password|secret|license|adminPassword|adminKey|apiKey|privateKey|hash|salt|accessToken|refreshToken|bearerToken|bridgeToken/i;

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

const sessions = new Set();
const pending = new Map();
let requestSeq = 0;

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitiveField(key)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redact(entry);
    }
  }
  return output;
}

function isSensitiveField(key) {
  return String(key).toLowerCase() === "token" || SENSITIVE_FIELD_PATTERN.test(key);
}

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(redact(value), null, 2)
      }
    ]
  };
}

function errorResult(error) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error)
      }
    ]
  };
}

function paths(worldId = activeWorldId()) {
  const data = FOUNDRY_DATA_DIR;
  return {
    data,
    world: worldId ? path.join(data, "Data", "worlds", worldId) : null,
    logs: path.join(data, "Logs"),
    options: path.join(data, "Config", "options.json"),
    modules: path.join(data, "Data", "modules"),
    moduleInstall: path.join(data, "Data", "modules", "codex-foundry-bridge"),
    backups: path.join(ROOT, "backups"),
    configDir: CONFIG_DIR,
    trustedWorlds: TRUSTED_WORLDS_FILE
  };
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sanitizeOptions(options) {
  const clone = redact(options);
  delete clone.adminPassword;
  delete clone.adminKey;
  return clone;
}

function normalizeWorldId(worldId) {
  return String(worldId ?? "").trim();
}

function emptyTrustedWorlds() {
  return {
    version: 1,
    worlds: []
  };
}

function readTrustedWorlds() {
  if (!fs.existsSync(TRUSTED_WORLDS_FILE)) return emptyTrustedWorlds();

  const parsed = readJsonFile(TRUSTED_WORLDS_FILE);
  const worlds = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.worlds)
      ? parsed.worlds
      : [];

  return {
    version: 1,
    worlds: worlds
      .map((world) => ({
        id: normalizeWorldId(world.id ?? world.worldId),
        title: String(world.title ?? world.worldTitle ?? world.id ?? world.worldId ?? ""),
        systemId: world.systemId ?? null,
        systemVersion: world.systemVersion ?? null,
        foundryVersion: world.foundryVersion ?? null,
        authorizedAt: world.authorizedAt ?? null,
        authorizedBy: world.authorizedBy ? redact(world.authorizedBy) : null
      }))
      .filter((world) => world.id)
  };
}

function writeTrustedWorlds(data) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const normalized = {
    version: 1,
    worlds: [...data.worlds]
      .filter((world) => normalizeWorldId(world.id))
      .sort((a, b) => a.id.localeCompare(b.id))
  };
  const tempPath = `${TRUSTED_WORLDS_FILE}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(redact(normalized), null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, TRUSTED_WORLDS_FILE);
  return normalized;
}

function trustedWorldMap() {
  const map = new Map();
  for (const world of readTrustedWorlds().worlds) {
    map.set(world.id, world);
  }
  return map;
}

function listTrustedWorlds() {
  return [...trustedWorldMap().values()].sort((a, b) => a.id.localeCompare(b.id));
}

function isTrustedWorld(worldId) {
  return trustedWorldMap().has(normalizeWorldId(worldId));
}

function sessionMetadata(message) {
  return redact({
    id: normalizeWorldId(message?.worldId),
    title: message?.worldTitle ?? message?.worldId ?? "",
    systemId: message?.systemId ?? null,
    systemVersion: message?.systemVersion ?? null,
    foundryVersion: message?.foundryVersion ?? null,
    authorizedAt: new Date().toISOString(),
    authorizedBy: message?.user
      ? {
          id: message.user.id ?? null,
          name: message.user.name ?? null,
          role: message.user.role ?? null,
          isGM: message.user.isGM === true
        }
      : null
  });
}

function trustWorld(message) {
  const world = sessionMetadata(message);
  if (!world.id) throw new Error("Cannot authorize a Foundry world without a world id.");
  if (message?.user?.isGM !== true) throw new Error("Only a GM session can authorize a Foundry world.");

  const map = trustedWorldMap();
  map.set(world.id, world);
  writeTrustedWorlds({ version: 1, worlds: [...map.values()] });
  return world;
}

function revokeTrustedWorld(worldId) {
  const normalizedWorldId = normalizeWorldId(worldId);
  if (!normalizedWorldId) throw new Error("worldId is required.");

  const map = trustedWorldMap();
  const existed = map.delete(normalizedWorldId);
  writeTrustedWorlds({ version: 1, worlds: [...map.values()] });

  for (const session of sessions) {
    if (session.hello?.worldId === normalizedWorldId) session.trusted = false;
  }

  return { revoked: existed, worldId: normalizedWorldId };
}

function readNdjson(filePath, limit = 50) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.slice(-limit).map((line) => {
    try {
      return redact(JSON.parse(line));
    } catch {
      return "[UNPARSEABLE LINE REDACTED]";
    }
  });
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

function copyDirectoryBestEffort(source, destination, report) {
  fs.mkdirSync(destination, { recursive: true });
  let entries = [];
  try {
    entries = fs.readdirSync(source, { withFileTypes: true });
  } catch (error) {
    report.skipped.push({ path: source, reason: error.message });
    return;
  }

  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryBestEffort(sourcePath, destinationPath, report);
    } else if (entry.isFile()) {
      try {
        fs.copyFileSync(sourcePath, destinationPath);
        report.copied += 1;
      } catch (error) {
        report.skipped.push({ path: sourcePath, reason: error.message });
      }
    }
  }
}

async function writeLiveSnapshot(destination) {
  if (!activeSession()) return null;
  const snapshot = {
    createdAt: new Date().toISOString(),
    status: await sendFoundryRequest("foundry_status", {}),
    collections: await sendFoundryRequest("list_collections", {}),
    scenes: await sendFoundryRequest("list_scenes", {}),
    users: await sendFoundryRequest("list_users", {}),
    settings: await sendFoundryRequest("read_settings", {})
  };
  const snapshotPath = path.join(destination, "live-world-snapshot.json");
  fs.writeFileSync(snapshotPath, JSON.stringify(redact(snapshot), null, 2), "utf8");
  return snapshotPath;
}

async function backupWorld() {
  const session = activeSession();
  if (!session) {
    throw new Error("No connected trusted GM Foundry bridge session. Open the world as GM and authorize it from the bridge prompt.");
  }

  const worldId = session.hello.worldId;
  const p = paths(worldId);
  if (!fs.existsSync(p.world)) throw new Error(`World directory not found: ${p.world}`);
  fs.mkdirSync(p.backups, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.join(p.backups, `${worldId}-${stamp}`);
  const report = { copied: 0, skipped: [] };
  copyDirectoryBestEffort(p.world, destination, report);

  let liveSnapshotPath = null;
  try {
    liveSnapshotPath = await writeLiveSnapshot(destination);
  } catch (error) {
    report.skipped.push({ path: "live-world-snapshot.json", reason: error.message });
  }

  const metadata = {
    createdAt: new Date().toISOString(),
    worldId,
    source: p.world,
    copiedFiles: report.copied,
    skippedFiles: report.skipped,
    completeFileCopy: report.skipped.length === 0,
    liveSnapshotPath
  };
  fs.writeFileSync(path.join(destination, "backup-metadata.json"), JSON.stringify(redact(metadata), null, 2), "utf8");

  return {
    ok: true,
    backupPath: destination,
    copiedFiles: report.copied,
    skippedFileCount: report.skipped.length,
    completeFileCopy: report.skipped.length === 0,
    liveSnapshotPath,
    note: report.skipped.length
      ? "Some files were locked or unreadable. See backup-metadata.json for skipped paths."
      : "File copy completed without skipped files."
  };
}

function isTrustedSession(session) {
  return session?.open === true
    && session.hello?.user?.isGM === true
    && isTrustedWorld(session.hello?.worldId);
}

function activeSession() {
  for (const session of sessions) {
    if (isTrustedSession(session)) {
      return session;
    }
  }
  return null;
}

function activeWorldId() {
  return activeSession()?.hello?.worldId ?? null;
}

function pendingAuthorizationSessions() {
  return [...sessions]
    .filter((session) => session.open && session.hello?.user?.isGM === true && !isTrustedSession(session))
    .map((session) => session.hello);
}

function sendFoundryRequest(method, args = {}, { requireConnected = true } = {}) {
  const session = activeSession();
  if (!session) {
    if (requireConnected) {
      throw new Error("No connected trusted GM Foundry bridge session. Open the world as GM, activate the module, set the bridge token, and authorize this world.");
    }
    return null;
  }

  const id = ++requestSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Foundry request timed out: ${method}`));
    }, REQUEST_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer });
    session.ws.send(JSON.stringify({ type: "request", id, method, args }));
  });
}

async function foundryStatus() {
  const session = activeSession();
  const p = paths(session?.hello?.worldId ?? null);
  const liveStatus = await fetch("http://127.0.0.1:30000/api/status")
    .then((response) => response.json())
    .catch(() => null);
  const bridgeStatus = session
    ? await sendFoundryRequest("foundry_status", {})
    : null;
  return {
    foundryApi: liveStatus,
    bridge: {
      listening: true,
      host: BRIDGE_HOST,
      port: BRIDGE_PORT,
      connected: Boolean(bridgeStatus),
      session: session?.hello ?? null,
      pendingAuthorization: pendingAuthorizationSessions(),
      trustedWorlds: listTrustedWorlds()
    },
    liveSession: bridgeStatus,
    paths: {
      data: p.data,
      world: p.world,
      moduleInstall: p.moduleInstall,
      trustedWorlds: p.trustedWorlds
    }
  };
}

async function tailLogs({ file = "debug.log", limit = 80 }) {
  const p = paths();
  const allowed = new Set([
    "debug.log",
    "error.log",
    "debug.today.log",
    "error.today.log",
    "diagnostics.json",
    "news.json"
  ]);
  if (!allowed.has(file)) throw new Error(`Unsupported log file: ${file}`);
  const today = new Date().toISOString().slice(0, 10);
  const resolvedFile = file === "debug.today.log"
    ? `debug.${today}.log`
    : file === "error.today.log"
      ? `error.${today}.log`
      : file;
  const fullPath = path.join(p.logs, resolvedFile);
  if (file.endsWith(".json")) return redact(readJsonFile(fullPath));
  const lines = fs.existsSync(fullPath)
    ? fs.readFileSync(fullPath, "utf8").split(/\r?\n/).filter(Boolean).slice(-limit)
    : [];
  return lines.map((line) => line.replace(/(password|token|secret|license|key)=\S+/gi, "$1=[REDACTED]"));
}

async function listInstalledPackages() {
  const p = paths();
  const packageRoots = {
    systems: path.join(p.data, "Data", "systems"),
    modules: path.join(p.data, "Data", "modules"),
    worlds: path.join(p.data, "Data", "worlds")
  };
  const result = {};
  for (const [kind, root] of Object.entries(packageRoots)) {
    result[kind] = [];
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestName = kind === "worlds" ? "world.json" : kind === "systems" ? "system.json" : "module.json";
      const manifestPath = path.join(root, entry.name, manifestName);
      if (fs.existsSync(manifestPath)) {
        const manifest = redact(readJsonFile(manifestPath));
        result[kind].push({
          id: manifest.id ?? entry.name,
          title: manifest.title,
          version: manifest.version,
          compatibility: manifest.compatibility
        });
      }
    }
  }
  return result;
}

async function executeTool(method, args = {}) {
  switch (method) {
    case "foundry_status":
      return foundryStatus();
    case "list_collections":
    case "get_document":
    case "search_documents":
    case "list_scenes":
    case "inspect_scene":
    case "list_users":
    case "read_settings":
    case "get_runtime_events":
    case "clear_runtime_events":
    case "create_document":
    case "update_document":
    case "create_embedded_document":
    case "update_embedded_document":
    case "create_chat_message":
    case "run_macro":
      return sendFoundryRequest(method, args);
    case "delete_document": {
      const backup = await backupWorld();
      const deleted = await sendFoundryRequest(method, args);
      return { backup, deleted };
    }
    case "delete_embedded_document": {
      const backup = await backupWorld();
      const deleted = await sendFoundryRequest(method, args);
      return { backup, deleted };
    }
    case "run_gm_script":
      if (args.dangerous !== true) throw new Error("run_gm_script requires dangerous=true");
      return sendFoundryRequest(method, args);
    case "tail_logs":
      return tailLogs(args);
    case "export_world_snapshot":
      return {
        collections: await sendFoundryRequest("list_collections", {}),
        scenes: await sendFoundryRequest("list_scenes", {}),
        users: await sendFoundryRequest("list_users", {}),
        settings: await sendFoundryRequest("read_settings", {})
      };
    case "list_installed_packages":
      return listInstalledPackages();
    case "read_foundry_options_sanitized":
      return sanitizeOptions(readJsonFile(paths().options));
    case "list_trusted_worlds":
      return { trustedWorlds: listTrustedWorlds(), path: TRUSTED_WORLDS_FILE };
    case "revoke_trusted_world":
      return revokeTrustedWorld(args.worldId);
    case "backup_world":
      return backupWorld();
    case "install_or_update_bridge_module": {
      const p = paths();
      copyDirectory(MODULE_SOURCE_DIR, p.moduleInstall);
      return { ok: true, installedTo: p.moduleInstall };
    }
    default:
      throw new Error(`Unknown bridge method: ${method}`);
  }
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) {
        reject(new Error("Request body is too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function startBridgeServer() {
  const httpServer = http.createServer(async (request, response) => {
    if (request.url === "/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        host: BRIDGE_HOST,
        port: BRIDGE_PORT,
        connectedSessions: sessions.size,
        trustedSessions: [...sessions].filter(isTrustedSession).length,
        pendingAuthorizationSessions: pendingAuthorizationSessions().length,
        activeWorld: activeSession()?.hello?.worldId ?? null,
        trustedWorlds: listTrustedWorlds().map((world) => world.id)
      }));
      return;
    }

    if (request.url === "/call" && request.method === "POST") {
      try {
        if (request.headers["x-bridge-token"] !== BRIDGE_TOKEN) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: "Invalid bridge token" }));
          return;
        }

        const body = await readRequestBody(request);
        const payload = body ? JSON.parse(body) : {};
        const result = await executeTool(payload.method, payload.args ?? {});
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, result: redact(result) }));
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }));
      }
      return;
    }

    response.writeHead(404);
    response.end();
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/foundry" });
  wss.on("connection", (ws, request) => {
    const address = request.socket.remoteAddress;
    const localOnly = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
    if (!localOnly) {
      ws.close(1008, "Local connections only");
      return;
    }

    const session = { ws, open: true, hello: null, trusted: false };
    sessions.add(session);

    ws.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        ws.close(1003, "Invalid JSON");
        return;
      }

      if (message.type === "hello") {
        if (message.token !== BRIDGE_TOKEN) {
          ws.close(1008, "Invalid token");
          return;
        }
        if (message.user?.isGM !== true) {
          ws.close(1008, "GM session required");
          return;
        }
        session.hello = redact(message);
        session.trusted = isTrustedWorld(message.worldId);
        ws.send(JSON.stringify({
          type: "authorizationStatus",
          trusted: session.trusted,
          world: session.hello,
          trustedWorlds: listTrustedWorlds().map((world) => world.id)
        }));
        return;
      }

      if (message.type === "authorizeWorld") {
        if (message.token !== BRIDGE_TOKEN) {
          ws.close(1008, "Invalid token");
          return;
        }
        if (!session.hello || session.hello.user?.isGM !== true) {
          ws.close(1008, "GM session required before authorization");
          return;
        }
        const world = trustWorld({
          ...session.hello,
          ...message,
          worldId: session.hello.worldId,
          worldTitle: session.hello.worldTitle,
          user: session.hello.user
        });
        session.trusted = true;
        ws.send(JSON.stringify({
          type: "authorizationStatus",
          trusted: true,
          world,
          trustedWorlds: listTrustedWorlds().map((entry) => entry.id)
        }));
        return;
      }

      if (message.type === "revokeWorld") {
        if (message.token !== BRIDGE_TOKEN) {
          ws.close(1008, "Invalid token");
          return;
        }
        if (!session.hello || session.hello.user?.isGM !== true) {
          ws.close(1008, "GM session required before revocation");
          return;
        }
        const result = revokeTrustedWorld(session.hello.worldId);
        ws.send(JSON.stringify({
          type: "authorizationStatus",
          trusted: false,
          world: session.hello,
          revocation: result,
          trustedWorlds: listTrustedWorlds().map((entry) => entry.id)
        }));
        return;
      }

      if (message.type === "response") {
        const item = pending.get(message.id);
        if (!item) return;
        clearTimeout(item.timer);
        pending.delete(message.id);
        if (message.ok) item.resolve(redact(message.result));
        else item.reject(new Error(message.error || "Foundry bridge request failed"));
      }
    });

    ws.on("close", () => {
      session.open = false;
      sessions.delete(session);
    });
  });

  httpServer.listen(BRIDGE_PORT, BRIDGE_HOST);
  return httpServer;
}

const bridgeHttpServer = startBridgeServer();

process.on("SIGINT", () => {
  bridgeHttpServer.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  bridgeHttpServer.close();
  process.exit(0);
});

if (!process.argv.includes("--daemon")) {
const AnyJson = z.any().optional();
const server = new McpServer({
  name: MCP_NAME,
  version: "0.2.2"
});

server.registerTool(
  "foundry_status",
  {
    title: "Foundry status",
    description: "Report Foundry runtime status, bridge connection state, and active GM session metadata.",
    inputSchema: {}
  },
  async () => textResult(await foundryStatus())
);

server.registerTool(
  "list_collections",
  {
    title: "List Foundry collections",
    description: "List live Foundry world collections from the connected GM session.",
    inputSchema: {}
  },
  async () => textResult(await sendFoundryRequest("list_collections", {}))
);

server.registerTool(
  "get_document",
  {
    title: "Get Foundry document",
    description: "Read a Foundry document by collection and id or name.",
    inputSchema: {
      collection: z.string(),
      id: z.string(),
      includeEmbedded: z.boolean().optional()
    }
  },
  async (args) => textResult(await sendFoundryRequest("get_document", args))
);

server.registerTool(
  "search_documents",
  {
    title: "Search Foundry documents",
    description: "Search live documents in a collection.",
    inputSchema: {
      collection: z.string(),
      query: z.string().optional(),
      limit: z.number().optional()
    }
  },
  async (args) => textResult(await sendFoundryRequest("search_documents", args))
);

server.registerTool(
  "list_scenes",
  {
    title: "List scenes",
    description: "List scenes in the active world.",
    inputSchema: {}
  },
  async () => textResult(await sendFoundryRequest("list_scenes", {}))
);

server.registerTool(
  "inspect_scene",
  {
    title: "Inspect scene",
    description: "Read a scene including embedded scene documents.",
    inputSchema: {
      id: z.string().optional()
    }
  },
  async (args) => textResult(await sendFoundryRequest("inspect_scene", args))
);

server.registerTool(
  "list_users",
  {
    title: "List users",
    description: "List Foundry users from the live world with sensitive fields redacted.",
    inputSchema: {}
  },
  async () => textResult(await sendFoundryRequest("list_users", {}))
);

server.registerTool(
  "read_settings",
  {
    title: "Read settings",
    description: "Read live Foundry settings with sensitive fields redacted.",
    inputSchema: {
      namespace: z.string().optional()
    }
  },
  async (args) => textResult(await sendFoundryRequest("read_settings", args))
);

server.registerTool(
  "tail_logs",
  {
    title: "Tail Foundry logs",
    description: "Read recent Foundry log lines from local log files with secret-like fields redacted.",
    inputSchema: {
      file: z.string().optional(),
      limit: z.number().optional()
    }
  },
  async ({ file = "debug.log", limit = 80 }) => {
    return textResult(tailLogs({ file, limit }));
  }
);

server.registerTool(
  "get_runtime_events",
  {
    title: "Get runtime events",
    description: "Read recent live GM-client runtime warnings, errors, notifications, and bridge request failures.",
    inputSchema: {
      limit: z.number().optional(),
      level: z.string().optional(),
      source: z.string().optional(),
      since: z.string().optional()
    }
  },
  async (args) => textResult(await sendFoundryRequest("get_runtime_events", args))
);

server.registerTool(
  "clear_runtime_events",
  {
    title: "Clear runtime events",
    description: "Clear the live GM-client runtime event buffer.",
    inputSchema: {}
  },
  async () => textResult(await sendFoundryRequest("clear_runtime_events", {}))
);

server.registerTool(
  "export_world_snapshot",
  {
    title: "Export world snapshot",
    description: "Create a sanitized live snapshot of collections and basic server metadata.",
    inputSchema: {}
  },
  async () => {
    const collections = await sendFoundryRequest("list_collections", {});
    const scenes = await sendFoundryRequest("list_scenes", {});
    const users = await sendFoundryRequest("list_users", {});
    const settings = await sendFoundryRequest("read_settings", {});
    return textResult({ collections, scenes, users, settings });
  }
);

server.registerTool(
  "create_document",
  {
    title: "Create document",
    description: "Create a Foundry world document through the live GM session.",
    inputSchema: {
      documentName: z.string(),
      data: AnyJson
    }
  },
  async (args) => textResult(await sendFoundryRequest("create_document", args))
);

server.registerTool(
  "update_document",
  {
    title: "Update document",
    description: "Update a Foundry world document through the live GM session.",
    inputSchema: {
      collection: z.string(),
      id: z.string(),
      data: AnyJson
    }
  },
  async (args) => textResult(await sendFoundryRequest("update_document", args))
);

server.registerTool(
  "delete_document",
  {
    title: "Delete document",
    description: "Delete a Foundry world document after creating a local backup.",
    inputSchema: {
      collection: z.string(),
      id: z.string()
    }
  },
  async (args) => {
    const backup = await backupWorld();
    const deleted = await sendFoundryRequest("delete_document", args);
    return textResult({ backup, deleted });
  }
);

server.registerTool(
  "create_embedded_document",
  {
    title: "Create embedded document",
    description: "Create an embedded Foundry document such as a TokenDocument on a Scene.",
    inputSchema: {
      parentCollection: z.string(),
      parentId: z.string(),
      embeddedName: z.string(),
      data: AnyJson
    }
  },
  async (args) => textResult(await sendFoundryRequest("create_embedded_document", args))
);

server.registerTool(
  "update_embedded_document",
  {
    title: "Update embedded document",
    description: "Update an embedded Foundry document such as a TokenDocument on a Scene.",
    inputSchema: {
      parentCollection: z.string(),
      parentId: z.string(),
      embeddedName: z.string(),
      data: AnyJson
    }
  },
  async (args) => textResult(await sendFoundryRequest("update_embedded_document", args))
);

server.registerTool(
  "delete_embedded_document",
  {
    title: "Delete embedded document",
    description: "Delete an embedded Foundry document after creating a local backup.",
    inputSchema: {
      parentCollection: z.string(),
      parentId: z.string(),
      embeddedName: z.string(),
      embeddedId: z.string()
    }
  },
  async (args) => {
    const backup = await backupWorld();
    const deleted = await sendFoundryRequest("delete_embedded_document", args);
    return textResult({ backup, deleted });
  }
);

server.registerTool(
  "create_chat_message",
  {
    title: "Create chat message",
    description: "Create a chat message in the active world.",
    inputSchema: {
      content: z.string(),
      speaker: AnyJson,
      whisper: AnyJson,
      blind: z.boolean().optional()
    }
  },
  async (args) => textResult(await sendFoundryRequest("create_chat_message", args))
);

server.registerTool(
  "run_macro",
  {
    title: "Run macro",
    description: "Run a Foundry macro by id or name through the GM session.",
    inputSchema: {
      id: z.string().optional(),
      name: z.string().optional(),
      context: AnyJson
    }
  },
  async (args) => textResult(await sendFoundryRequest("run_macro", args))
);

server.registerTool(
  "run_gm_script",
  {
    title: "Run GM script",
    description: "Run explicit JavaScript in the live GM client. Requires dangerous=true.",
    inputSchema: {
      script: z.string(),
      context: AnyJson,
      dangerous: z.boolean()
    }
  },
  async (args) => {
    if (args.dangerous !== true) throw new Error("run_gm_script requires dangerous=true");
    return textResult(await sendFoundryRequest("run_gm_script", args));
  }
);

server.registerTool(
  "list_installed_packages",
  {
    title: "List installed packages",
    description: "List installed local systems, modules, and worlds from Foundry data.",
    inputSchema: {}
  },
  async () => {
    const p = paths();
    const packageRoots = {
      systems: path.join(p.data, "Data", "systems"),
      modules: path.join(p.data, "Data", "modules"),
      worlds: path.join(p.data, "Data", "worlds")
    };
    const result = {};
    for (const [kind, root] of Object.entries(packageRoots)) {
      result[kind] = [];
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifestName = kind === "worlds" ? "world.json" : kind === "systems" ? "system.json" : "module.json";
        const manifestPath = path.join(root, entry.name, manifestName);
        if (fs.existsSync(manifestPath)) {
          const manifest = redact(readJsonFile(manifestPath));
          result[kind].push({
            id: manifest.id ?? entry.name,
            title: manifest.title,
            version: manifest.version,
            compatibility: manifest.compatibility
          });
        }
      }
    }
    return textResult(result);
  }
);

server.registerTool(
  "read_foundry_options_sanitized",
  {
    title: "Read sanitized Foundry options",
    description: "Read Foundry options.json with secrets redacted.",
    inputSchema: {}
  },
  async () => textResult(sanitizeOptions(readJsonFile(paths().options)))
);

server.registerTool(
  "list_trusted_worlds",
  {
    title: "List trusted worlds",
    description: "List Foundry worlds authorized to connect through this local bridge.",
    inputSchema: {}
  },
  async () => textResult({ trustedWorlds: listTrustedWorlds(), path: TRUSTED_WORLDS_FILE })
);

server.registerTool(
  "revoke_trusted_world",
  {
    title: "Revoke trusted world",
    description: "Remove a Foundry world from the local bridge trusted-world list.",
    inputSchema: {
      worldId: z.string()
    }
  },
  async (args) => textResult(revokeTrustedWorld(args.worldId))
);

server.registerTool(
  "backup_world",
  {
    title: "Backup world",
    description: "Copy the active world directory to the bridge backup folder.",
    inputSchema: {}
  },
  async () => textResult(await backupWorld())
);

server.registerTool(
  "install_or_update_bridge_module",
  {
    title: "Install or update bridge module",
    description: "Copy the bridge Foundry module into the local Foundry modules directory.",
    inputSchema: {}
  },
  async () => {
    const p = paths();
    copyDirectory(MODULE_SOURCE_DIR, p.moduleInstall);
    return textResult({ ok: true, installedTo: p.moduleInstall });
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
}
