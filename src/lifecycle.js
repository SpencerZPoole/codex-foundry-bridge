import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";

const execFileAsync = promisify(execFile);

const DEFAULT_FOUNDRY_URL = "http://127.0.0.1:30000";
const DEFAULT_FOUNDRY_EXECUTABLE = "C:\\Program Files\\Foundry Virtual Tabletop\\Foundry Virtual Tabletop.exe";
const DEFAULT_ADMIN_CREDENTIAL_TARGET = "FoundryCodexBridge/AdminPassword";
const DEFAULT_CDP_PORT = 39223;
const DEFAULT_TIMEOUTS = {
  stopGraceMs: 15000,
  stopForceMs: 10000,
  startupMs: 90000,
  worldLaunchMs: 180000,
  gmJoinMs: 180000,
  bridgeReadyMs: 120000,
  pollMs: 1000
};
const BROWSER_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWorldId(worldId) {
  return String(worldId ?? "").trim();
}

function resolveMaybeRelative(root, value) {
  if (!value) return value;
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function readJsonIfExists(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function findBrowserExecutable() {
  return BROWSER_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function powerShellString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function lifecycleConfigPath(context) {
  return process.env.FOUNDRY_BRIDGE_LIFECYCLE_CONFIG
    || path.join(context.configDir, "lifecycle.json");
}

function resolveLifecycleConfig(args, context) {
  const filePath = lifecycleConfigPath(context);
  const fileConfig = context.lifecycleConfig ?? readJsonIfExists(filePath, {});
  const worldId = normalizeWorldId(args.worldId);
  const worlds = fileConfig.worlds ?? {};
  const worldConfig = worlds[worldId] ?? {};
  const foundryUrl = String(
    args.foundryUrl
    ?? process.env.FOUNDRY_URL
    ?? fileConfig.foundryUrl
    ?? DEFAULT_FOUNDRY_URL
  ).replace(/\/+$/, "");

  const foundryExecutable = resolveMaybeRelative(
    context.root,
    args.foundryExecutable
      ?? process.env.FOUNDRY_EXECUTABLE
      ?? fileConfig.foundryExecutable
      ?? DEFAULT_FOUNDRY_EXECUTABLE
  );
  const browserExecutable = resolveMaybeRelative(
    context.root,
    process.env.PLAYWRIGHT_BROWSER_EXECUTABLE
      ?? args.browserExecutable
      ?? fileConfig.browserExecutable
      ?? findBrowserExecutable()
  );
  const browserProfile = resolveMaybeRelative(
    context.root,
    args.browserProfile
      ?? fileConfig.browserProfile
      ?? path.join("logs", "bridge-browser-profile")
  );

  return {
    configPath: filePath,
    foundryUrl,
    foundryExecutable,
    foundryDataDir: fileConfig.foundryDataDir ?? context.foundryDataDir,
    bridgeStatusUrl: `http://${context.bridgeHost}:${context.bridgePort}/status`,
    bridgeUrl: `ws://${context.bridgeHost}:${context.bridgePort}/foundry`,
    bridgeToken: context.bridgeToken,
    cdpPort: Number(args.cdpPort ?? fileConfig.cdpPort ?? DEFAULT_CDP_PORT),
    browserExecutable,
    browserProfile,
    adminCredentialTarget: fileConfig.credentials?.adminTarget ?? DEFAULT_ADMIN_CREDENTIAL_TARGET,
    gmUserId: args.gmUserId ?? worldConfig.gmUserId ?? fileConfig.gmUserId ?? null,
    gmCredentialTarget: worldConfig.gmCredentialTarget
      ?? fileConfig.credentials?.gmTargets?.[worldId]
      ?? `FoundryCodexBridge/World/${worldId}/GM`,
    allowBlankGmPassword: Boolean(worldConfig.allowBlankGmPassword ?? fileConfig.allowBlankGmPassword),
    timeouts: { ...DEFAULT_TIMEOUTS, ...(args.timeouts ?? {}) }
  };
}

function optionsPath(config) {
  return path.join(config.foundryDataDir, "Config", "options.json");
}

function adminPasswordPath(config) {
  return path.join(config.foundryDataDir, "Config", "admin.txt");
}

function dataDirectoryLockPath(config) {
  return path.join(config.foundryDataDir, "Config", "options.json.lock");
}

function worldPath(config, worldId) {
  return path.join(config.foundryDataDir, "Data", "worlds", worldId);
}

function hasConfiguredAdminPassword(config) {
  const adminFile = adminPasswordPath(config);
  if (fs.existsSync(adminFile) && fs.statSync(adminFile).size > 0) return true;
  const options = readJsonIfExists(optionsPath(config), {});
  return Boolean(options.adminPassword);
}

async function runPhase(result, name, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    result.phases.push({ name, ok: true, ms: Date.now() - started });
    return value;
  } catch (error) {
    result.phases.push({
      name,
      ok: false,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  header() {
    return [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  }

  store(response) {
    const setCookies = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
    for (const line of setCookies) {
      const first = String(line).split(";")[0];
      const index = first.indexOf("=");
      if (index <= 0) continue;
      this.cookies.set(first.slice(0, index), first.slice(index + 1));
    }
  }
}

class FoundryHttpSession {
  constructor(config, fetchImpl) {
    this.config = config;
    this.fetch = fetchImpl;
    this.cookies = new CookieJar();
  }

  async request(route, { method = "GET", form = null, json = null, okStatuses = [200], allowRedirect = false } = {}) {
    const headers = {};
    const cookieHeader = this.cookies.header();
    if (cookieHeader) headers.cookie = cookieHeader;
    let body;
    if (form) {
      body = new URLSearchParams(form);
      headers["content-type"] = "application/x-www-form-urlencoded";
    } else if (json) {
      body = JSON.stringify(json);
      headers["content-type"] = "application/json";
    }
    const response = await this.fetch(`${this.config.foundryUrl}${route}`, {
      method,
      headers,
      body,
      redirect: allowRedirect ? "follow" : "manual"
    });
    this.cookies.store(response);
    if (!okStatuses.includes(response.status)) {
      const text = await response.text().catch(() => "");
      throw new Error(`Foundry ${method} ${route} returned HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    return response;
  }

  async json(route) {
    const response = await this.request(route, { okStatuses: [200] });
    return response.json();
  }
}

async function defaultListFoundryProcesses(executablePath) {
  if (process.platform !== "win32") return [];
  const command = `
$target = [System.IO.Path]::GetFullPath(${powerShellString(executablePath)})
Get-CimInstance Win32_Process |
  Where-Object { $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $target) } |
  Select-Object ProcessId,Name,ExecutablePath |
  ConvertTo-Json -Depth 4
`;
  const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", command], {
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function defaultForceKillProcesses(processes) {
  if (!processes.length) return;
  if (process.platform !== "win32") {
    for (const entry of processes) process.kill(Number(entry.ProcessId), "SIGKILL");
    return;
  }
  const ids = processes
    .map((entry) => Number.parseInt(String(entry.ProcessId), 10))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return;
  const command = `
$ids = @(${ids.join(",")})
foreach ($id in $ids) {
  Stop-Process -Id ([int]$id) -Force
}
`;
  await execFileAsync("powershell", ["-NoProfile", "-Command", command], { windowsHide: true });
}

function defaultLaunchFoundryProcess(executablePath) {
  const child = spawn(executablePath, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();
  return { pid: child.pid };
}

async function defaultReadCredential(target) {
  if (process.platform !== "win32") return null;
  const command = `
$ErrorActionPreference = "Stop"
$target = ${powerShellString(target)}
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CredMan {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 reservedFlag, out IntPtr credentialPtr);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr buffer);
}
"@
$ptr = [IntPtr]::Zero
if (-not [CredMan]::CredRead($target, 1, 0, [ref]$ptr)) { exit 44 }
try {
  $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][CredMan+CREDENTIAL])
  $userName = [Runtime.InteropServices.Marshal]::PtrToStringUni($credential.UserName)
  $password = ""
  if (($credential.CredentialBlob -ne [IntPtr]::Zero) -and ($credential.CredentialBlobSize -gt 0)) {
    $password = [Runtime.InteropServices.Marshal]::PtrToStringUni($credential.CredentialBlob, [int]($credential.CredentialBlobSize / 2))
  }
  [pscustomobject]@{ userName = $userName; password = $password } | ConvertTo-Json -Compress
} finally {
  if ($ptr -ne [IntPtr]::Zero) { [CredMan]::CredFree($ptr) }
}
`;
  try {
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", command], {
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (error.code === 44) return null;
    throw error;
  }
}

function createDefaultLifecycleDeps() {
  return {
    fetch: globalThis.fetch,
    sleep: delay,
    listFoundryProcesses: defaultListFoundryProcesses,
    forceKillProcesses: defaultForceKillProcesses,
    launchFoundryProcess: defaultLaunchFoundryProcess,
    readCredential: defaultReadCredential,
    joinGmClient: joinGmClientWithCdp
  };
}

async function waitForProcessesGone(config, deps, timeoutMs) {
  const started = Date.now();
  let last = [];
  while (Date.now() - started < timeoutMs) {
    last = await deps.listFoundryProcesses(config.foundryExecutable);
    if (!last.length) return { stopped: true, last };
    await deps.sleep(config.timeouts.pollMs);
  }
  return { stopped: false, last };
}

async function releaseDataDirectoryLockAfterStop(config, deps) {
  const lockPath = dataDirectoryLockPath(config);
  const started = Date.now();
  let removed = false;
  while (Date.now() - started < config.timeouts.stopForceMs) {
    if (!fs.existsSync(lockPath)) {
      return { path: lockPath, exists: false, removed, ms: Date.now() - started };
    }

    const processes = await deps.listFoundryProcesses(config.foundryExecutable);
    if (!processes.length) {
      fs.rmSync(lockPath, { recursive: true, force: true });
      removed = true;
    }
    await deps.sleep(config.timeouts.pollMs);
  }

  const exists = fs.existsSync(lockPath);
  if (exists) {
    throw new Error(`Foundry data directory lock remains after process exit: ${lockPath}`);
  }
  return { path: lockPath, exists: false, removed, ms: Date.now() - started };
}

async function stopFoundry(config, deps, adminPassword, adminRequired) {
  const before = await deps.listFoundryProcesses(config.foundryExecutable);
  if (!before.length) {
    const dataLock = await releaseDataDirectoryLockAfterStop(config, deps);
    return { method: "not-running", beforeProcessCount: 0, forced: false, dataLock };
  }

  let gracefulAttempted = false;
  let gracefulError = null;
  if (!adminRequired || adminPassword !== null) {
    gracefulAttempted = true;
    try {
      const session = new FoundryHttpSession(config, deps.fetch);
      await session.request("/quit", {
        method: "POST",
        form: adminRequired ? { adminPassword } : {},
        okStatuses: [200, 302]
      });
    } catch (error) {
      gracefulError = error instanceof Error ? error.message : String(error);
    }
  }

  const graceful = await waitForProcessesGone(config, deps, config.timeouts.stopGraceMs);
  if (graceful.stopped) {
    const dataLock = await releaseDataDirectoryLockAfterStop(config, deps);
    return {
      method: "foundry-quit-route",
      beforeProcessCount: before.length,
      forced: false,
      gracefulAttempted,
      gracefulError,
      dataLock
    };
  }

  await deps.forceKillProcesses(graceful.last);
  const forced = await waitForProcessesGone(config, deps, config.timeouts.stopForceMs);
  if (!forced.stopped) {
    throw new Error(`Foundry did not exit after force stop; remaining process count: ${forced.last.length}`);
  }
  const dataLock = await releaseDataDirectoryLockAfterStop(config, deps);
  return {
    method: "force-kill-after-timeout",
    beforeProcessCount: before.length,
    forced: true,
    gracefulAttempted,
    gracefulError,
    dataLock
  };
}

async function waitForFoundryHttp(config, deps) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < config.timeouts.startupMs) {
    try {
      const response = await deps.fetch(`${config.foundryUrl}/api/status`);
      if (response.ok) return response.json();
    } catch (error) {
      lastError = error;
    }
    try {
      const response = await deps.fetch(`${config.foundryUrl}/auth`, { redirect: "manual" });
      if (response.status >= 200 && response.status < 500) return { active: false };
    } catch (error) {
      lastError = error;
    }
    await deps.sleep(config.timeouts.pollMs);
  }
  throw new Error(`Foundry HTTP did not become reachable: ${lastError?.message ?? "timeout"}`);
}

async function authenticateAdminIfNeeded(session, adminPassword, adminRequired) {
  if (!adminRequired) {
    await session.request("/setup", { okStatuses: [200, 302] });
    return { required: false };
  }
  const response = await session.request("/auth", {
    method: "POST",
    form: { adminPassword },
    okStatuses: [200, 302]
  });
  return { required: true, status: response.status };
}

async function launchWorld(config, deps, worldId, adminPassword, adminRequired) {
  const session = new FoundryHttpSession(config, deps.fetch);
  await authenticateAdminIfNeeded(session, adminPassword, adminRequired);
  const current = await session.json("/api/status").catch(() => null);
  if (current?.active && current.world === worldId) {
    return { alreadyActive: true, world: current.world };
  }
  if (current?.active && current.world !== worldId) {
    throw new Error(`Foundry launched unexpected active world ${current.world}; refusing to switch to ${worldId}.`);
  }

  const response = await session.request("/setup", {
    method: "POST",
    json: { action: "launchWorld", world: worldId },
    okStatuses: [200, 302]
  });
  if (response.headers.get("content-type")?.includes("application/json")) {
    const payload = await response.json();
    if (payload?.error) throw new Error(`Foundry world launch failed: ${payload.error}`);
  }

  const started = Date.now();
  let last = null;
  while (Date.now() - started < config.timeouts.worldLaunchMs) {
    last = await session.json("/api/status").catch(() => null);
    if (last?.active && last.world === worldId) {
      return { alreadyActive: false, world: last.world, foundry: last.version, system: last.system, systemVersion: last.systemVersion };
    }
    await deps.sleep(config.timeouts.pollMs);
  }
  throw new Error(`Timed out waiting for world ${worldId} to launch; last status: ${JSON.stringify(last)}`);
}

async function pollBridgeReady(config, deps, worldId) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < config.timeouts.bridgeReadyMs) {
    try {
      const response = await deps.fetch(config.bridgeStatusUrl);
      if (response.ok) {
        last = await response.json();
        if (last.activeWorld === worldId && last.trustedSessions > 0) return last;
      }
    } catch (error) {
      last = { error: error.message };
    }
    await deps.sleep(config.timeouts.pollMs);
  }
  throw new Error(`Timed out waiting for trusted bridge session for ${worldId}; last status: ${JSON.stringify(last)}`);
}

async function fetchJson(url, fetchImpl, options = {}) {
  const response = await fetchImpl(url, options);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
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

async function waitForCdp(config, deps, timeoutMs = 30000) {
  const started = Date.now();
  const url = `http://127.0.0.1:${config.cdpPort}/json/version`;
  while (Date.now() - started < timeoutMs) {
    try {
      return await fetchJson(url, deps.fetch);
    } catch {
      await deps.sleep(500);
    }
  }
  throw new Error(`Timed out waiting for Chrome DevTools on port ${config.cdpPort}`);
}

function launchBrowser(config) {
  if (!config.browserExecutable) throw new Error("No browser executable found for CDP GM client automation.");
  fs.mkdirSync(config.browserProfile, { recursive: true });
  const args = [
    `--remote-debugging-port=${config.cdpPort}`,
    `--user-data-dir=${config.browserProfile}`,
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "about:blank"
  ];
  const child = spawn(config.browserExecutable, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child.pid;
}

async function ensureCdpBrowser(config, deps) {
  try {
    await waitForCdp(config, deps, 1000);
    return { reused: true, pid: null };
  } catch {
    const pid = launchBrowser(config);
    await waitForCdp(config, deps);
    return { reused: false, pid };
  }
}

async function createTarget(config, deps) {
  const target = await fetchJson(
    `http://127.0.0.1:${config.cdpPort}/json/new?${encodeURIComponent(`${config.foundryUrl}/join`)}`,
    deps.fetch,
    { method: "PUT" }
  );
  return target.webSocketDebuggerUrl;
}

async function waitFor(cdp, deps, predicate, args = {}, timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const done = await evaluate(cdp, predicate, args, 5000).catch(() => false);
    if (done) return;
    await deps.sleep(1000);
  }
  throw new Error(`Timed out waiting for predicate: ${predicate.toString().slice(0, 120)}`);
}

async function navigate(cdp, deps, url) {
  await cdp.send("Page.navigate", { url });
  await waitFor(cdp, deps, () => document.readyState === "interactive" || document.readyState === "complete", {}, 60000);
}

async function seedClientSettings(cdp, config) {
  await evaluate(cdp, ({ bridgeToken, bridgeUrl }) => {
    localStorage.setItem("codex-foundry-bridge.enabled", "true");
    localStorage.setItem("codex-foundry-bridge.bridgeUrl", JSON.stringify(bridgeUrl));
    localStorage.setItem("codex-foundry-bridge.bridgeToken", JSON.stringify(bridgeToken));
    return true;
  }, { bridgeToken: config.bridgeToken, bridgeUrl: config.bridgeUrl });
}

async function joinGmClientWithCdp(config, deps, { worldId, gmUserId, gmPassword }) {
  const browser = await ensureCdpBrowser(config, deps);
  const wsUrl = await createTarget(config, deps);
  const cdp = new CdpClient(wsUrl);
  await cdp.open();
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await navigate(cdp, deps, `${config.foundryUrl}/join`);
    await seedClientSettings(cdp, config);
    const joinResult = await evaluate(cdp, async ({ userId, password }) => {
      const response = await fetch("/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "join", userid: userId, password })
      });
      return { ok: response.ok, status: response.status, text: response.ok ? "" : await response.text() };
    }, { userId: gmUserId, password: gmPassword });
    if (!joinResult.ok) {
      throw new Error(`GM login failed with HTTP ${joinResult.status}: ${String(joinResult.text).slice(0, 200)}`);
    }

    await navigate(cdp, deps, `${config.foundryUrl}/game`);
    await waitFor(cdp, deps, () => globalThis.game?.ready === true, {}, config.timeouts.gmJoinMs);
    await seedClientSettings(cdp, config);
    const moduleState = await evaluate(cdp, async () => {
      const current = foundry.utils.deepClone(game.settings.get("core", "moduleConfiguration") ?? {});
      if (current["codex-foundry-bridge"] === true) return { changed: false, active: game.modules.get("codex-foundry-bridge")?.active === true };
      current["codex-foundry-bridge"] = true;
      await game.settings.set("core", "moduleConfiguration", current);
      return { changed: true, active: false };
    });

    if (moduleState.changed || !moduleState.active) {
      await cdp.send("Page.reload", { ignoreCache: true });
      await waitFor(cdp, deps, () => document.readyState === "interactive" || document.readyState === "complete", {}, 60000);
      await waitFor(cdp, deps, () => globalThis.game?.ready === true, {}, config.timeouts.gmJoinMs);
      await seedClientSettings(cdp, config);
    }

    await waitFor(
      cdp,
      deps,
      () => globalThis.CodexFoundryBridge && game.modules.get("codex-foundry-bridge")?.active === true,
      {},
      config.timeouts.gmJoinMs
    );
    const bridgeStatus = await evaluate(cdp, async ({ bridgeToken }) => {
      await globalThis.CodexFoundryBridge.setToken(bridgeToken);
      return globalThis.CodexFoundryBridge.status();
    }, { bridgeToken: config.bridgeToken });
    return {
      browser,
      worldId,
      gmUserId,
      moduleEnabledDuringRun: moduleState.changed,
      bridgeStatus
    };
  } finally {
    cdp.close();
  }
}

async function resolveCredential(config, deps, target, { required, allowBlank = false, label }) {
  const credential = await deps.readCredential(target);
  if (credential) return credential.password ?? "";
  if (allowBlank) return "";
  if (required) throw new Error(`Missing ${label} credential: ${target}`);
  return null;
}

export async function restartFoundryWorld(args = {}, context = {}, injectedDeps = {}) {
  if (args.dangerous !== true) throw new Error("restart_foundry_world requires dangerous=true");
  const worldId = normalizeWorldId(args.worldId);
  if (!worldId) throw new Error("restart_foundry_world requires an explicit worldId.");

  const config = resolveLifecycleConfig(args, context);
  const deps = { ...createDefaultLifecycleDeps(), ...injectedDeps };
  if (!config.bridgeToken) throw new Error("CODEX_FOUNDRY_BRIDGE_TOKEN is required.");
  if (!config.gmUserId) throw new Error(`No GM user id configured for world ${worldId}. Provide gmUserId or config/lifecycle.json.`);
  if (!fs.existsSync(config.foundryExecutable)) throw new Error(`Foundry executable not found: ${config.foundryExecutable}`);
  if (!fs.existsSync(worldPath(config, worldId))) throw new Error(`Foundry world directory not found: ${worldPath(config, worldId)}`);

  const adminRequired = hasConfiguredAdminPassword(config);
  const adminPassword = await resolveCredential(config, deps, config.adminCredentialTarget, {
    required: adminRequired,
    label: "Foundry administrator"
  });
  const gmPassword = await resolveCredential(config, deps, config.gmCredentialTarget, {
    required: !config.allowBlankGmPassword,
    allowBlank: config.allowBlankGmPassword,
    label: `${worldId} GM access key`
  });

  const result = {
    ok: false,
    worldId,
    gmUserId: config.gmUserId,
    foundryUrl: config.foundryUrl,
    foundryExecutable: config.foundryExecutable,
    credentialTargets: {
      admin: adminRequired ? config.adminCredentialTarget : null,
      gm: config.allowBlankGmPassword && gmPassword === "" ? null : config.gmCredentialTarget
    },
    adminCredentialRequired: adminRequired,
    phases: []
  };

  result.stop = await runPhase(result, "stop_foundry", () => stopFoundry(config, deps, adminPassword, adminRequired));
  result.start = await runPhase(result, "start_foundry", async () => {
    const launch = deps.launchFoundryProcess(config.foundryExecutable);
    const status = await waitForFoundryHttp(config, deps);
    return { ...launch, status };
  });
  result.launchWorld = await runPhase(result, "launch_world", () => launchWorld(config, deps, worldId, adminPassword, adminRequired));
  result.joinGm = await runPhase(result, "join_gm_client", () => deps.joinGmClient(config, deps, {
    worldId,
    gmUserId: config.gmUserId,
    gmPassword
  }));
  result.bridge = await runPhase(result, "verify_bridge_ready", () => pollBridgeReady(config, deps, worldId));
  result.ok = true;
  return result;
}
