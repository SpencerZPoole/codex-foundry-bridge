import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(SCRIPT_DIR);
const FOUNDRY_URL = process.env.FOUNDRY_URL ?? "http://127.0.0.1:30000";
const BRIDGE_STATUS_URL = process.env.FOUNDRY_BRIDGE_STATUS_URL ?? "http://127.0.0.1:30123/status";
const BRIDGE_URL = process.env.FOUNDRY_BRIDGE_URL ?? "ws://127.0.0.1:30123/foundry";
const GM_USER_ID = process.env.FOUNDRY_GM_USER_ID ?? "EsLSDXk0uaa6U8wv";
const BROWSER_EXECUTABLE = process.env.PLAYWRIGHT_BROWSER_EXECUTABLE;
const CDP_PORT = Number(process.env.FOUNDRY_BRIDGE_CDP_PORT ?? 39223);
const BROWSER_PROFILE = process.env.FOUNDRY_BRIDGE_BROWSER_PROFILE
  ?? path.join(ROOT_DIR, "logs", "bridge-browser-profile");
const BRIDGE_TOKEN = process.env.CODEX_FOUNDRY_BRIDGE_TOKEN;
const DISABLED_MODULES = ["popout", "popout-resizer", "afk-ready-check", "dd-import", "lib-wrapper", "gm-notes"];

if (!BRIDGE_TOKEN) throw new Error("CODEX_FOUNDRY_BRIDGE_TOKEN is required.");
if (!BROWSER_EXECUTABLE) throw new Error("PLAYWRIGHT_BROWSER_EXECUTABLE is required.");

function log(message, data = null) {
  const payload = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`[codex-foundry-bridge] ${message}${payload}`);
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function pollBridgeStatus({ connected = false, timeoutMs = 120000 } = {}) {
  const started = Date.now();
  let last = null;

  while (Date.now() - started < timeoutMs) {
    try {
      last = await fetchJson(BRIDGE_STATUS_URL);
      if (!connected || last.connectedSessions > 0) return last;
    } catch (error) {
      last = { ok: false, error: error.message };
    }
    await delay(1000);
  }

  throw new Error(`Timed out waiting for bridge status: ${JSON.stringify(last)}`);
}

function launchBrowser() {
  fs.mkdirSync(BROWSER_PROFILE, { recursive: true });
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${BROWSER_PROFILE}`,
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "about:blank"
  ];
  const child = spawn(BROWSER_EXECUTABLE, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child.pid;
}

async function waitForCdp() {
  const url = `http://127.0.0.1:${CDP_PORT}/json/version`;
  const started = Date.now();
  while (Date.now() - started < 30000) {
    try {
      return await fetchJson(url);
    } catch {
      await delay(500);
    }
  }
  throw new Error(`Timed out waiting for Chrome DevTools on port ${CDP_PORT}`);
}

async function createTarget() {
  const target = await fetchJson(
    `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(`${FOUNDRY_URL}/join`)}`,
    { method: "PUT" }
  );
  return target.webSocketDebuggerUrl;
}

class CdpClient {
  constructor(webSocketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.ws = new WebSocket(webSocketUrl);
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.ws.on("message", (data) => this.handleMessage(data));
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload);
    });
  }

  close() {
    this.ws.close();
  }
}

function expressionFor(fn, args = {}) {
  return `(${fn.toString()})(${JSON.stringify(args)})`;
}

async function evaluate(cdp, fn, args = {}, timeoutMs = 30000) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: expressionFor(fn, args),
    awaitPromise: true,
    returnByValue: true,
    timeout: timeoutMs
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "Runtime.evaluate failed");
  }
  return result.result?.value;
}

async function navigate(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await waitFor(cdp, () => document.readyState === "interactive" || document.readyState === "complete", {}, 60000);
}

async function waitFor(cdp, predicate, args = {}, timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const done = await evaluate(cdp, predicate, args, 5000).catch(() => false);
    if (done) return;
    await delay(1000);
  }
  throw new Error(`Timed out waiting for predicate: ${predicate.toString().slice(0, 120)}`);
}

async function seedClientSettings(cdp) {
  await evaluate(cdp, ({ bridgeToken, bridgeUrl }) => {
    localStorage.setItem("codex-foundry-bridge.enabled", "true");
    localStorage.setItem("codex-foundry-bridge.bridgeUrl", JSON.stringify(bridgeUrl));
    localStorage.setItem("codex-foundry-bridge.bridgeToken", JSON.stringify(bridgeToken));
    return true;
  }, { bridgeToken: BRIDGE_TOKEN, bridgeUrl: BRIDGE_URL });
}

async function loginAsGM(cdp) {
  await navigate(cdp, `${FOUNDRY_URL}/join`);
  await seedClientSettings(cdp);
  const result = await evaluate(cdp, async ({ userId }) => {
    const body = new URLSearchParams({ action: "join", userid: userId, password: "" });
    const response = await fetch("/join", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    return { ok: response.ok, status: response.status, text: await response.text() };
  }, { userId: GM_USER_ID });

  if (!result.ok) throw new Error(`GM login failed with HTTP ${result.status}: ${result.text}`);
}

async function enableBridgeModule(cdp) {
  await navigate(cdp, `${FOUNDRY_URL}/game`);
  await waitFor(cdp, () => globalThis.game?.ready === true, {}, 180000);
  await seedClientSettings(cdp);

  const summary = await evaluate(cdp, async ({ disabledModules }) => {
    const current = foundry.utils.deepClone(game.settings.get("core", "moduleConfiguration") ?? {});
    for (const id of disabledModules) current[id] = false;
    current["codex-foundry-bridge"] = true;
    await game.settings.set("core", "moduleConfiguration", current);
    return {
      codexBridge: current["codex-foundry-bridge"] === true,
      disabled: Object.fromEntries(disabledModules.map((id) => [id, current[id] === true]))
    };
  }, { disabledModules: DISABLED_MODULES });

  log("module configuration updated", summary);
}

async function connectBridge(cdp) {
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(cdp, () => document.readyState === "interactive" || document.readyState === "complete", {}, 60000);
  await waitFor(cdp, () => globalThis.game?.ready === true, {}, 180000);
  await seedClientSettings(cdp);
  await waitFor(cdp, () => globalThis.CodexFoundryBridge && game.modules.get("codex-foundry-bridge")?.active === true);

  const status = await evaluate(cdp, async ({ bridgeToken }) => {
    await globalThis.CodexFoundryBridge.setToken(bridgeToken);
    const bridgeStatus = await globalThis.CodexFoundryBridge.status();
    return {
      foundry: bridgeStatus.foundry?.version,
      world: bridgeStatus.world?.id,
      system: bridgeStatus.system?.id,
      systemVersion: bridgeStatus.system?.version,
      bridge: bridgeStatus.bridge
    };
  }, { bridgeToken: BRIDGE_TOKEN });

  const daemon = await pollBridgeStatus({ connected: true });
  log("connected", { ...status, connectedSessions: daemon.connectedSessions });
}

await pollBridgeStatus();
const browserPid = launchBrowser();
log("browser launched", { browserPid, cdpPort: CDP_PORT });
await waitForCdp();

const wsUrl = await createTarget();
const cdp = new CdpClient(wsUrl);
await cdp.open();

try {
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await loginAsGM(cdp);
  await enableBridgeModule(cdp);
  await connectBridge(cdp);
} finally {
  cdp.close();
}
