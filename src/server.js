#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import {
  lifecycleCredentialStatus,
  restartFoundryWorld,
  storeLifecycleCredentials
} from "./lifecycle.js";
import {
  BRIDGE_VERSION,
  TOOL_DEFINITIONS,
  listBridgeTools,
  toolDefinitionByName,
  toolRegistryChecksum
} from "./tool-registry.js";

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
const testCredentialStore = process.env.FOUNDRY_BRIDGE_CREDENTIAL_PROVIDER === "memory"
  ? new Map()
  : null;

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
  if (String(key).toLowerCase() === "planhash") return false;
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

function lifecycleContext(extra = {}) {
  return {
    root: ROOT,
    configDir: CONFIG_DIR,
    foundryDataDir: FOUNDRY_DATA_DIR,
    bridgeHost: BRIDGE_HOST,
    bridgePort: BRIDGE_PORT,
    bridgeToken: BRIDGE_TOKEN,
    ...extra
  };
}

function lifecycleCredentialDeps() {
  if (!testCredentialStore) return {};
  return {
    credentialSupported: true,
    readCredential: async (target) => testCredentialStore.get(target) ?? null,
    writeCredential: async (target, password, userName) => {
      testCredentialStore.set(target, { password, userName });
      return { target, userName, exists: true };
    },
    deleteCredential: async (target) => {
      const deleted = testCredentialStore.delete(target);
      return { target, deleted, supported: true };
    }
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

function canonicalizeForHash(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalizeForHash).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeForHash(value[key])}`).join(",")}}`;
}

function bridgePlanHash(plan) {
  const planForHash = { ...plan };
  delete planForHash.planHash;
  return createHash("sha256").update(canonicalizeForHash(planForHash)).digest("hex");
}

function operationRequiresBackup(operation) {
  const updateOperations = new Set([
    "journal.update_entry",
    "journal.update_page",
    "document.update",
    "scene.update_token",
    "scene.update_light",
    "scene.update_note"
  ]);
  return operation?.backupRequired === true
    || updateOperations.has(operation?.type);
}

function validateChatPlanOperation(operation) {
  const allowedKinds = new Set(["notice", "handout", "gm_note", "secret_check_prompt"]);
  const allowedAudiences = new Set(["all", "gms", "players", "users"]);
  const target = operation.target ?? {};
  const data = operation.data ?? {};

  if (!allowedKinds.has(target.kind)) {
    throw new Error(`Unsupported chat message kind: ${target.kind ?? "(missing)"}`);
  }
  if (!allowedAudiences.has(target.audience)) {
    throw new Error(`Unsupported chat message audience: ${target.audience ?? "(missing)"}`);
  }
  if (typeof data.content !== "string" || !data.content.trim()) {
    throw new Error(`Bridge plan operation ${operation.opId} requires non-empty chat content.`);
  }
  if (data.speaker != null && (typeof data.speaker !== "object" || Array.isArray(data.speaker))) {
    throw new Error(`Bridge plan operation ${operation.opId} has invalid chat speaker.`);
  }
  if (data.whisper != null && !Array.isArray(data.whisper)) {
    throw new Error(`Bridge plan operation ${operation.opId} has invalid chat whisper targets.`);
  }
  if (target.audience === "users" && (!Array.isArray(data.whisper) || !data.whisper.length)) {
    throw new Error(`Bridge plan operation ${operation.opId} requires chat user recipients.`);
  }
}

function validateBridgePlanOperation(operation) {
  const allowed = new Set([
    "journal.create_entry",
    "journal.update_entry",
    "journal.create_page",
    "journal.update_page",
    "document.create",
    "document.update",
    "scene.create_token",
    "scene.update_token",
    "scene.create_light",
    "scene.update_light",
    "scene.create_note",
    "scene.update_note",
    "chat.create_message"
  ]);
  if (!operation || typeof operation !== "object") throw new Error("Bridge plan operation must be an object.");
  if (!operation.opId || typeof operation.opId !== "string") throw new Error("Bridge plan operation is missing opId.");
  if (!allowed.has(operation.type)) throw new Error(`Unsupported bridge plan operation: ${operation.type}`);
  if (!operation.target || typeof operation.target !== "object") throw new Error(`Bridge plan operation ${operation.opId} is missing target.`);
  if (!operation.data || typeof operation.data !== "object" || Array.isArray(operation.data)) {
    throw new Error(`Bridge plan operation ${operation.opId} is missing object data.`);
  }
  if (operation.type.startsWith("journal.") && operation.type !== "journal.create_entry" && !operation.target.journalId) {
    throw new Error(`Bridge plan operation ${operation.opId} is missing journalId.`);
  }
  if (operation.type === "journal.update_page" && !operation.target.pageId) {
    throw new Error(`Bridge plan operation ${operation.opId} is missing pageId.`);
  }
  if (operation.type.startsWith("document.")) {
    const allowedDocumentNames = new Set(["Actor", "Item", "Scene", "Folder"]);
    const allowedFolderTypes = new Set(["Actor", "Item", "Scene", "JournalEntry"]);
    const documentName = operation.target.documentName;
    if (!allowedDocumentNames.has(documentName)) {
      throw new Error(`Unsupported document plan target: ${documentName ?? "(missing)"}`);
    }
    if (operation.type === "document.update" && !operation.target.id) {
      throw new Error(`Bridge plan operation ${operation.opId} is missing document id.`);
    }
    if (documentName === "Folder") {
      const folderType = operation.target.folderType ?? operation.data.type;
      if (!allowedFolderTypes.has(folderType)) {
        throw new Error(`Unsupported Folder plan type: ${folderType ?? "(missing)"}`);
      }
    }
  }
  if (operation.type.startsWith("scene.") && !operation.target.sceneId) {
    throw new Error(`Bridge plan operation ${operation.opId} is missing sceneId.`);
  }
  if (operation.type === "scene.update_token" && !operation.target.tokenId) {
    throw new Error(`Bridge plan operation ${operation.opId} is missing tokenId.`);
  }
  if (operation.type === "scene.update_light" && !operation.target.lightId) {
    throw new Error(`Bridge plan operation ${operation.opId} is missing lightId.`);
  }
  if (operation.type === "scene.update_note" && !operation.target.noteId) {
    throw new Error(`Bridge plan operation ${operation.opId} is missing noteId.`);
  }
  if (operation.type === "chat.create_message") validateChatPlanOperation(operation);
}

function validateBridgePlanForApply(plan, confirmation = {}) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error("apply_bridge_plan requires a plan object.");
  }
  if (!confirmation || typeof confirmation !== "object" || Array.isArray(confirmation)) {
    throw new Error("apply_bridge_plan requires confirmation.");
  }
  const supportedSources = new Set(["plan_journal_changes", "plan_scene_changes", "plan_document_changes", "plan_chat_messages"]);
  if (plan.kind !== "bridge-plan" || !supportedSources.has(plan.source) || plan.version !== 1) {
    throw new Error("apply_bridge_plan only accepts version 1 plans produced by plan_journal_changes, plan_scene_changes, plan_document_changes, or plan_chat_messages.");
  }
  if (!plan.planId || !plan.planHash || !plan.worldId) {
    throw new Error("apply_bridge_plan plan is missing planId, planHash, or worldId.");
  }
  if (confirmation.planId !== plan.planId) throw new Error("apply_bridge_plan planId confirmation mismatch.");
  if (confirmation.planHash !== plan.planHash) throw new Error("apply_bridge_plan planHash confirmation mismatch.");
  if (confirmation.worldId !== plan.worldId) throw new Error("apply_bridge_plan worldId confirmation mismatch.");
  const activeWorld = activeWorldId();
  if (!activeWorld || plan.worldId !== activeWorld) {
    throw new Error(`apply_bridge_plan world mismatch: plan=${plan.worldId}, active=${activeWorld ?? "none"}`);
  }
  const expiresAt = Date.parse(plan.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    throw new Error("apply_bridge_plan plan has expired.");
  }
  const expectedHash = bridgePlanHash(plan);
  if (expectedHash !== plan.planHash) {
    throw new Error("apply_bridge_plan planHash mismatch.");
  }
  if (!Array.isArray(plan.operations) || !plan.operations.length) {
    throw new Error("apply_bridge_plan requires at least one operation.");
  }
  for (const operation of plan.operations) validateBridgePlanOperation(operation);
  return {
    plan,
    backupRequired: plan.operations.some(operationRequiresBackup)
  };
}

async function applyBridgePlan(args = {}) {
  if (!activeSession()) {
    throw new Error("No connected trusted GM Foundry bridge session. Open the world as GM, activate the module, set the bridge token, and authorize this world.");
  }
  const { plan, backupRequired } = validateBridgePlanForApply(args.plan, args.confirmation);
  const backup = backupRequired ? await backupWorld() : null;
  const applied = await sendFoundryRequest("apply_bridge_plan", {
    plan,
    confirmation: args.confirmation
  });
  return {
    applied: true,
    planId: plan.planId,
    planHash: plan.planHash,
    worldId: plan.worldId,
    backupRequired,
    backup,
    result: applied
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

function assertLifecycleSession(session, message) {
  if (message.token !== BRIDGE_TOKEN) {
    throw new Error("Invalid bridge token");
  }
  if (!isTrustedSession(session)) {
    throw new Error("Lifecycle credential setup requires a trusted GM Foundry bridge session.");
  }
  const requestedWorld = normalizeWorldId(message.args?.worldId ?? session.hello?.worldId);
  if (!requestedWorld) throw new Error("worldId is required.");
  if (requestedWorld !== normalizeWorldId(session.hello?.worldId)) {
    throw new Error("Lifecycle credential setup can only configure the currently trusted world.");
  }
  return {
    ...(message.args ?? {}),
    worldId: requestedWorld
  };
}

async function handleLifecycleCredentialMessage(session, message) {
  let result;
  const args = assertLifecycleSession(session, message);
  if (message.type === "lifecycleCredentialStatus") {
    result = await lifecycleCredentialStatus(args, lifecycleContext(), lifecycleCredentialDeps());
  } else if (message.type === "storeLifecycleCredentials") {
    result = await storeLifecycleCredentials(args, lifecycleContext(), lifecycleCredentialDeps());
  } else {
    throw new Error(`Unsupported lifecycle credential message: ${message.type}`);
  }
  return result;
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

function pathChecks(worldId = activeWorldId()) {
  const p = paths(worldId);
  return {
    data: { path: p.data, exists: fs.existsSync(p.data) },
    world: { path: p.world, exists: p.world ? fs.existsSync(p.world) : false },
    logs: { path: p.logs, exists: fs.existsSync(p.logs) },
    options: { path: p.options, exists: fs.existsSync(p.options) },
    moduleInstall: { path: p.moduleInstall, exists: fs.existsSync(p.moduleInstall) },
    configDir: { path: p.configDir, exists: fs.existsSync(p.configDir) },
    trustedWorlds: { path: p.trustedWorlds, exists: fs.existsSync(p.trustedWorlds) }
  };
}

async function recentLogIssues() {
  const issues = [];
  for (const file of ["error.today.log", "debug.today.log"]) {
    let lines = [];
    try {
      lines = await tailLogs({ file, limit: 80 });
    } catch (error) {
      issues.push({ file, level: "warn", message: `Unable to read ${file}: ${error.message}` });
      continue;
    }

    for (const line of lines) {
      const text = typeof line === "string" ? line : JSON.stringify(line);
      if (/\b(error|warn|exception|failed|failure|deprecated)\b/i.test(text)) {
        issues.push({ file, message: text.slice(0, 1000) });
      }
    }
  }
  return issues.slice(-12);
}

async function bridgeSelfCheck() {
  const session = activeSession();
  const status = await foundryStatus().catch((error) => ({ error: error.message }));
  const liveSession = status?.liveSession ?? null;
  const runtimeEvents = liveSession?.bridge?.runtimeEvents ?? null;
  const checks = pathChecks(session?.hello?.worldId ?? null);
  const logIssues = await recentLogIssues();
  const actions = [];

  if (!status?.foundryApi) {
    actions.push("Start Foundry or confirm the local Foundry API is reachable on 127.0.0.1:30000.");
  }
  if (!session) {
    actions.push("Open the target world as GM, enable the bridge module, set the bridge token, and authorize the world.");
  }
  if (status?.bridge?.pendingAuthorization?.length) {
    actions.push("Authorize the pending GM world from the Foundry bridge prompt or run CodexFoundryBridge.authorizeCurrentWorld().");
  }
  if (!checks.moduleInstall.exists) {
    actions.push("Install the bridge module into Foundry with install_or_update_bridge_module or npm run install:module.");
  }
  if (liveSession?.bridge?.version && liveSession.bridge.version !== BRIDGE_VERSION) {
    actions.push(`Reload the GM client: running module script is ${liveSession.bridge.version}, expected ${BRIDGE_VERSION}.`);
  }
  if (liveSession?.bridge?.manifestVersion && liveSession.bridge.manifestVersion !== BRIDGE_VERSION) {
    actions.push(`Restart or reload Foundry module metadata: manifest is ${liveSession.bridge.manifestVersion}, expected ${BRIDGE_VERSION}.`);
  }
  if (runtimeEvents?.errors) {
    actions.push("Inspect get_runtime_events for live GM-client errors.");
  }

  return {
    ready: Boolean(session && liveSession?.bridge?.version === BRIDGE_VERSION && checks.moduleInstall.exists),
    bridgeVersion: BRIDGE_VERSION,
    registry: {
      version: listBridgeTools().registryVersion,
      checksum: toolRegistryChecksum(),
      toolCount: TOOL_DEFINITIONS.length,
      fallback: {
        tool: "call_bridge_tool",
        note: "Use call_bridge_tool when direct MCP discovery lags; the target tool's normal safety gates still apply."
      }
    },
    daemon: {
      listening: true,
      host: BRIDGE_HOST,
      port: BRIDGE_PORT,
      connectedSessions: sessions.size,
      trustedSessions: [...sessions].filter(isTrustedSession).length,
      pendingAuthorizationSessions: pendingAuthorizationSessions().length,
      activeWorld: activeWorldId()
    },
    trustedWorlds: listTrustedWorlds(),
    foundryApi: status?.foundryApi ?? null,
    liveSession: liveSession
      ? {
          world: liveSession.world,
          system: liveSession.system,
          foundry: liveSession.foundry,
          activeScene: liveSession.activeScene,
          bridge: liveSession.bridge
        }
      : null,
    paths: checks,
    runtimeEvents,
    recentLogIssues: logIssues,
    actions
  };
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

async function callBridgeTool({ method, args = {} } = {}) {
  const targetMethod = String(method ?? "").trim();
  const targetArgs = args ?? {};
  if (!targetMethod) throw new Error("call_bridge_tool requires method.");
  const targetTool = toolDefinitionByName(targetMethod);
  if (!targetTool) {
    throw new Error(`Unknown bridge method: ${targetMethod}`);
  }
  if (targetMethod === "call_bridge_tool") {
    throw new Error("call_bridge_tool cannot invoke itself.");
  }
  if (!targetTool.fallbackCallable) {
    throw new Error(`call_bridge_tool cannot invoke ${targetMethod}.`);
  }
  if (typeof targetArgs !== "object" || Array.isArray(targetArgs)) {
    throw new Error("call_bridge_tool args must be an object when provided.");
  }
  return executeTool(targetMethod, targetArgs);
}

async function executeTool(method, args = {}) {
  switch (method) {
    case "foundry_status":
      return foundryStatus();
    case "bridge_self_check":
      return bridgeSelfCheck();
    case "list_bridge_tools":
      return listBridgeTools();
    case "call_bridge_tool":
      return callBridgeTool(args);
    case "list_collections":
    case "get_document":
    case "search_documents":
    case "list_scenes":
    case "inspect_scene":
    case "list_compendium_packs":
    case "search_compendium":
    case "get_compendium_document":
    case "summarize_actor":
    case "summarize_scene":
    case "summarize_world_index":
    case "search_world":
    case "audit_scene_readiness":
    case "audit_actor_readiness":
    case "list_users":
    case "read_settings":
    case "get_runtime_events":
    case "get_runtime_timeline":
    case "clear_runtime_events":
    case "plan_journal_changes":
    case "plan_scene_changes":
    case "plan_document_changes":
    case "list_chat_targets":
    case "plan_chat_messages":
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
    case "apply_bridge_plan":
      return applyBridgePlan(args);
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
    case "restart_foundry_world":
      return restartFoundryWorld(args, lifecycleContext());
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

      if (message.type === "lifecycleCredentialStatus" || message.type === "storeLifecycleCredentials") {
        (async () => {
          try {
            const result = await handleLifecycleCredentialMessage(session, message);
            ws.send(JSON.stringify({
              type: "lifecycleResponse",
              requestType: message.type,
              id: message.id ?? null,
              ok: true,
              result: redact(result)
            }));
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            if (messageText === "Invalid bridge token") {
              ws.close(1008, "Invalid token");
              return;
            }
            ws.send(JSON.stringify({
              type: "lifecycleResponse",
              requestType: message.type,
              id: message.id ?? null,
              ok: false,
              error: messageText
            }));
          }
        })();
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
  const server = new McpServer({
    name: MCP_NAME,
    version: BRIDGE_VERSION
  });

  for (const tool of TOOL_DEFINITIONS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema
      },
      async (args) => textResult(await executeTool(tool.name, args ?? {}))
    );
  }

  async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }

  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
