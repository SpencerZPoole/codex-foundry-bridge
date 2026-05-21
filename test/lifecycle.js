import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { restartFoundryWorld } from "../src/lifecycle.js";

const worldId = "scratch";
const gmUserId = "gm-user";
const adminTarget = "FoundryCodexBridge/AdminPassword";
const gmTarget = `FoundryCodexBridge/World/${worldId}/GM`;

function waitForServer(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (String(request.headers["content-type"] ?? "").includes("application/json")) {
        const parsed = JSON.parse(body || "{}");
        resolve({
          get: (key) => parsed[key] == null ? null : String(parsed[key])
        });
        return;
      }
      resolve(new URLSearchParams(body));
    });
    request.on("error", reject);
  });
}

async function createFakeFoundry(state) {
  const server = http.createServer(async (request, response) => {
    if (!state.httpUp) {
      response.writeHead(503);
      response.end("offline");
      return;
    }

    if (request.url === "/api/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        active: Boolean(state.activeWorld),
        version: "14.361",
        world: state.activeWorld,
        system: state.activeWorld ? "D35E" : null,
        systemVersion: state.activeWorld ? "3.0.2" : null,
        users: state.joinedGmUser ? 1 : 0
      }));
      return;
    }

    if (request.url === "/auth" && request.method === "POST") {
      const body = await readBody(request);
      if (body.get("adminPassword") !== state.adminPassword) {
        response.writeHead(403);
        response.end("bad admin password");
        return;
      }
      response.writeHead(302, { location: "/setup", "set-cookie": "session=admin; HttpOnly" });
      response.end();
      return;
    }

    if (request.url === "/setup" && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html>setup</html>");
      return;
    }

    if (request.url === "/setup" && request.method === "POST") {
      if (state.adminRequired && !String(request.headers.cookie ?? "").includes("session=admin")) {
        response.writeHead(403);
        response.end("admin required");
        return;
      }
      const body = await readBody(request);
      if (body.get("action") !== "launchWorld") {
        response.writeHead(400);
        response.end("bad action");
        return;
      }
      state.activeWorld = body.get("world");
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }

    if (request.url === "/quit" && request.method === "POST") {
      const body = await readBody(request);
      const hasAdmin = String(request.headers.cookie ?? "").includes("session=admin")
        || body.get("adminPassword") === state.adminPassword
        || !state.adminRequired;
      if (!hasAdmin) {
        response.writeHead(403);
        response.end("admin required");
        return;
      }
      state.quitAttempts += 1;
      if (state.quitStops) {
        state.running = false;
        state.httpUp = false;
        state.activeWorld = null;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "failed" }));
      return;
    }

    response.writeHead(404);
    response.end();
  });
  await waitForServer(server);
  return server;
}

async function createFakeBridge(state) {
  const server = http.createServer((request, response) => {
    if (request.url !== "/status") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      connectedSessions: state.bridgeReady ? 1 : 0,
      trustedSessions: state.bridgeReady ? 1 : 0,
      pendingAuthorizationSessions: 0,
      activeWorld: state.bridgeReady ? state.activeWorld : null,
      trustedWorlds: state.bridgeReady ? [state.activeWorld] : []
    }));
  });
  await waitForServer(server);
  return server;
}

function createTempContext({ adminRequired = false, lifecycleConfig = {} } = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-codex-bridge-lifecycle-"));
  const foundryDataDir = path.join(tempRoot, "FoundryVTT");
  const configDir = path.join(foundryDataDir, "Config");
  const worldDir = path.join(foundryDataDir, "Data", "worlds", worldId);
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(worldDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "options.json"), JSON.stringify({
    adminPassword: adminRequired ? "hashed-admin-password" : null
  }), "utf8");
  if (adminRequired) fs.writeFileSync(path.join(configDir, "admin.txt"), "hashed-admin-password", "utf8");
  const executable = path.join(tempRoot, "Foundry Virtual Tabletop.exe");
  fs.writeFileSync(executable, "", "utf8");
  return {
    tempRoot,
    executable,
    context: {
      root: tempRoot,
      configDir: path.join(tempRoot, "config"),
      foundryDataDir,
      bridgeHost: "127.0.0.1",
      bridgePort: 0,
      bridgeToken: "bridge-test-token",
      lifecycleConfig: {
        credentials: { adminTarget },
        worlds: {
          [worldId]: { gmUserId, gmCredentialTarget: gmTarget }
        },
        ...lifecycleConfig
      }
    }
  };
}

function createDeps(state, credentials) {
  return {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2))),
    listFoundryProcesses: async () => (state.running ? [{ ProcessId: 1001 }] : []),
    forceKillProcesses: async () => {
      state.forceKills += 1;
      state.running = false;
      state.httpUp = false;
      state.activeWorld = null;
    },
    launchFoundryProcess: () => {
      state.launches += 1;
      state.running = true;
      state.httpUp = true;
      state.activeWorld = null;
      return { pid: 2002 };
    },
    readCredential: async (target) => credentials.get(target) ?? null,
    joinGmClient: async (config, deps, { gmUserId: userId, gmPassword }) => {
      assert.equal(userId, gmUserId);
      assert.equal(gmPassword, state.expectedGmPassword);
      state.joinedGmUser = userId;
      state.bridgeReady = true;
      return {
        worldId: state.activeWorld,
        gmUserId: userId,
        moduleEnabledDuringRun: false,
        bridgeStatus: { world: { id: state.activeWorld } }
      };
    }
  };
}

async function runRestart({ adminRequired = false, quitStops = true, allowBlank = false, staleDataLock = false, credentials = new Map() } = {}) {
  const temp = createTempContext({
    adminRequired,
    lifecycleConfig: {
      worlds: {
        [worldId]: {
          gmUserId,
          gmCredentialTarget: gmTarget,
          allowBlankGmPassword: allowBlank
        }
      }
    }
  });
  if (staleDataLock) {
    fs.mkdirSync(path.join(temp.context.foundryDataDir, "Config", "options.json.lock"), { recursive: true });
  }
  const state = {
    running: true,
    httpUp: true,
    activeWorld: worldId,
    adminRequired,
    adminPassword: "admin-secret",
    expectedGmPassword: allowBlank ? "" : "gm-secret",
    quitStops,
    quitAttempts: 0,
    forceKills: 0,
    launches: 0,
    bridgeReady: false,
    joinedGmUser: null
  };
  const foundry = await createFakeFoundry(state);
  const bridge = await createFakeBridge(state);
  const foundryPort = foundry.address().port;
  const bridgePort = bridge.address().port;
  temp.context.bridgePort = bridgePort;
  const deps = {
    ...createDeps(state, credentials),
    fetch: globalThis.fetch
  };

  try {
    const result = await restartFoundryWorld({
      worldId,
      dangerous: true,
      foundryExecutable: temp.executable,
      foundryUrl: `http://127.0.0.1:${foundryPort}`,
      timeouts: {
        stopGraceMs: 10,
        stopForceMs: 10,
        startupMs: 100,
        worldLaunchMs: 100,
        gmJoinMs: 100,
        bridgeReadyMs: 100,
        pollMs: 1
      }
    }, temp.context, deps);
    return { result, state };
  } finally {
    await closeServer(foundry);
    await closeServer(bridge);
    fs.rmSync(temp.tempRoot, { recursive: true, force: true });
  }
}

await assert.rejects(
  () => restartFoundryWorld({ worldId, dangerous: false }, {}),
  /dangerous=true/
);
await assert.rejects(
  () => restartFoundryWorld({ dangerous: true }, {}),
  /explicit worldId/
);

{
  const temp = createTempContext({ adminRequired: true });
  const state = { running: true };
  try {
    await assert.rejects(
      () => restartFoundryWorld({
        worldId,
        dangerous: true,
        foundryExecutable: temp.executable
      }, temp.context, createDeps(state, new Map([[gmTarget, { password: "gm-secret" }]]))),
      /Missing Foundry administrator credential/
    );
    assert.equal(state.running, true);
  } finally {
    fs.rmSync(temp.tempRoot, { recursive: true, force: true });
  }
}

{
  const temp = createTempContext();
  const state = { running: true };
  try {
    await assert.rejects(
      () => restartFoundryWorld({
        worldId,
        dangerous: true,
        foundryExecutable: temp.executable
      }, temp.context, createDeps(state, new Map())),
      /Missing scratch GM access key credential/
    );
    assert.equal(state.running, true);
  } finally {
    fs.rmSync(temp.tempRoot, { recursive: true, force: true });
  }
}

{
  const { result, state } = await runRestart({
    adminRequired: true,
    quitStops: true,
    credentials: new Map([
      [adminTarget, { password: "admin-secret" }],
      [gmTarget, { password: "gm-secret" }]
    ])
  });
  assert.equal(result.ok, true);
  assert.equal(result.worldId, worldId);
  assert.equal(result.stop.forced, false);
  assert.equal(result.stop.method, "foundry-quit-route");
  assert.equal(result.start.pid, 2002);
  assert.equal(result.launchWorld.world, worldId);
  assert.equal(result.bridge.activeWorld, worldId);
  assert.equal(state.quitAttempts, 1);
  assert.equal(state.forceKills, 0);
  assert.equal(state.launches, 1);
  assert.equal(JSON.stringify(result).includes("admin-secret"), false);
  assert.equal(JSON.stringify(result).includes("gm-secret"), false);
}

{
  const { result, state } = await runRestart({
    adminRequired: false,
    quitStops: false,
    allowBlank: true,
    staleDataLock: true,
    credentials: new Map()
  });
  assert.equal(result.ok, true);
  assert.equal(result.stop.forced, true);
  assert.equal(result.stop.method, "force-kill-after-timeout");
  assert.equal(result.stop.dataLock.removed, true);
  assert.equal(result.stop.dataLock.exists, false);
  assert.equal(result.credentialTargets.gm, null);
  assert.equal(state.forceKills, 1);
  assert.equal(state.joinedGmUser, gmUserId);
}

console.log("Lifecycle restart orchestration checks passed.");
