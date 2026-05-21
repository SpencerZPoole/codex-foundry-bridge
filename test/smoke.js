import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
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
    gm.send(JSON.stringify({
      type: "response",
      id: message.id,
      ok: true,
      result: {
        connected: true,
        world: { id: dynamicWorldId, title: "Dynamic Smoke World" },
        method: message.method
      }
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
