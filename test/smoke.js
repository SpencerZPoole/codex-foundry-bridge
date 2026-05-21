import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";
import { BRIDGE_VERSION, TOOL_DEFINITIONS, toolRegistryChecksum } from "../src/tool-registry.js";

const token = process.env.CODEX_FOUNDRY_BRIDGE_TOKEN || "smoke-test-token";
const port = 30124;
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-codex-bridge-smoke-"));
const configDir = path.join(tempRoot, "config");
const foundryDataDir = path.join(tempRoot, "FoundryVTT");
const trustedWorldsPath = path.join(configDir, "trusted-worlds.json");
const dynamicWorldId = "dynamic-smoke-world";
const registeredToolNames = TOOL_DEFINITIONS.map((tool) => tool.name);
const highLevelReadTools = [
  "summarize_world_index",
  "search_world",
  "audit_scene_readiness",
  "audit_actor_readiness",
  "get_runtime_timeline"
];
const transactionTools = [
  "plan_journal_changes",
  "plan_scene_changes",
  "plan_document_changes",
  "plan_chat_messages",
  "apply_bridge_plan"
];
const chatWorkflowTools = [
  "list_chat_targets",
  "plan_chat_messages"
];

fs.mkdirSync(path.join(foundryDataDir, "Data", "worlds", dynamicWorldId), { recursive: true });
fs.mkdirSync(path.join(foundryDataDir, "Config"), { recursive: true });
fs.writeFileSync(path.join(foundryDataDir, "Config", "options.json"), "{}", "utf8");
assert.equal(new Set(registeredToolNames).size, registeredToolNames.length);
assert.ok(registeredToolNames.includes("bridge_self_check"));
assert.ok(registeredToolNames.includes("call_bridge_tool"));
assert.ok(registeredToolNames.includes("list_compendium_packs"));
for (const method of highLevelReadTools) {
  assert.ok(registeredToolNames.includes(method), `${method} should be registered`);
}
for (const method of transactionTools) {
  assert.ok(registeredToolNames.includes(method), `${method} should be registered`);
}
for (const method of chatWorkflowTools) {
  assert.ok(registeredToolNames.includes(method), `${method} should be registered`);
}
assert.equal(registeredToolNames.length, 47);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForClose(ws) {
  return new Promise((resolve) => ws.on("close", (code) => resolve(code)));
}

function waitForMessage(ws, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("Timed out waiting for WebSocket message"));
    }, timeoutMs);

    function onMessage(data) {
      const message = JSON.parse(String(data));
      if (!predicate(message)) return;
      clearTimeout(timeout);
      ws.off("message", onMessage);
      resolve(message);
    }

    ws.on("message", onMessage);
  });
}

async function waitForStatus() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`);
      if (response.ok) return response.json();
    } catch {
      // Keep waiting for the test server to start.
    }
    await wait(100);
  }
  throw new Error("Bridge server did not start");
}

async function callBridge(method, args = {}, { expectOk = true } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/call`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bridge-token": token
    },
    body: JSON.stringify({ method, args })
  });
  const body = await response.json();
  if (expectOk) {
    assert.equal(response.status, 200, body.error);
    assert.equal(body.ok, true, body.error);
  }
  return { response, body };
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

function signBridgePlan(plan) {
  const signed = { ...plan };
  signed.planHash = bridgePlanHash(signed);
  return signed;
}

function defaultPlanTarget(operationType) {
  if (operationType === "journal.create_entry") {
    return { documentName: "JournalEntry", name: "Smoke Test Journal" };
  }
  if (operationType.startsWith("journal.")) {
    return { documentName: "JournalEntry", journalId: "journal-1", journalName: "Smoke Test Journal" };
  }
  if (operationType === "scene.create_token") {
    return { documentName: "Token", sceneId: "scene-1", sceneName: "Smoke Scene" };
  }
  if (operationType === "scene.update_token") {
    return { documentName: "Token", sceneId: "scene-1", sceneName: "Smoke Scene", tokenId: "token-1" };
  }
  if (operationType === "scene.create_light") {
    return { documentName: "AmbientLight", sceneId: "scene-1", sceneName: "Smoke Scene" };
  }
  if (operationType === "scene.update_light") {
    return { documentName: "AmbientLight", sceneId: "scene-1", sceneName: "Smoke Scene", lightId: "light-1" };
  }
  if (operationType === "scene.create_note") {
    return { documentName: "Note", sceneId: "scene-1", sceneName: "Smoke Scene", journalId: "journal-1" };
  }
  if (operationType === "scene.update_note") {
    return { documentName: "Note", sceneId: "scene-1", sceneName: "Smoke Scene", noteId: "note-1", journalId: "journal-1" };
  }
  if (operationType === "document.create") {
    return { documentName: "Item", collection: "items", id: null, name: "Smoke Test Item" };
  }
  if (operationType === "document.update") {
    return { documentName: "Item", collection: "items", id: "item-1", name: "Smoke Test Item" };
  }
  if (operationType === "chat.create_message") {
    return {
      documentName: "ChatMessage",
      kind: "gm_note",
      audience: "gms",
      delivery: "gms",
      recipients: [{ id: "gm", name: "Gamemaster", isGM: true }]
    };
  }
  return { documentName: "Unknown" };
}

function defaultPlanData(operationType) {
  if (operationType === "journal.create_entry") return { name: "Smoke Test Journal", pages: [] };
  if (operationType.startsWith("journal.")) return { name: "Smoke Test Journal Updated" };
  if (operationType === "scene.create_token") return { name: "Smoke Token", x: 100, y: 100, hidden: true };
  if (operationType === "scene.update_token") return { _id: "token-1", x: 120, y: 140, hidden: false };
  if (operationType === "scene.create_light") return { x: 100, y: 100, hidden: true, config: { dim: 10, bright: 5 } };
  if (operationType === "scene.update_light") return { _id: "light-1", x: 150, y: 150, hidden: false };
  if (operationType === "scene.create_note") return { x: 100, y: 100, entryId: "journal-1", text: "Smoke note" };
  if (operationType === "scene.update_note") return { _id: "note-1", x: 160, y: 160, text: "Updated smoke note" };
  if (operationType === "document.create") return { name: "Smoke Test Item", type: "loot", img: "icons/svg/item-bag.svg" };
  if (operationType === "document.update") return { name: "Smoke Test Item Updated" };
  if (operationType === "chat.create_message") {
    return {
      content: "<h3>Smoke GM Note</h3>\nThis is a smoke test.",
      speaker: { alias: "Codex Smoke" },
      whisper: ["gm"],
      blind: true
    };
  }
  return {};
}

function defaultPlanSource(operationType) {
  if (operationType.startsWith("scene.")) return "plan_scene_changes";
  if (operationType.startsWith("document.")) return "plan_document_changes";
  if (operationType.startsWith("chat.")) return "plan_chat_messages";
  return "plan_journal_changes";
}

function makeBridgePlan({
  worldId = dynamicWorldId,
  operationType = "journal.create_entry",
  source = defaultPlanSource(operationType),
  backupRequired = false,
  expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  operation = null
} = {}) {
  const op = operation ?? {
    opId: "op1",
    type: operationType,
    target: defaultPlanTarget(operationType),
    data: defaultPlanData(operationType),
    backupRequired
  };
  return signBridgePlan({
    kind: "bridge-plan",
    source,
    version: 1,
    planId: `smoke-${operationType}-${backupRequired ? "backup" : "create"}`,
    worldId,
    createdAt: new Date().toISOString(),
    expiresAt,
    action: operationType,
    summary: "Smoke test bridge plan",
    requiresBackup: backupRequired,
    operations: [op],
    warnings: [],
    targets: {}
  });
}

function confirmationForPlan(plan, overrides = {}) {
  return {
    planId: plan.planId,
    planHash: plan.planHash,
    worldId: plan.worldId,
    ...overrides
  };
}

let lifecycleMessageId = 0;
function sendLifecycleMessage(ws, type, args = {}) {
  const id = ++lifecycleMessageId;
  ws.send(JSON.stringify({ type, id, token, args }));
  return waitForMessage(ws, (message) => message.type === "lifecycleResponse" && message.id === id);
}

async function withMcpClient(callback) {
  const client = new Client({ name: "foundry-codex-bridge-smoke", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/mcp.js"],
    cwd: projectRoot,
    stderr: "pipe",
    env: {
      ...process.env,
      CODEX_FOUNDRY_BRIDGE_TOKEN: token,
      FOUNDRY_BRIDGE_PORT: String(port),
      FOUNDRY_BRIDGE_CONFIG_DIR: configDir,
      FOUNDRY_DATA_DIR: foundryDataDir
    }
  });

  try {
    await client.connect(transport);
    return await callback(client);
  } finally {
    await client.close();
  }
}

function fakeFoundryResponse(message) {
  if (message.method === "list_chat_targets") {
    return {
      ok: true,
      result: {
        method: message.method,
        users: [
          { id: "gm", name: "Gamemaster", isGM: true, roleLabel: "gm", active: true },
          { id: "player", name: "Player One", isGM: false, roleLabel: "player", active: true },
          { id: "player2", name: "Player One", isGM: false, roleLabel: "player", active: false }
        ]
      }
    };
  }

  if (message.method === "plan_chat_messages") {
    const messages = Array.isArray(message.args?.messages) ? message.args.messages : [];
    if (!messages.length) return { ok: false, error: "plan_chat_messages requires at least one message." };
    for (const entry of messages) {
      if (!["notice", "handout", "gm_note", "secret_check_prompt"].includes(entry.kind)) {
        return { ok: false, error: `Unsupported chat message kind: ${entry.kind ?? "(missing)"}` };
      }
      if (entry.audience && !["all", "gms", "players", "users"].includes(entry.audience)) {
        return { ok: false, error: `Unsupported chat message audience: ${entry.audience}` };
      }
      if (entry.kind !== "secret_check_prompt" && !String(entry.content ?? "").trim()) {
        return { ok: false, error: `${entry.kind} requires non-empty content.` };
      }
      if (entry.audience === "users" && !(entry.recipientIds?.length || entry.recipientNames?.length)) {
        return { ok: false, error: "Chat audience resolved to no users: users" };
      }
      if (entry.recipientNames?.includes("Player One")) {
        return { ok: false, error: "Chat user name is ambiguous: Player One" };
      }
    }
  }

  return {
    ok: true,
    result: {
      connected: true,
      world: { id: dynamicWorldId, title: "Dynamic Smoke World" },
      method: message.method
    }
  };
}

const child = spawn(process.execPath, ["src/server.js"], {
  cwd: projectRoot,
  env: {
    ...process.env,
    CODEX_FOUNDRY_BRIDGE_TOKEN: token,
    FOUNDRY_BRIDGE_PORT: String(port),
    FOUNDRY_BRIDGE_CONFIG_DIR: configDir,
    FOUNDRY_DATA_DIR: foundryDataDir,
    FOUNDRY_BRIDGE_CREDENTIAL_PROVIDER: "memory"
  },
  stdio: ["pipe", "pipe", "pipe"]
});

try {
  const initialStatus = await waitForStatus();
  assert.equal(initialStatus.ok, true);
  assert.equal(initialStatus.connectedSessions, 0);
  assert.equal(initialStatus.trustedSessions, 0);
  assert.equal(initialStatus.pendingAuthorizationSessions, 0);

  const toolsCall = await callBridge("list_bridge_tools");
  assert.equal(toolsCall.body.result.bridgeVersion, BRIDGE_VERSION);
  assert.equal(toolsCall.body.result.checksum, toolRegistryChecksum());
  assert.deepEqual(
    toolsCall.body.result.tools.map((tool) => tool.name).sort(),
    [...registeredToolNames].sort()
  );
  assert.equal(toolsCall.body.result.tools.find((tool) => tool.name === "create_document").risk, "write");
  assert.equal(toolsCall.body.result.tools.find((tool) => tool.name === "list_compendium_packs").readOnly, true);
  for (const method of highLevelReadTools) {
    const tool = toolsCall.body.result.tools.find((entry) => entry.name === method);
    assert.equal(tool.readOnly, true, `${method} should be read-only`);
    assert.equal(tool.requiresTrustedSession, true, `${method} should require a trusted session`);
    assert.equal(tool.directMcpExposure, true, `${method} should be directly exposed through MCP`);
    assert.equal(tool.fallbackCallable, true, `${method} should be fallback-callable`);
  }
  const chatTargetsTool = toolsCall.body.result.tools.find((entry) => entry.name === "list_chat_targets");
  assert.equal(chatTargetsTool.category, "live-read");
  assert.equal(chatTargetsTool.readOnly, true);
  assert.equal(chatTargetsTool.requiresTrustedSession, true);
  assert.equal(chatTargetsTool.fallbackCallable, true);
  const planTool = toolsCall.body.result.tools.find((entry) => entry.name === "plan_journal_changes");
  assert.equal(planTool.category, "transaction");
  assert.equal(planTool.readOnly, true);
  assert.equal(planTool.requiresTrustedSession, true);
  assert.equal(planTool.fallbackCallable, true);
  const scenePlanTool = toolsCall.body.result.tools.find((entry) => entry.name === "plan_scene_changes");
  assert.equal(scenePlanTool.category, "transaction");
  assert.equal(scenePlanTool.readOnly, true);
  assert.equal(scenePlanTool.requiresTrustedSession, true);
  assert.equal(scenePlanTool.fallbackCallable, true);
  const documentPlanTool = toolsCall.body.result.tools.find((entry) => entry.name === "plan_document_changes");
  assert.equal(documentPlanTool.category, "transaction");
  assert.equal(documentPlanTool.readOnly, true);
  assert.equal(documentPlanTool.requiresTrustedSession, true);
  assert.equal(documentPlanTool.fallbackCallable, true);
  const chatPlanTool = toolsCall.body.result.tools.find((entry) => entry.name === "plan_chat_messages");
  assert.equal(chatPlanTool.category, "transaction");
  assert.equal(chatPlanTool.readOnly, true);
  assert.equal(chatPlanTool.requiresTrustedSession, true);
  assert.equal(chatPlanTool.fallbackCallable, true);
  const applyTool = toolsCall.body.result.tools.find((entry) => entry.name === "apply_bridge_plan");
  assert.equal(applyTool.category, "transaction");
  assert.equal(applyTool.readOnly, false);
  assert.equal(applyTool.requiresTrustedSession, true);
  assert.equal(applyTool.fallbackCallable, true);
  assert.equal(toolsCall.body.result.fallback.tool, "call_bridge_tool");

  const toolsViaFallback = await callBridge("call_bridge_tool", {
    method: "list_bridge_tools"
  });
  assert.equal(toolsViaFallback.body.result.checksum, toolRegistryChecksum());
  assert.deepEqual(
    toolsViaFallback.body.result.tools.map((tool) => tool.name).sort(),
    [...registeredToolNames].sort()
  );

  const mcpToolList = await withMcpClient((client) => client.listTools());
  assert.deepEqual(
    mcpToolList.tools.map((tool) => tool.name).sort(),
    [...registeredToolNames].sort()
  );

  const mcpFallbackResult = await withMcpClient((client) => client.callTool({
    name: "call_bridge_tool",
    arguments: { method: "list_bridge_tools" }
  }));
  const mcpFallbackPayload = JSON.parse(mcpFallbackResult.content[0].text);
  assert.equal(mcpFallbackPayload.fallback.tool, "call_bridge_tool");
  assert.deepEqual(
    mcpFallbackPayload.tools.map((tool) => tool.name).sort(),
    [...registeredToolNames].sort()
  );

  const initialSelfCheck = await callBridge("bridge_self_check");
  assert.equal(initialSelfCheck.body.result.bridgeVersion, BRIDGE_VERSION);
  assert.equal(initialSelfCheck.body.result.daemon.trustedSessions, 0);
  assert.equal(initialSelfCheck.body.result.registry.checksum, toolRegistryChecksum());
  assert.equal(initialSelfCheck.body.result.registry.fallback.tool, "call_bridge_tool");
  assert.equal(JSON.stringify(initialSelfCheck.body.result).includes(token), false);

  const selfCheckViaFallback = await callBridge("call_bridge_tool", {
    method: "bridge_self_check"
  });
  assert.equal(selfCheckViaFallback.body.result.bridgeVersion, BRIDGE_VERSION);

  const recursiveFallback = await callBridge("call_bridge_tool", {
    method: "call_bridge_tool",
    args: { method: "list_bridge_tools" }
  }, { expectOk: false });
  assert.equal(recursiveFallback.response.status, 500);
  assert.match(recursiveFallback.body.error, /cannot invoke itself/);

  const scriptWithoutDangerous = await callBridge("call_bridge_tool", {
    method: "run_gm_script",
    args: { script: "return null;" }
  }, { expectOk: false });
  assert.equal(scriptWithoutDangerous.response.status, 500);
  assert.match(scriptWithoutDangerous.body.error, /dangerous=true/);

  const bad = new WebSocket(`ws://127.0.0.1:${port}/foundry`);
  await new Promise((resolve) => bad.on("open", resolve));
  bad.send(JSON.stringify({
    type: "hello",
    token: "wrong",
    worldId: dynamicWorldId,
    user: { isGM: true }
  }));
  assert.equal(await waitForClose(bad), 1008);

  const nonGm = new WebSocket(`ws://127.0.0.1:${port}/foundry`);
  await new Promise((resolve) => nonGm.on("open", resolve));
  nonGm.send(JSON.stringify({
    type: "hello",
    token,
    worldId: dynamicWorldId,
    user: { isGM: false }
  }));
  assert.equal(await waitForClose(nonGm), 1008);

  const gm = new WebSocket(`ws://127.0.0.1:${port}/foundry`);
  gm.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.type !== "request") return;
    const fake = fakeFoundryResponse(message);
    gm.send(JSON.stringify({
      type: "response",
      id: message.id,
      ok: fake.ok,
      result: fake.result,
      error: fake.error
    }));
  });
  await new Promise((resolve) => gm.on("open", resolve));
  gm.send(JSON.stringify({
    type: "hello",
    token,
    worldId: dynamicWorldId,
    worldTitle: "Dynamic Smoke World",
    systemId: "D35E",
    systemVersion: "3.0.2",
    foundryVersion: "14.361",
    user: { id: "gm", name: "Gamemaster", role: 4, isGM: true }
  }));

  const pendingAuthorization = await waitForMessage(gm, (message) => message.type === "authorizationStatus");
  assert.equal(pendingAuthorization.trusted, false);
  assert.equal(pendingAuthorization.world.worldId, dynamicWorldId);

  const pendingStatus = await fetch(`http://127.0.0.1:${port}/status`).then((response) => response.json());
  assert.equal(pendingStatus.connectedSessions, 1);
  assert.equal(pendingStatus.trustedSessions, 0);
  assert.equal(pendingStatus.pendingAuthorizationSessions, 1);
  assert.equal(pendingStatus.activeWorld, null);

  const refused = await callBridge("list_collections", {}, { expectOk: false });
  assert.equal(refused.response.status, 500);
  assert.match(refused.body.error, /trusted GM Foundry bridge session/);

  const refusedReadIntelligence = await callBridge("list_compendium_packs", {}, { expectOk: false });
  assert.equal(refusedReadIntelligence.response.status, 500);
  assert.match(refusedReadIntelligence.body.error, /trusted GM Foundry bridge session/);

  for (const method of highLevelReadTools) {
    const refusedHighLevelRead = await callBridge(method, { query: "smoke" }, { expectOk: false });
    assert.equal(refusedHighLevelRead.response.status, 500, `${method} should fail before trust`);
    assert.match(refusedHighLevelRead.body.error, /trusted GM Foundry bridge session/);

    const refusedFallbackHighLevelRead = await callBridge("call_bridge_tool", {
      method,
      args: { query: "smoke" }
    }, { expectOk: false });
    assert.equal(refusedFallbackHighLevelRead.response.status, 500, `${method} fallback should fail before trust`);
    assert.match(refusedFallbackHighLevelRead.body.error, /trusted GM Foundry bridge session/);
  }

  const refusedChatTargets = await callBridge("list_chat_targets", {}, { expectOk: false });
  assert.equal(refusedChatTargets.response.status, 500);
  assert.match(refusedChatTargets.body.error, /trusted GM Foundry bridge session/);

  const refusedPlanJournal = await callBridge("plan_journal_changes", {
    action: "create_entry",
    entryName: "Smoke Test Journal"
  }, { expectOk: false });
  assert.equal(refusedPlanJournal.response.status, 500);
  assert.match(refusedPlanJournal.body.error, /trusted GM Foundry bridge session/);

  const refusedPlanScene = await callBridge("plan_scene_changes", {
    changes: [{ action: "create_token", data: { name: "Smoke Token", x: 100, y: 100 } }]
  }, { expectOk: false });
  assert.equal(refusedPlanScene.response.status, 500);
  assert.match(refusedPlanScene.body.error, /trusted GM Foundry bridge session/);

  const refusedPlanDocument = await callBridge("plan_document_changes", {
    changes: [{ action: "create", documentName: "Item", data: { name: "Smoke Test Item", type: "loot" } }]
  }, { expectOk: false });
  assert.equal(refusedPlanDocument.response.status, 500);
  assert.match(refusedPlanDocument.body.error, /trusted GM Foundry bridge session/);

  const refusedPlanChat = await callBridge("plan_chat_messages", {
    messages: [{ kind: "gm_note", content: "Smoke GM note" }]
  }, { expectOk: false });
  assert.equal(refusedPlanChat.response.status, 500);
  assert.match(refusedPlanChat.body.error, /trusted GM Foundry bridge session/);

  const refusedFallbackPlanChat = await callBridge("call_bridge_tool", {
    method: "plan_chat_messages",
    args: { messages: [{ kind: "gm_note", content: "Smoke GM note" }] }
  }, { expectOk: false });
  assert.equal(refusedFallbackPlanChat.response.status, 500);
  assert.match(refusedFallbackPlanChat.body.error, /trusted GM Foundry bridge session/);

  const preTrustPlan = makeBridgePlan();
  const refusedApplyPlan = await callBridge("apply_bridge_plan", {
    plan: preTrustPlan,
    confirmation: confirmationForPlan(preTrustPlan)
  }, { expectOk: false });
  assert.equal(refusedApplyPlan.response.status, 500);
  assert.match(refusedApplyPlan.body.error, /trusted GM Foundry bridge session/);

  const refusedFallbackApplyPlan = await callBridge("call_bridge_tool", {
    method: "apply_bridge_plan",
    args: {
      plan: preTrustPlan,
      confirmation: confirmationForPlan(preTrustPlan)
    }
  }, { expectOk: false });
  assert.equal(refusedFallbackApplyPlan.response.status, 500);
  assert.match(refusedFallbackApplyPlan.body.error, /trusted GM Foundry bridge session/);

  const refusedFallbackLiveTool = await callBridge("call_bridge_tool", {
    method: "list_collections"
  }, { expectOk: false });
  assert.equal(refusedFallbackLiveTool.response.status, 500);
  assert.match(refusedFallbackLiveTool.body.error, /trusted GM Foundry bridge session/);

  const refusedCredentialStatus = await sendLifecycleMessage(gm, "lifecycleCredentialStatus", { worldId: dynamicWorldId });
  assert.equal(refusedCredentialStatus.ok, false);
  assert.match(refusedCredentialStatus.error, /trusted GM Foundry bridge session/);

  gm.send(JSON.stringify({ type: "authorizeWorld", token }));
  const authorized = await waitForMessage(gm, (message) => message.type === "authorizationStatus" && message.trusted === true);
  assert.equal(authorized.world.id, dynamicWorldId);

  const trustedConfig = JSON.parse(fs.readFileSync(trustedWorldsPath, "utf8"));
  assert.equal(trustedConfig.worlds.length, 1);
  assert.equal(trustedConfig.worlds[0].id, dynamicWorldId);
  assert.equal(JSON.stringify(trustedConfig).includes(token), false);

  const paired = await fetch(`http://127.0.0.1:${port}/status`).then((response) => response.json());
  assert.equal(paired.connectedSessions, 1);
  assert.equal(paired.trustedSessions, 1);
  assert.equal(paired.activeWorld, dynamicWorldId);

  const statusCall = await callBridge("foundry_status");
  assert.equal(statusCall.body.result.bridge.connected, true);
  assert.equal(statusCall.body.result.bridge.session.worldId, dynamicWorldId);
  assert.equal(statusCall.body.result.liveSession.world.id, dynamicWorldId);
  assert.equal(statusCall.body.result.paths.world, path.join(foundryDataDir, "Data", "worlds", dynamicWorldId));

  const trustedWorlds = await callBridge("list_trusted_worlds");
  assert.deepEqual(trustedWorlds.body.result.trustedWorlds.map((world) => world.id), [dynamicWorldId]);

  const credentialStatus = await sendLifecycleMessage(gm, "lifecycleCredentialStatus", { worldId: dynamicWorldId });
  assert.equal(credentialStatus.ok, true);
  assert.equal(credentialStatus.result.supported, true);
  assert.equal(credentialStatus.result.gm.exists, false);

  const storedCredentials = await sendLifecycleMessage(gm, "storeLifecycleCredentials", {
    worldId: dynamicWorldId,
    gmUserId: "gm",
    gmPassword: "gm-secret",
    foundryUrl: "http://127.0.0.1:30000"
  });
  assert.equal(storedCredentials.ok, true);
  assert.equal(storedCredentials.result.gm.exists, true);
  assert.equal(JSON.stringify(storedCredentials).includes("gm-secret"), false);
  assert.equal(fs.readFileSync(path.join(configDir, "lifecycle.json"), "utf8").includes("gm-secret"), false);

  const collectionsViaFallback = await callBridge("call_bridge_tool", {
    method: "list_collections"
  });
  assert.equal(collectionsViaFallback.body.result.method, "list_collections");

  for (const method of [
    "list_compendium_packs",
    "search_compendium",
    "get_compendium_document",
    "summarize_actor",
    "summarize_scene"
  ]) {
    const call = await callBridge(method, { pack: "D35E.spells", id: "acid arrow" });
    assert.equal(call.body.result.method, method);
    const fallbackCall = await callBridge("call_bridge_tool", {
      method,
      args: { pack: "D35E.spells", id: "acid arrow" }
    });
    assert.equal(fallbackCall.body.result.method, method);
  }

  for (const method of highLevelReadTools) {
    const args = method === "search_world" ? { query: "smoke" } : {};
    const call = await callBridge(method, args);
    assert.equal(call.body.result.method, method);
    const fallbackCall = await callBridge("call_bridge_tool", { method, args });
    assert.equal(fallbackCall.body.result.method, method);
  }

  const chatTargets = await callBridge("list_chat_targets");
  assert.equal(chatTargets.body.result.method, "list_chat_targets");
  assert.equal(chatTargets.body.result.users.length, 3);

  const plannedJournal = await callBridge("plan_journal_changes", {
    action: "create_entry",
    entryName: "Smoke Test Journal"
  });
  assert.equal(plannedJournal.body.result.method, "plan_journal_changes");

  const plannedScene = await callBridge("plan_scene_changes", {
    changes: [{ action: "create_token", data: { name: "Smoke Token", x: 100, y: 100 } }]
  });
  assert.equal(plannedScene.body.result.method, "plan_scene_changes");
  const plannedSceneViaFallback = await callBridge("call_bridge_tool", {
    method: "plan_scene_changes",
    args: {
      changes: [{ action: "create_light", data: { x: 100, y: 100, config: { dim: 10 } } }]
    }
  });
  assert.equal(plannedSceneViaFallback.body.result.method, "plan_scene_changes");

  const plannedDocument = await callBridge("plan_document_changes", {
    changes: [{ action: "create", documentName: "Item", data: { name: "Smoke Test Item", type: "loot" } }]
  });
  assert.equal(plannedDocument.body.result.method, "plan_document_changes");
  const plannedDocumentViaFallback = await callBridge("call_bridge_tool", {
    method: "plan_document_changes",
    args: {
      changes: [{ action: "create", documentName: "Folder", folderType: "Item", data: { name: "Smoke Test Folder" } }]
    }
  });
  assert.equal(plannedDocumentViaFallback.body.result.method, "plan_document_changes");

  const plannedChat = await callBridge("plan_chat_messages", {
    messages: [{ kind: "gm_note", content: "Smoke GM note" }]
  });
  assert.equal(plannedChat.body.result.method, "plan_chat_messages");
  const plannedChatViaFallback = await callBridge("call_bridge_tool", {
    method: "plan_chat_messages",
    args: {
      messages: [{ kind: "secret_check_prompt", checkName: "Listen", dc: 15, prompt: "Resolve privately." }]
    }
  });
  assert.equal(plannedChatViaFallback.body.result.method, "plan_chat_messages");

  const unknownChatKind = await callBridge("plan_chat_messages", {
    messages: [{ kind: "unknown", content: "Smoke" }]
  }, { expectOk: false });
  assert.equal(unknownChatKind.response.status, 500);
  assert.match(unknownChatKind.body.error, /Unsupported chat message kind/);

  const unknownChatAudience = await callBridge("plan_chat_messages", {
    messages: [{ kind: "notice", audience: "everyone-nearby", content: "Smoke" }]
  }, { expectOk: false });
  assert.equal(unknownChatAudience.response.status, 500);
  assert.match(unknownChatAudience.body.error, /Unsupported chat message audience/);

  const emptyChatContent = await callBridge("plan_chat_messages", {
    messages: [{ kind: "gm_note", content: "" }]
  }, { expectOk: false });
  assert.equal(emptyChatContent.response.status, 500);
  assert.match(emptyChatContent.body.error, /non-empty content/);

  const missingChatUsers = await callBridge("plan_chat_messages", {
    messages: [{ kind: "notice", audience: "users", content: "Smoke" }]
  }, { expectOk: false });
  assert.equal(missingChatUsers.response.status, 500);
  assert.match(missingChatUsers.body.error, /no users/);

  const ambiguousChatUsers = await callBridge("plan_chat_messages", {
    messages: [{ kind: "notice", audience: "users", recipientNames: ["Player One"], content: "Smoke" }]
  }, { expectOk: false });
  assert.equal(ambiguousChatUsers.response.status, 500);
  assert.match(ambiguousChatUsers.body.error, /ambiguous/);

  const createPlan = makeBridgePlan();
  const missingConfirmation = await callBridge("apply_bridge_plan", {
    plan: createPlan
  }, { expectOk: false });
  assert.equal(missingConfirmation.response.status, 500);
  assert.match(missingConfirmation.body.error, /confirmation/);

  const badHashConfirmation = await callBridge("apply_bridge_plan", {
    plan: createPlan,
    confirmation: confirmationForPlan(createPlan, { planHash: "bad-hash" })
  }, { expectOk: false });
  assert.equal(badHashConfirmation.response.status, 500);
  assert.match(badHashConfirmation.body.error, /planHash/);

  const wrongWorldPlan = makeBridgePlan({ worldId: "wrong-smoke-world" });
  const wrongWorld = await callBridge("apply_bridge_plan", {
    plan: wrongWorldPlan,
    confirmation: confirmationForPlan(wrongWorldPlan)
  }, { expectOk: false });
  assert.equal(wrongWorld.response.status, 500);
  assert.match(wrongWorld.body.error, /world mismatch/);

  const expiredPlan = makeBridgePlan({ expiresAt: new Date(Date.now() - 1000).toISOString() });
  const expired = await callBridge("apply_bridge_plan", {
    plan: expiredPlan,
    confirmation: confirmationForPlan(expiredPlan)
  }, { expectOk: false });
  assert.equal(expired.response.status, 500);
  assert.match(expired.body.error, /expired/);

  const malformedPlan = makeBridgePlan({
    operation: {
      opId: "op1",
      type: "journal.delete_entry",
      target: { documentName: "JournalEntry", journalId: "journal-1" },
      data: {},
      backupRequired: true
    },
    backupRequired: true
  });
  const malformed = await callBridge("apply_bridge_plan", {
    plan: malformedPlan,
    confirmation: confirmationForPlan(malformedPlan)
  }, { expectOk: false });
  assert.equal(malformed.response.status, 500);
  assert.match(malformed.body.error, /Unsupported bridge plan operation/);

  const unsupportedScenePlan = makeBridgePlan({
    source: "plan_scene_changes",
    operation: {
      opId: "op1",
      type: "scene.create_wall",
      target: { documentName: "Wall", sceneId: "scene-1", sceneName: "Smoke Scene" },
      data: { c: [0, 0, 100, 100] },
      backupRequired: false
    }
  });
  const unsupportedScene = await callBridge("apply_bridge_plan", {
    plan: unsupportedScenePlan,
    confirmation: confirmationForPlan(unsupportedScenePlan)
  }, { expectOk: false });
  assert.equal(unsupportedScene.response.status, 500);
  assert.match(unsupportedScene.body.error, /Unsupported bridge plan operation/);

  const missingSceneTargetPlan = makeBridgePlan({
    operationType: "scene.update_token",
    operation: {
      opId: "op1",
      type: "scene.update_token",
      target: { documentName: "Token", sceneId: "scene-1", sceneName: "Smoke Scene" },
      data: { x: 120 },
      backupRequired: true
    }
  });
  const missingSceneTarget = await callBridge("apply_bridge_plan", {
    plan: missingSceneTargetPlan,
    confirmation: confirmationForPlan(missingSceneTargetPlan)
  }, { expectOk: false });
  assert.equal(missingSceneTarget.response.status, 500);
  assert.match(missingSceneTarget.body.error, /tokenId/);

  for (const unsupportedDocumentName of ["Macro", "User", "Setting"]) {
    const unsupportedDocumentPlan = makeBridgePlan({
      source: "plan_document_changes",
      operation: {
        opId: "op1",
        type: "document.create",
        target: { documentName: unsupportedDocumentName, collection: `${unsupportedDocumentName.toLowerCase()}s`, name: `Smoke ${unsupportedDocumentName}` },
        data: { name: `Smoke ${unsupportedDocumentName}` },
        backupRequired: false
      }
    });
    const unsupportedDocument = await callBridge("apply_bridge_plan", {
      plan: unsupportedDocumentPlan,
      confirmation: confirmationForPlan(unsupportedDocumentPlan)
    }, { expectOk: false });
    assert.equal(unsupportedDocument.response.status, 500);
    assert.match(unsupportedDocument.body.error, /Unsupported document plan target/);
  }

  const missingDocumentDataPlan = makeBridgePlan({
    source: "plan_document_changes",
    operation: {
      opId: "op1",
      type: "document.update",
      target: { documentName: "Item", collection: "items", id: "item-1", name: "Smoke Test Item" },
      backupRequired: true
    }
  });
  const missingDocumentData = await callBridge("apply_bridge_plan", {
    plan: missingDocumentDataPlan,
    confirmation: confirmationForPlan(missingDocumentDataPlan)
  }, { expectOk: false });
  assert.equal(missingDocumentData.response.status, 500);
  assert.match(missingDocumentData.body.error, /missing object data/);

  const missingDocumentTargetPlan = makeBridgePlan({
    operationType: "document.update",
    operation: {
      opId: "op1",
      type: "document.update",
      target: { documentName: "Item", collection: "items", name: "Smoke Test Item" },
      data: { name: "Missing Target" },
      backupRequired: true
    }
  });
  const missingDocumentTarget = await callBridge("apply_bridge_plan", {
    plan: missingDocumentTargetPlan,
    confirmation: confirmationForPlan(missingDocumentTargetPlan)
  }, { expectOk: false });
  assert.equal(missingDocumentTarget.response.status, 500);
  assert.match(missingDocumentTarget.body.error, /document id/);

  const unsupportedChatKindPlan = makeBridgePlan({
    operationType: "chat.create_message",
    operation: {
      opId: "op1",
      type: "chat.create_message",
      target: { documentName: "ChatMessage", kind: "unknown", audience: "gms" },
      data: { content: "Smoke", whisper: ["gm"], blind: true },
      backupRequired: false
    }
  });
  const unsupportedChatKind = await callBridge("apply_bridge_plan", {
    plan: unsupportedChatKindPlan,
    confirmation: confirmationForPlan(unsupportedChatKindPlan)
  }, { expectOk: false });
  assert.equal(unsupportedChatKind.response.status, 500);
  assert.match(unsupportedChatKind.body.error, /Unsupported chat message kind/);

  const unsupportedChatAudiencePlan = makeBridgePlan({
    operationType: "chat.create_message",
    operation: {
      opId: "op1",
      type: "chat.create_message",
      target: { documentName: "ChatMessage", kind: "notice", audience: "everyone-nearby" },
      data: { content: "Smoke" },
      backupRequired: false
    }
  });
  const unsupportedChatAudience = await callBridge("apply_bridge_plan", {
    plan: unsupportedChatAudiencePlan,
    confirmation: confirmationForPlan(unsupportedChatAudiencePlan)
  }, { expectOk: false });
  assert.equal(unsupportedChatAudience.response.status, 500);
  assert.match(unsupportedChatAudience.body.error, /Unsupported chat message audience/);

  const emptyChatContentPlan = makeBridgePlan({
    operationType: "chat.create_message",
    operation: {
      opId: "op1",
      type: "chat.create_message",
      target: { documentName: "ChatMessage", kind: "gm_note", audience: "gms" },
      data: { content: "" },
      backupRequired: false
    }
  });
  const emptyChatApply = await callBridge("apply_bridge_plan", {
    plan: emptyChatContentPlan,
    confirmation: confirmationForPlan(emptyChatContentPlan)
  }, { expectOk: false });
  assert.equal(emptyChatApply.response.status, 500);
  assert.match(emptyChatApply.body.error, /non-empty chat content/);

  const missingChatRecipientPlan = makeBridgePlan({
    operationType: "chat.create_message",
    operation: {
      opId: "op1",
      type: "chat.create_message",
      target: { documentName: "ChatMessage", kind: "notice", audience: "users" },
      data: { content: "Smoke" },
      backupRequired: false
    }
  });
  const missingChatRecipient = await callBridge("apply_bridge_plan", {
    plan: missingChatRecipientPlan,
    confirmation: confirmationForPlan(missingChatRecipientPlan)
  }, { expectOk: false });
  assert.equal(missingChatRecipient.response.status, 500);
  assert.match(missingChatRecipient.body.error, /chat user recipients/);

  const unknownSourcePlan = makeBridgePlan({ source: "plan_unknown_changes" });
  const unknownSource = await callBridge("apply_bridge_plan", {
    plan: unknownSourcePlan,
    confirmation: confirmationForPlan(unknownSourcePlan)
  }, { expectOk: false });
  assert.equal(unknownSource.response.status, 500);
  assert.match(unknownSource.body.error, /plan_chat_messages/);

  const appliedViaFallback = await callBridge("call_bridge_tool", {
    method: "apply_bridge_plan",
    args: {
      plan: createPlan,
      confirmation: confirmationForPlan(createPlan)
    }
  });
  assert.equal(appliedViaFallback.body.result.applied, true);
  assert.equal(appliedViaFallback.body.result.backupRequired, false);
  assert.equal(appliedViaFallback.body.result.backup, null);
  assert.equal(appliedViaFallback.body.result.result.method, "apply_bridge_plan");

  const updatePlan = makeBridgePlan({
    operationType: "journal.update_entry",
    backupRequired: true
  });
  const appliedUpdate = await callBridge("apply_bridge_plan", {
    plan: updatePlan,
    confirmation: confirmationForPlan(updatePlan)
  });
  assert.equal(appliedUpdate.body.result.applied, true);
  assert.equal(appliedUpdate.body.result.backupRequired, true);
  assert.equal(appliedUpdate.body.result.backup.ok, true);
  assert.ok(appliedUpdate.body.result.backup.backupPath.includes(`${path.sep}backups${path.sep}`));
  assert.equal(appliedUpdate.body.result.result.method, "apply_bridge_plan");
  assert.equal(JSON.stringify(appliedUpdate.body.result).includes(token), false);

  const sceneCreatePlan = makeBridgePlan({ operationType: "scene.create_token" });
  const appliedSceneCreate = await callBridge("call_bridge_tool", {
    method: "apply_bridge_plan",
    args: {
      plan: sceneCreatePlan,
      confirmation: confirmationForPlan(sceneCreatePlan)
    }
  });
  assert.equal(appliedSceneCreate.body.result.applied, true);
  assert.equal(appliedSceneCreate.body.result.backupRequired, false);
  assert.equal(appliedSceneCreate.body.result.backup, null);
  assert.equal(appliedSceneCreate.body.result.result.method, "apply_bridge_plan");

  const sceneUpdatePlan = makeBridgePlan({
    operationType: "scene.update_light",
    backupRequired: true
  });
  const appliedSceneUpdate = await callBridge("apply_bridge_plan", {
    plan: sceneUpdatePlan,
    confirmation: confirmationForPlan(sceneUpdatePlan)
  });
  assert.equal(appliedSceneUpdate.body.result.applied, true);
  assert.equal(appliedSceneUpdate.body.result.backupRequired, true);
  assert.equal(appliedSceneUpdate.body.result.backup.ok, true);
  assert.equal(appliedSceneUpdate.body.result.result.method, "apply_bridge_plan");
  assert.equal(JSON.stringify(appliedSceneUpdate.body.result).includes(token), false);

  const documentCreatePlan = makeBridgePlan({ operationType: "document.create" });
  const appliedDocumentCreate = await callBridge("call_bridge_tool", {
    method: "apply_bridge_plan",
    args: {
      plan: documentCreatePlan,
      confirmation: confirmationForPlan(documentCreatePlan)
    }
  });
  assert.equal(appliedDocumentCreate.body.result.applied, true);
  assert.equal(appliedDocumentCreate.body.result.backupRequired, false);
  assert.equal(appliedDocumentCreate.body.result.backup, null);
  assert.equal(appliedDocumentCreate.body.result.result.method, "apply_bridge_plan");

  const documentUpdatePlan = makeBridgePlan({
    operationType: "document.update",
    backupRequired: true
  });
  const appliedDocumentUpdate = await callBridge("apply_bridge_plan", {
    plan: documentUpdatePlan,
    confirmation: confirmationForPlan(documentUpdatePlan)
  });
  assert.equal(appliedDocumentUpdate.body.result.applied, true);
  assert.equal(appliedDocumentUpdate.body.result.backupRequired, true);
  assert.equal(appliedDocumentUpdate.body.result.backup.ok, true);
  assert.equal(appliedDocumentUpdate.body.result.result.method, "apply_bridge_plan");
  assert.equal(JSON.stringify(appliedDocumentUpdate.body.result).includes(token), false);

  const chatCreatePlan = makeBridgePlan({ operationType: "chat.create_message" });
  const appliedChatCreate = await callBridge("call_bridge_tool", {
    method: "apply_bridge_plan",
    args: {
      plan: chatCreatePlan,
      confirmation: confirmationForPlan(chatCreatePlan)
    }
  });
  assert.equal(appliedChatCreate.body.result.applied, true);
  assert.equal(appliedChatCreate.body.result.backupRequired, false);
  assert.equal(appliedChatCreate.body.result.backup, null);
  assert.equal(appliedChatCreate.body.result.result.method, "apply_bridge_plan");
  assert.equal(JSON.stringify(appliedChatCreate.body.result).includes(token), false);

  const revoked = await callBridge("revoke_trusted_world", { worldId: dynamicWorldId });
  assert.deepEqual(revoked.body.result, { revoked: true, worldId: dynamicWorldId });

  const afterRevoke = await fetch(`http://127.0.0.1:${port}/status`).then((response) => response.json());
  assert.equal(afterRevoke.trustedSessions, 0);
  assert.equal(afterRevoke.pendingAuthorizationSessions, 1);
  assert.equal(afterRevoke.activeWorld, null);

  gm.close();

  console.log("Smoke test passed: dynamic trust gate, GM authorization, active-world paths, and revocation.");
} finally {
  child.kill("SIGINT");
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
