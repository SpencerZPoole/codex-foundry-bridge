const MODULE_ID = "codex-foundry-bridge";
const MODULE_VERSION = "0.2.9";
const DEFAULT_URL = "ws://127.0.0.1:30123/foundry";
const RECONNECT_MS = 5000;
const MAX_RESULT_CHARS = 1_000_000;
const MAX_RUNTIME_EVENTS = 250;
const MAX_TIMELINE_EVENTS = 500;
const BRIDGE_PLAN_TTL_MS = 30 * 60 * 1000;
const RUNTIME_CAPTURE_FLAG = "__codexFoundryBridgeRuntimeCaptureInstalled";
const CONSOLE_PATCH_FLAG = "__codexFoundryBridgeConsolePatched";
const NOTIFICATION_PATCH_FLAG = "__codexFoundryBridgeNotificationsPatched";
const TIMELINE_HOOK_FLAG = "__codexFoundryBridgeTimelineHooksInstalled";
const SENSITIVE_FIELD_PATTERN = /password|secret|license|adminPassword|adminKey|apiKey|privateKey|hash|salt|accessToken|refreshToken|bearerToken|bridgeToken/i;
const COLLECTION_KEYS_BY_DOCUMENT_NAME = {
  Actor: "actors",
  Cards: "cards",
  ChatMessage: "messages",
  Combat: "combats",
  FogExploration: "fog",
  Folder: "folders",
  Item: "items",
  JournalEntry: "journal",
  Macro: "macros",
  Playlist: "playlists",
  RollTable: "tables",
  Scene: "scenes",
  Setting: "settings",
  User: "users"
};

let socket = null;
let reconnectTimer = null;
let requestCounter = 0;
let runtimeEventCounter = 0;
let timelineEventCounter = 0;
const pending = new Map();
let runtimeEvents = [];
let timelineEvents = [];
let authorizationStatus = { trusted: null, world: null, trustedWorlds: [] };
let authorizationPromptOpen = false;
let authorizationPromptDismissedForWorld = null;
let lifecycleRequestCounter = 0;
const lifecyclePending = new Map();

function isSensitiveField(key) {
  if (String(key).toLowerCase() === "planhash") return false;
  return String(key).toLowerCase() === "token" || SENSITIVE_FIELD_PATTERN.test(key);
}

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

function redactString(value) {
  return String(value).replace(
    /(password|token|secret|license|key)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi,
    "$1=[REDACTED]"
  );
}

function compactString(value, maxLength = 4000) {
  const text = redactString(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}... [truncated]` : text;
}

function escapeHtml(value) {
  const element = document.createElement("div");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

function serializeRuntimeValue(value, seen = new WeakSet()) {
  if (value instanceof Error) {
    return redact({
      name: value.name,
      message: compactString(value.message),
      stack: compactString(value.stack ?? "")
    });
  }

  if (value instanceof Event) {
    return redact({
      type: value.type,
      message: compactString(value.message ?? ""),
      target: value.target?.constructor?.name ?? null
    });
  }

  if (value === null || value === undefined) return value;
  if (typeof value === "string") return compactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value !== "object") return compactString(String(value));

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  const summary = {
    type: value.constructor?.name ?? "Object"
  };
  if (value.id) summary.id = value.id;
  if (value.name) summary.name = value.name;
  if (value.message) summary.message = compactString(value.message);
  if (value.stack) summary.stack = compactString(value.stack);

  const output = { ...summary };
  for (const [key, entry] of Object.entries(value).slice(0, 25)) {
    if (key in output) continue;
    output[key] = serializeRuntimeValue(entry, seen);
  }
  return redact(output);
}

function runtimeMessageFromValues(values = []) {
  return compactString(values.map((value) => {
    const serialized = serializeRuntimeValue(value);
    if (serialized && typeof serialized === "object") {
      return serialized.message || serialized.name || serialized.type || JSON.stringify(serialized);
    }
    return String(serialized ?? "");
  }).filter(Boolean).join(" "));
}

function recordTimelineEvent(type, details = {}) {
  const event = redact({
    id: ++timelineEventCounter,
    timestamp: new Date().toISOString(),
    type,
    ...details
  });
  timelineEvents.push(event);
  if (timelineEvents.length > MAX_TIMELINE_EVENTS) {
    timelineEvents = timelineEvents.slice(-MAX_TIMELINE_EVENTS);
  }
  return event;
}

function getRuntimeTimeline({ limit = 50, since = null, type = null } = {}) {
  const max = boundedLimit(limit, 50, MAX_TIMELINE_EVENTS);
  const minTime = since ? Date.parse(since) : null;
  let events = timelineEvents;
  if (type) events = events.filter((event) => event.type === type);
  if (Number.isFinite(minTime)) {
    events = events.filter((event) => Date.parse(event.timestamp) >= minTime);
  }
  return events.slice(-max);
}

function recordRuntimeEvent(level, source, details = {}) {
  const args = Array.isArray(details.args) ? details.args : [];
  const message = details.message ?? runtimeMessageFromValues(args);
  const event = redact({
    id: ++runtimeEventCounter,
    timestamp: new Date().toISOString(),
    level,
    source,
    method: details.method,
    message: compactString(message),
    stack: details.stack ? compactString(details.stack) : undefined,
    args: args.length ? args.map((value) => serializeRuntimeValue(value)) : undefined
  });

  runtimeEvents.push(event);
  if (runtimeEvents.length > MAX_RUNTIME_EVENTS) {
    runtimeEvents = runtimeEvents.slice(-MAX_RUNTIME_EVENTS);
  }
  recordTimelineEvent("runtime", {
    runtimeEventId: event.id,
    level: event.level,
    source: event.source,
    method: event.method,
    message: event.message
  });
  return event;
}

function getRuntimeEvents({ limit = 50, level = null, source = null, since = null } = {}) {
  const max = Math.min(Math.max(Number(limit) || 50, 1), MAX_RUNTIME_EVENTS);
  const minTime = since ? Date.parse(since) : null;
  let events = runtimeEvents;
  if (level) events = events.filter((event) => event.level === level);
  if (source) events = events.filter((event) => event.source === source);
  if (Number.isFinite(minTime)) {
    events = events.filter((event) => Date.parse(event.timestamp) >= minTime);
  }
  return events.slice(-max);
}

function clearRuntimeEvents() {
  const cleared = runtimeEvents.length;
  runtimeEvents = [];
  return { cleared };
}

function runtimeEventSummary() {
  const errors = runtimeEvents.filter((event) => event.level === "error");
  const warnings = runtimeEvents.filter((event) => event.level === "warn");
  return {
    stored: runtimeEvents.length,
    maxStored: MAX_RUNTIME_EVENTS,
    errors: errors.length,
    warnings: warnings.length,
    recentProblems: runtimeEvents
      .filter((event) => event.level === "error" || event.level === "warn")
      .slice(-5)
      .map((event) => ({
        id: event.id,
        timestamp: event.timestamp,
        level: event.level,
        source: event.source,
        message: event.message
      }))
  };
}

function patchConsoleCapture() {
  if (globalThis[CONSOLE_PATCH_FLAG]) return;
  for (const method of ["error", "warn"]) {
    const original = console[method]?.bind(console);
    if (!original) continue;
    console[method] = (...args) => {
      try {
        recordRuntimeEvent(method === "error" ? "error" : "warn", `console.${method}`, { args });
      } catch {
        // Never let diagnostics change Foundry behavior.
      }
      return original(...args);
    };
  }
  globalThis[CONSOLE_PATCH_FLAG] = true;
}

function patchNotificationCapture() {
  const notifications = globalThis.ui?.notifications;
  if (!notifications || notifications[NOTIFICATION_PATCH_FLAG]) return;

  for (const method of ["error", "warn", "info", "notify"]) {
    const original = notifications[method]?.bind(notifications);
    if (!original) continue;
    notifications[method] = (...args) => {
      try {
        const level = method === "error" ? "error" : method === "warn" ? "warn" : "info";
        recordRuntimeEvent(level, `ui.notifications.${method}`, { args });
      } catch {
        // Never let diagnostics change Foundry behavior.
      }
      return original(...args);
    };
  }

  notifications[NOTIFICATION_PATCH_FLAG] = true;
}

function installRuntimeCapture() {
  const firstInstall = !globalThis[RUNTIME_CAPTURE_FLAG];
  if (firstInstall) {
    patchConsoleCapture();
    window.addEventListener("error", (event) => {
      recordRuntimeEvent("error", "window.error", {
        message: event.message,
        stack: event.error?.stack,
        args: [event.error ?? event]
      });
    });
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      recordRuntimeEvent("error", "window.unhandledrejection", {
        message: reason?.message ?? String(reason),
        stack: reason?.stack,
        args: [reason]
      });
    });
    globalThis[RUNTIME_CAPTURE_FLAG] = true;
  }
  patchNotificationCapture();
  return {
    installed: true,
    firstInstall,
    consoleCapture: Boolean(globalThis[CONSOLE_PATCH_FLAG]),
    notificationCapture: Boolean(globalThis.ui?.notifications?.[NOTIFICATION_PATCH_FLAG])
  };
}

function compactDocumentReference(document) {
  if (!document) return null;
  return redact({
    id: document.id ?? document._id ?? null,
    uuid: document.uuid ?? null,
    name: document.name ?? document.title ?? null,
    type: document.type ?? document.documentName ?? document.constructor?.name ?? null
  });
}

function installTimelineHooks() {
  if (globalThis[TIMELINE_HOOK_FLAG]) return { installed: true, firstInstall: false };
  const safeHook = (hookName, handler) => {
    Hooks.on(hookName, (...args) => {
      try {
        handler(...args);
      } catch {
        // Timeline capture is observational only.
      }
    });
  };

  safeHook("canvasReady", (canvasInstance) => {
    const scene = canvasInstance?.scene ?? canvas?.scene;
    recordTimelineEvent("scene", {
      action: "canvasReady",
      scene: compactDocumentReference(scene)
    });
  });
  safeHook("createChatMessage", (message) => {
    recordTimelineEvent("chat", {
      action: "create",
      message: compactDocumentReference(message),
      speaker: message.speaker?.alias ?? null,
      whisperCount: Array.isArray(message.whisper) ? message.whisper.length : 0,
      blind: message.blind === true
    });
  });
  safeHook("createCombat", (combat) => {
    recordTimelineEvent("combat", { action: "create", combat: compactDocumentReference(combat) });
  });
  safeHook("updateCombat", (combat, changes) => {
    recordTimelineEvent("combat", {
      action: "update",
      combat: compactDocumentReference(combat),
      changedKeys: Object.keys(changes ?? {}).sort()
    });
  });
  safeHook("deleteCombat", (combat) => {
    recordTimelineEvent("combat", { action: "delete", combat: compactDocumentReference(combat) });
  });
  safeHook("userConnected", (user, connected) => {
    recordTimelineEvent("user", {
      action: connected ? "connected" : "disconnected",
      user: user ? { id: user.id, name: user.name, role: user.role, isGM: user.isGM } : null
    });
  });

  globalThis[TIMELINE_HOOK_FLAG] = true;
  recordTimelineEvent("bridge", {
    action: "timeline-hooks-ready",
    world: { id: game.world?.id, title: game.world?.title },
    user: game.user ? { id: game.user.id, name: game.user.name, role: game.user.role, isGM: game.user.isGM } : null
  });
  return { installed: true, firstInstall: true };
}

function toPlainDocument(document, { includeEmbedded = false } = {}) {
  if (!document) return null;
  const plain = redact(document.toObject ? document.toObject() : foundry.utils.deepClone(document));
  if (includeEmbedded && document instanceof Scene) {
    plain.tokens = document.tokens?.map((token) => redact(token.toObject())) ?? [];
    plain.drawings = document.drawings?.map((drawing) => redact(drawing.toObject())) ?? [];
    plain.walls = document.walls?.map((wall) => redact(wall.toObject())) ?? [];
    plain.lights = document.lights?.map((light) => redact(light.toObject())) ?? [];
    plain.sounds = document.sounds?.map((sound) => redact(sound.toObject())) ?? [];
    plain.templates = document.templates?.map((template) => redact(template.toObject())) ?? [];
    plain.tiles = document.tiles?.map((tile) => redact(tile.toObject())) ?? [];
    plain.notes = document.notes?.map((note) => redact(note.toObject())) ?? [];
  }
  return plain;
}

function collectionEntries() {
  const entries = [];
  for (const [key, collection] of iterCollections()) {
    entries.push({
      key,
      documentName: collection.documentName,
      size: collection.size,
      label: collection.constructor?.name
    });
  }
  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

function collectionKey(collection) {
  return collection.collectionName
    ?? collection.metadata?.collection
    ?? COLLECTION_KEYS_BY_DOCUMENT_NAME[collection.documentName]
    ?? (collection.documentName ? `${collection.documentName.toLowerCase()}s` : null)
    ?? collection.constructor?.name
    ?? "unknown";
}

function iterCollections() {
  const candidates = [];
  const addCandidate = (key, collection) => {
    if (!collection?.documentName) return;
    if (candidates.some(([, existing]) => existing === collection)) return;
    candidates.push([key ?? collectionKey(collection), collection]);
  };

  if (game.collections?.entries) {
    for (const entry of game.collections.entries()) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && entry[1]?.documentName) {
        addCandidate(collectionKey(entry[1]), entry[1]);
      }
    }
  }

  if (!candidates.length && game.collections) {
    for (const collection of game.collections) {
      addCandidate(collectionKey(collection), collection);
    }
  }

  for (const collection of [
    game.actors,
    game.items,
    game.journal,
    game.scenes,
    game.tables,
    game.playlists,
    game.messages,
    game.macros,
    game.users,
    game.folders,
    game.cards,
    game.combats
  ]) {
    addCandidate(collectionKey(collection), collection);
  }

  return candidates;
}

function getCollection(collectionName) {
  if (!collectionName) throw new Error("collection is required");
  const normalized = String(collectionName).toLowerCase();
  for (const [key, collection] of iterCollections()) {
    if (
      key.toLowerCase() === normalized ||
      collection.documentName?.toLowerCase() === normalized ||
      `${collection.documentName}s`.toLowerCase() === normalized
    ) {
      return collection;
    }
  }
  throw new Error(`Unknown Foundry collection: ${collectionName}`);
}

function getDocumentClass(documentName) {
  if (!documentName) throw new Error("documentName is required");
  const cls = CONFIG[documentName]?.documentClass ?? CONFIG[`${documentName}s`]?.documentClass;
  if (!cls) throw new Error(`Unknown Foundry document type: ${documentName}`);
  return cls;
}

function getDocument(collectionName, documentId) {
  const collection = getCollection(collectionName);
  const document = collection.get(documentId) ?? collection.getName(documentId);
  if (!document) throw new Error(`No document found in ${collectionName}: ${documentId}`);
  return document;
}

function boundedLimit(value, fallback = 25, max = 100) {
  return Math.min(Math.max(Number(value) || fallback, 1), max);
}

function stripHtml(value) {
  const text = String(value ?? "");
  if (!text) return "";
  return compactString(
    text
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim(),
    1200
  );
}

function packLabel(pack) {
  return pack.metadata?.label ?? pack.title ?? pack.collection;
}

function packSummary(pack) {
  return {
    collection: pack.collection,
    documentName: pack.documentName,
    label: packLabel(pack),
    packageName: pack.metadata?.packageName ?? null,
    packageType: pack.metadata?.packageType ?? null,
    locked: pack.locked === true,
    indexed: Boolean(pack.index?.size),
    indexSize: pack.index?.size ?? 0
  };
}

function getPack(packId) {
  const normalized = String(packId ?? "").toLowerCase();
  if (!normalized) throw new Error("pack is required");
  const pack = game.packs.get(packId)
    ?? Array.from(game.packs.values()).find((candidate) => {
      return candidate.collection?.toLowerCase() === normalized
        || packLabel(candidate)?.toLowerCase() === normalized
        || candidate.metadata?.name?.toLowerCase() === normalized;
    });
  if (!pack) throw new Error(`Compendium pack not found: ${packId}`);
  return pack;
}

function listCompendiumPacks(args = {}) {
  const packageName = args.packageName ? String(args.packageName).toLowerCase() : null;
  const documentName = args.documentName ? String(args.documentName).toLowerCase() : null;
  const query = args.query ? String(args.query).toLowerCase() : null;
  const limit = boundedLimit(args.limit, 100, 250);
  const packs = [];

  for (const pack of game.packs.values()) {
    const summary = packSummary(pack);
    const haystack = JSON.stringify(summary).toLowerCase();
    if (packageName && String(summary.packageName ?? "").toLowerCase() !== packageName) continue;
    if (documentName && String(summary.documentName ?? "").toLowerCase() !== documentName) continue;
    if (query && !haystack.includes(query)) continue;
    packs.push(summary);
    if (packs.length >= limit) break;
  }

  return packs.sort((a, b) => a.collection.localeCompare(b.collection));
}

function requestedIndexFields(args = {}) {
  const fields = Array.isArray(args.fields) ? args.fields.filter((field) => typeof field === "string") : [];
  const defaults = ["type", "img", "system.description.value", "system.level", "system.school", "system.cr", "system.details.cr"];
  return [...new Set([...defaults, ...fields])];
}

async function searchCompendium(args = {}) {
  const query = String(args.query ?? "").toLowerCase();
  const documentName = args.documentName ? String(args.documentName).toLowerCase() : null;
  const type = args.type ? String(args.type).toLowerCase() : null;
  const limit = boundedLimit(args.limit, 25, 100);
  const packs = args.pack ? [getPack(args.pack)] : Array.from(game.packs.values());
  const results = [];

  for (const pack of packs) {
    if (documentName && String(pack.documentName ?? "").toLowerCase() !== documentName) continue;
    const index = await pack.getIndex({ fields: requestedIndexFields(args) });
    const entries = Array.from(index.values ? index.values() : index);
    for (const entry of entries) {
      if (type && String(entry.type ?? "").toLowerCase() !== type) continue;
      const haystack = JSON.stringify({
        id: entry._id,
        name: entry.name,
        type: entry.type,
        img: entry.img,
        system: entry.system
      }).toLowerCase();
      if (query && !haystack.includes(query)) continue;
      results.push({
        pack: pack.collection,
        packLabel: packLabel(pack),
        documentName: pack.documentName,
        id: entry._id,
        name: entry.name,
        type: entry.type ?? null,
        img: entry.img ?? null
      });
      if (results.length >= limit) return results;
    }
  }

  return results;
}

async function getCompendiumDocument(args = {}) {
  const pack = getPack(args.pack);
  const idOrName = String(args.id ?? "");
  let entryId = idOrName;
  let document = null;

  try {
    document = await pack.getDocument(entryId);
  } catch {
    document = null;
  }

  if (!document) {
    const index = await pack.getIndex();
    const entries = Array.from(index.values ? index.values() : index);
    const entry = entries.find((item) => item._id === idOrName || item.name === idOrName);
    if (entry) {
      entryId = entry._id;
      document = await pack.getDocument(entryId);
    }
  }

  if (!document) throw new Error(`No document found in ${pack.collection}: ${idOrName}`);
  if (args.summarize === true) return summarizeDocument(document, { pack: pack.collection });
  return toPlainDocument(document, { includeEmbedded: document instanceof Scene });
}

function itemDescription(item) {
  return stripHtml(item.system?.description?.value ?? item.system?.description ?? item.description ?? "");
}

function summarizeItem(item) {
  const source = item.toObject ? item.toObject() : item;
  return redact({
    id: source._id ?? item.id,
    name: source.name ?? item.name,
    type: source.type ?? item.type,
    img: source.img ?? item.img,
    quantity: source.system?.quantity,
    weight: source.system?.weight,
    price: source.system?.price,
    description: itemDescription(source)
  });
}

function classSummary(actor) {
  const classes = actor.system?.details?.classes ?? {};
  return Object.entries(classes).map(([key, value]) => ({
    key,
    name: value?.name ?? key,
    level: value?.level ?? null,
    hd: value?.hd ?? null,
    bab: value?.bab ?? null
  }));
}

function summarizeActorDocument(actor, { includeItems = false, itemLimit = 20, pack = null } = {}) {
  const items = actor.items ? Array.from(actor.items.values()) : [];
  const limit = boundedLimit(itemLimit, 20, 100);
  return redact({
    pack,
    id: actor.id,
    uuid: actor.uuid,
    name: actor.name,
    type: actor.type,
    img: actor.img,
    hp: actor.system?.attributes?.hp ?? null,
    ac: actor.system?.attributes?.ac ?? null,
    abilities: actor.system?.abilities ?? null,
    saves: actor.system?.attributes?.savingThrows ?? actor.system?.attributes?.saves ?? null,
    classes: classSummary(actor),
    itemCount: items.length,
    items: includeItems ? items.slice(0, limit).map(summarizeItem) : undefined
  });
}

function summarizeSceneDocument(scene, { includeTokens = false, tokenLimit = 50, pack = null } = {}) {
  const tokens = scene.tokens ? Array.from(scene.tokens.values()) : [];
  const limit = boundedLimit(tokenLimit, 50, 200);
  return redact({
    pack,
    id: scene.id,
    uuid: scene.uuid,
    name: scene.name,
    active: scene.active,
    navigation: scene.navigation,
    dimensions: scene.dimensions,
    grid: scene.grid,
    background: scene.background?.src ?? scene.img ?? null,
    counts: {
      tokens: tokens.length,
      walls: scene.walls?.size ?? 0,
      lights: scene.lights?.size ?? 0,
      sounds: scene.sounds?.size ?? 0,
      tiles: scene.tiles?.size ?? 0,
      drawings: scene.drawings?.size ?? 0,
      notes: scene.notes?.size ?? 0
    },
    tokens: includeTokens
      ? tokens.slice(0, limit).map((token) => ({
          id: token.id,
          name: token.name,
          actorId: token.actorId,
          actorName: token.actor?.name ?? null,
          hidden: token.hidden,
          x: token.x,
          y: token.y,
          elevation: token.elevation,
          disposition: token.disposition
        }))
      : undefined
  });
}

function summarizeDocument(document, options = {}) {
  if (document instanceof Actor) return summarizeActorDocument(document, options);
  if (document instanceof Scene) return summarizeSceneDocument(document, options);
  if (document instanceof Item) return summarizeItem(document);
  const plain = toPlainDocument(document);
  return {
    pack: options.pack ?? null,
    id: plain?._id ?? document.id,
    name: plain?.name ?? plain?.title ?? document.name,
    type: plain?.type ?? document.documentName,
    img: plain?.img ?? null,
    description: stripHtml(plain?.system?.description?.value ?? plain?.content ?? "")
  };
}

function folderNameForDocument(document) {
  if (!document?.folder) return null;
  if (typeof document.folder === "string") return game.folders?.get(document.folder)?.name ?? document.folder;
  return document.folder.name ?? document.folder.id ?? null;
}

function documentSearchFields(document) {
  const plain = document.toObject ? document.toObject() : document;
  return redact({
    id: document.id ?? plain._id,
    uuid: document.uuid ?? null,
    name: document.name ?? plain.name ?? plain.title,
    type: plain.type ?? document.type ?? document.documentName,
    documentName: document.documentName,
    folder: folderNameForDocument(document),
    img: plain.img ?? document.img ?? null,
    description: stripHtml(plain.system?.description?.value ?? plain.content ?? plain.description ?? "")
  });
}

function summarizeDocumentForSearch(document, collectionKeyValue, matchedFields = []) {
  const fields = documentSearchFields(document);
  return redact({
    collection: collectionKeyValue,
    documentName: fields.documentName,
    id: fields.id,
    uuid: fields.uuid,
    name: fields.name,
    type: fields.type,
    folder: fields.folder,
    img: fields.img,
    matchedFields
  });
}

function sampleCollection(collectionKeyValue, collection, limit) {
  return Array.from(collection.values ? collection.values() : collection)
    .slice(0, limit)
    .map((document) => summarizeDocumentForSearch(document, collectionKeyValue));
}

function summarizeWorldIndex(args = {}) {
  const includeSamples = args.includeSamples === true;
  const sampleLimit = boundedLimit(args.sampleLimit, 3, 10);
  const collections = collectionEntries();
  const samples = {};

  if (includeSamples) {
    for (const [key, collection] of iterCollections()) {
      samples[key] = sampleCollection(key, collection, sampleLimit);
    }
  }

  const packs = Array.from(game.packs.values()).map(packSummary);
  const activeScene = canvas?.scene ?? game.scenes?.active ?? null;

  return redact({
    world: { id: game.world.id, title: game.world.title },
    system: { id: game.system.id, title: game.system.title, version: game.system.version },
    foundry: { version: game.version, release: game.release },
    activeScene: activeScene ? summarizeSceneDocument(activeScene, { includeTokens: false }) : null,
    collections,
    users: game.users.map((user) => ({
      id: user.id,
      name: user.name,
      role: user.role,
      active: user.active,
      isGM: user.isGM,
      character: user.character?.id ?? user.character ?? null
    })),
    compendiumPacks: {
      count: packs.length,
      byDocumentName: packs.reduce((acc, pack) => {
        const key = pack.documentName ?? "unknown";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
      samples: packs.slice(0, sampleLimit)
    },
    runtime: {
      events: runtimeEventSummary(),
      timelineStored: timelineEvents.length,
      timelineMaxStored: MAX_TIMELINE_EVENTS
    },
    samples: includeSamples ? samples : undefined
  });
}

function searchWorld(args = {}) {
  const query = String(args.query ?? "").trim().toLowerCase();
  if (!query) throw new Error("search_world requires a non-empty query.");
  const limit = boundedLimit(args.limit, 25, 100);
  const requestedCollections = Array.isArray(args.collections)
    ? new Set(args.collections.map((entry) => String(entry).toLowerCase()))
    : null;
  const results = [];

  for (const [key, collection] of iterCollections()) {
    const collectionDocumentName = String(collection.documentName ?? "").toLowerCase();
    if (requestedCollections && !requestedCollections.has(key.toLowerCase()) && !requestedCollections.has(collectionDocumentName)) continue;

    for (const document of collection.values()) {
      const fields = documentSearchFields(document);
      const matchedFields = [];
      for (const [field, value] of Object.entries(fields)) {
        if (value == null) continue;
        const text = typeof value === "string" ? value : JSON.stringify(value);
        if (text.toLowerCase().includes(query)) matchedFields.push(field);
      }
      if (!matchedFields.length) continue;
      results.push(summarizeDocumentForSearch(document, key, matchedFields));
      if (results.length >= limit) return results;
    }
  }

  return results;
}

function sceneDocumentArray(scene, key) {
  const collection = scene?.[key];
  if (!collection) return [];
  if (collection.values) return Array.from(collection.values());
  if (Array.isArray(collection)) return collection;
  return [];
}

function tokenAuditSummary(token) {
  const actor = token.actor ?? (token.actorId ? game.actors.get(token.actorId) : null);
  const issues = [];
  const image = token.texture?.src ?? token.img ?? null;
  if (!image) issues.push("missing-token-image");
  if (!token.actorId) issues.push("unlinked-token");
  if (token.actorId && !actor) issues.push("missing-linked-actor");
  if (token.hidden) issues.push("hidden-token");
  return redact({
    id: token.id,
    name: token.name,
    actorId: token.actorId ?? null,
    actorName: actor?.name ?? null,
    img: image,
    hidden: token.hidden === true,
    x: token.x,
    y: token.y,
    elevation: token.elevation,
    disposition: token.disposition,
    issues
  });
}

function auditSceneReadiness(args = {}) {
  const scene = args.id ? game.scenes.get(args.id) : canvas?.scene;
  if (!scene) throw new Error("Scene not found");
  const tokens = sceneDocumentArray(scene, "tokens");
  const tokenSummaries = tokens.map(tokenAuditSummary);
  const issues = [];
  const background = scene.background?.src ?? scene.img ?? null;
  if (!background) issues.push({ level: "warn", code: "missing-background", message: "Scene has no background image." });
  if (!scene.grid) issues.push({ level: "warn", code: "missing-grid", message: "Scene grid metadata is missing." });
  for (const token of tokenSummaries) {
    for (const issue of token.issues) {
      issues.push({ level: issue === "hidden-token" ? "info" : "warn", code: issue, tokenId: token.id, tokenName: token.name });
    }
  }

  const limit = boundedLimit(args.tokenLimit, 25, 200);
  return redact({
    scene: summarizeSceneDocument(scene, { includeTokens: false }),
    ready: !issues.some((issue) => issue.level === "error" || issue.level === "warn"),
    issues,
    counts: {
      tokens: tokens.length,
      walls: sceneDocumentArray(scene, "walls").length,
      lights: sceneDocumentArray(scene, "lights").length,
      sounds: sceneDocumentArray(scene, "sounds").length,
      tiles: sceneDocumentArray(scene, "tiles").length,
      drawings: sceneDocumentArray(scene, "drawings").length,
      notes: sceneDocumentArray(scene, "notes").length
    },
    grid: scene.grid,
    background,
    tokens: args.includeTokens === true ? tokenSummaries.slice(0, limit) : undefined
  });
}

function resolveActorForAudit(id) {
  if (id) return getDocument("actors", id);
  if (game.user?.character) return game.user.character;
  const actors = Array.from(game.actors.values());
  if (actors.length === 1) return actors[0];
  throw new Error("audit_actor_readiness requires id when there is no current user character or single world actor.");
}

function actorTokenLinks(actor) {
  const links = [];
  for (const scene of game.scenes.values()) {
    for (const token of sceneDocumentArray(scene, "tokens")) {
      if (token.actorId !== actor.id) continue;
      links.push({
        sceneId: scene.id,
        sceneName: scene.name,
        tokenId: token.id,
        tokenName: token.name,
        hidden: token.hidden === true
      });
    }
  }
  return links;
}

function ownershipSummary(document) {
  const ownership = document.ownership ?? {};
  return Object.entries(ownership).map(([userId, level]) => ({
    userId,
    userName: userId === "default" ? "default" : game.users.get(userId)?.name ?? null,
    level
  }));
}

function auditActorReadiness(args = {}) {
  const actor = resolveActorForAudit(args.id);
  const items = actor.items ? Array.from(actor.items.values()) : [];
  const links = actorTokenLinks(actor);
  const issues = [];
  if (!actor.img) issues.push({ level: "warn", code: "missing-actor-image", message: "Actor has no image." });
  if (!links.length) issues.push({ level: "info", code: "no-scene-token", message: "Actor is not currently linked to a scene token." });
  if (!items.length) issues.push({ level: "info", code: "empty-inventory", message: "Actor has no embedded items." });

  const itemIssues = [];
  for (const item of items) {
    const itemIssueCodes = [];
    if (!item.img) itemIssueCodes.push("missing-item-image");
    if (!item.system) itemIssueCodes.push("missing-item-system");
    if (!item.name) itemIssueCodes.push("missing-item-name");
    if (itemIssueCodes.length) {
      itemIssues.push({
        id: item.id,
        name: item.name,
        type: item.type,
        issues: itemIssueCodes
      });
    }
  }
  if (itemIssues.length) issues.push({ level: "warn", code: "embedded-item-gaps", count: itemIssues.length });

  const d35eSummary = {
    hasHp: actor.system?.attributes?.hp != null,
    hasAc: actor.system?.attributes?.ac != null,
    hasAbilities: actor.system?.abilities != null,
    classCount: classSummary(actor).length
  };
  if (!d35eSummary.hasHp || !d35eSummary.hasAc || !d35eSummary.hasAbilities) {
    issues.push({ level: "warn", code: "incomplete-d35e-summary", d35eSummary });
  }

  const limit = boundedLimit(args.itemLimit, 20, 100);
  return redact({
    actor: summarizeActorDocument(actor, {
      includeItems: args.includeItems === true,
      itemLimit: limit
    }),
    ready: !issues.some((issue) => issue.level === "error" || issue.level === "warn"),
    issues,
    ownership: ownershipSummary(actor),
    tokenLinks: links,
    itemIssues: itemIssues.slice(0, limit),
    d35eSummary
  });
}

function canonicalizeForHash(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalizeForHash).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeForHash(value[key])}`).join(",")}}`;
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function bridgePlanHash(plan) {
  const planForHash = { ...plan };
  delete planForHash.planHash;
  return sha256Hex(canonicalizeForHash(planForHash));
}

function journalEntriesByName(name) {
  const normalized = String(name ?? "").trim().toLowerCase();
  if (!normalized) return [];
  return Array.from(game.journal.values()).filter((entry) => entry.name?.toLowerCase() === normalized);
}

function resolveJournalEntryForPlan(args) {
  if (args.journalId) {
    const entry = game.journal.get(args.journalId);
    if (!entry) throw new Error(`JournalEntry not found: ${args.journalId}`);
    return entry;
  }
  if (args.journalName) {
    const matches = journalEntriesByName(args.journalName);
    if (matches.length > 1) throw new Error(`JournalEntry name is ambiguous: ${args.journalName}`);
    if (!matches.length) throw new Error(`JournalEntry not found: ${args.journalName}`);
    return matches[0];
  }
  throw new Error("journalId or journalName is required.");
}

function resolveJournalPageForPlan(entry, args) {
  if (args.pageId) {
    const page = entry.pages?.get(args.pageId);
    if (!page) throw new Error(`JournalEntryPage not found: ${args.pageId}`);
    return page;
  }
  if (args.pageName) {
    const normalized = String(args.pageName).trim().toLowerCase();
    const matches = Array.from(entry.pages?.values() ?? []).filter((page) => page.name?.toLowerCase() === normalized);
    if (matches.length > 1) throw new Error(`JournalEntryPage name is ambiguous: ${args.pageName}`);
    if (!matches.length) throw new Error(`JournalEntryPage not found: ${args.pageName}`);
    return matches[0];
  }
  throw new Error("pageId or pageName is required.");
}

function assertTextPageType(pageType = "text") {
  const normalized = String(pageType || "text").toLowerCase();
  if (normalized !== "text") throw new Error(`Only text journal pages are supported in this slice: ${pageType}`);
  return "text";
}

function journalTextData(content) {
  return {
    content: String(content ?? ""),
    format: CONST.JOURNAL_ENTRY_PAGE_FORMATS?.HTML ?? 1
  };
}

function journalPageData({ name, pageName, type, pageType, content }) {
  return {
    name: String(pageName ?? name ?? "Page").trim() || "Page",
    type: assertTextPageType(pageType ?? type ?? "text"),
    text: journalTextData(content)
  };
}

function journalPageContent(page) {
  return page?.text?.content ?? page?.system?.text?.content ?? "";
}

function journalPagePreview(pageOrData) {
  const content = journalPageContent(pageOrData) || pageOrData?.text?.content || "";
  return redact({
    id: pageOrData?.id ?? pageOrData?._id ?? null,
    name: pageOrData?.name ?? null,
    type: pageOrData?.type ?? "text",
    contentLength: String(content ?? "").length,
    textPreview: stripHtml(content)
  });
}

function journalEntryPreview(entryOrData) {
  const pages = entryOrData?.pages?.values
    ? Array.from(entryOrData.pages.values())
    : Array.isArray(entryOrData?.pages)
      ? entryOrData.pages
      : [];
  return redact({
    id: entryOrData?.id ?? entryOrData?._id ?? null,
    name: entryOrData?.name ?? null,
    folder: typeof entryOrData?.folder === "string"
      ? entryOrData.folder
      : entryOrData?.folder?.id ?? entryOrData?.folder ?? null,
    pageCount: pages.length,
    pages: pages.slice(0, 5).map(journalPagePreview)
  });
}

function operationPreview(operation) {
  return {
    before: operation.before ?? null,
    after: operation.after ?? null
  };
}

function makePlanOperation(opId, type, target, data, preview = {}, backupRequired = false) {
  return redact({
    opId,
    type,
    target,
    data,
    backupRequired,
    ...operationPreview(preview)
  });
}

function normalizedInitialPages(args) {
  const pages = Array.isArray(args.pages) ? args.pages : [];
  return pages.map((page, index) => journalPageData({
    name: page.name ?? page.pageName ?? `Page ${index + 1}`,
    type: page.type,
    pageType: page.pageType,
    content: page.content ?? ""
  }));
}

function assertPlanHasChanges(changes, message) {
  if (!Object.keys(changes).length) throw new Error(message);
  return changes;
}

async function finalizeBridgePlan(plan) {
  const partialHash = await bridgePlanHash(plan);
  plan.planId = `${plan.source}-${plan.worldId}-${partialHash.slice(0, 12)}`;
  plan.planHash = await bridgePlanHash(plan);
  return redact(plan);
}

async function planJournalChanges(args = {}) {
  const action = String(args.action ?? "").trim();
  if (!action) throw new Error("plan_journal_changes requires action.");
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + BRIDGE_PLAN_TTL_MS).toISOString();
  const operations = [];
  const warnings = [];
  const targets = {};

  if (action === "create_entry") {
    const name = String(args.entryName ?? args.journalName ?? "").trim();
    if (!name) throw new Error("create_entry requires entryName.");
    const pages = normalizedInitialPages(args);
    const data = {
      name,
      folder: args.folderId ?? null,
      pages
    };
    operations.push(makePlanOperation(
      "op1",
      "journal.create_entry",
      { documentName: "JournalEntry", name },
      data,
      { before: null, after: journalEntryPreview(data) },
      false
    ));
    targets.entryName = name;
  } else if (action === "update_entry") {
    const entry = resolveJournalEntryForPlan(args);
    const data = {};
    if (args.entryName != null) data.name = String(args.entryName).trim();
    if (args.folderId != null) data.folder = args.folderId || null;
    assertPlanHasChanges(data, "update_entry requires entryName or folderId.");
    operations.push(makePlanOperation(
      "op1",
      "journal.update_entry",
      { documentName: "JournalEntry", journalId: entry.id, journalName: entry.name },
      data,
      {
        before: journalEntryPreview(entry),
        after: journalEntryPreview({
          id: entry.id,
          name: data.name ?? entry.name,
          folder: data.folder ?? entry.folder?.id ?? null,
          pages: Array.from(entry.pages?.values() ?? [])
        })
      },
      true
    ));
    targets.journalId = entry.id;
    targets.journalName = entry.name;
  } else if (action === "create_page") {
    const entry = resolveJournalEntryForPlan(args);
    const data = journalPageData({
      pageName: args.pageName,
      pageType: args.pageType,
      content: args.content ?? ""
    });
    operations.push(makePlanOperation(
      "op1",
      "journal.create_page",
      { documentName: "JournalEntryPage", journalId: entry.id, journalName: entry.name },
      data,
      { before: null, after: journalPagePreview(data) },
      false
    ));
    targets.journalId = entry.id;
    targets.journalName = entry.name;
  } else if (action === "update_page") {
    const entry = resolveJournalEntryForPlan(args);
    const page = resolveJournalPageForPlan(entry, args);
    const data = {};
    if (args.pageName != null) data.name = String(args.pageName).trim();
    if (args.pageType != null) data.type = assertTextPageType(args.pageType);
    if (args.content != null) data.text = journalTextData(args.content);
    assertPlanHasChanges(data, "update_page requires pageName, pageType, or content.");
    operations.push(makePlanOperation(
      "op1",
      "journal.update_page",
      { documentName: "JournalEntryPage", journalId: entry.id, journalName: entry.name, pageId: page.id, pageName: page.name },
      data,
      {
        before: journalPagePreview(page),
        after: journalPagePreview({
          id: page.id,
          name: data.name ?? page.name,
          type: data.type ?? page.type,
          text: data.text ?? page.text
        })
      },
      true
    ));
    targets.journalId = entry.id;
    targets.journalName = entry.name;
    targets.pageId = page.id;
    targets.pageName = page.name;
  } else if (action === "append_page_section") {
    const entry = resolveJournalEntryForPlan(args);
    const page = resolveJournalPageForPlan(entry, args);
    const content = String(args.content ?? "");
    if (!content.trim()) throw new Error("append_page_section requires non-empty content.");
    assertTextPageType(page.type);
    const existing = journalPageContent(page);
    const separator = existing.trim() ? "\n\n" : "";
    const appended = `${existing}${separator}${content}`;
    const data = { text: journalTextData(appended) };
    operations.push(makePlanOperation(
      "op1",
      "journal.update_page",
      { documentName: "JournalEntryPage", journalId: entry.id, journalName: entry.name, pageId: page.id, pageName: page.name },
      data,
      {
        before: journalPagePreview(page),
        after: journalPagePreview({ id: page.id, name: page.name, type: page.type, text: data.text })
      },
      true
    ));
    targets.journalId = entry.id;
    targets.journalName = entry.name;
    targets.pageId = page.id;
    targets.pageName = page.name;
  } else {
    throw new Error(`Unsupported journal plan action: ${action}`);
  }

  const requiresBackup = operations.some((operation) => operation.backupRequired === true);
  return finalizeBridgePlan({
    kind: "bridge-plan",
    source: "plan_journal_changes",
    version: 1,
    planId: null,
    worldId: game.world.id,
    createdAt,
    expiresAt,
    action,
    summary: `${action} (${operations.length} journal operation${operations.length === 1 ? "" : "s"})`,
    requiresBackup,
    operations,
    warnings,
    targets
  });
}

function assertBridgePlanConfirmation(plan, confirmation = {}) {
  if (!plan || typeof plan !== "object") throw new Error("apply_bridge_plan requires plan.");
  if (plan.kind !== "bridge-plan" || plan.source !== "plan_journal_changes") {
    throw new Error("apply_bridge_plan only accepts plans produced by plan_journal_changes.");
  }
  if (!Array.isArray(plan.operations) || !plan.operations.length) {
    throw new Error("apply_bridge_plan requires at least one operation.");
  }
  if (confirmation.planId !== plan.planId) throw new Error("apply_bridge_plan planId confirmation mismatch.");
  if (confirmation.planHash !== plan.planHash) throw new Error("apply_bridge_plan planHash confirmation mismatch.");
  if (confirmation.worldId !== plan.worldId) throw new Error("apply_bridge_plan worldId confirmation mismatch.");
  if (plan.worldId !== game.world.id) {
    throw new Error(`apply_bridge_plan world mismatch: plan=${plan.worldId}, active=${game.world.id}`);
  }
  if (!Number.isFinite(Date.parse(plan.expiresAt)) || Date.parse(plan.expiresAt) < Date.now()) {
    throw new Error("apply_bridge_plan plan has expired.");
  }
}

async function applyBridgePlan(args = {}) {
  const plan = args.plan;
  assertBridgePlanConfirmation(plan, args.confirmation ?? {});
  const expectedHash = await bridgePlanHash(plan);
  if (expectedHash !== plan.planHash) throw new Error("apply_bridge_plan planHash mismatch.");

  const results = [];
  for (const operation of plan.operations) {
    if (operation.type === "journal.create_entry") {
      const created = await JournalEntry.create(operation.data ?? {});
      results.push({ opId: operation.opId, type: operation.type, ok: true, document: journalEntryPreview(created) });
    } else if (operation.type === "journal.update_entry") {
      const entry = game.journal.get(operation.target?.journalId);
      if (!entry) throw new Error(`JournalEntry not found: ${operation.target?.journalId}`);
      const updated = await entry.update(operation.data ?? {});
      results.push({ opId: operation.opId, type: operation.type, ok: true, document: journalEntryPreview(updated) });
    } else if (operation.type === "journal.create_page") {
      const entry = game.journal.get(operation.target?.journalId);
      if (!entry) throw new Error(`JournalEntry not found: ${operation.target?.journalId}`);
      const created = await entry.createEmbeddedDocuments("JournalEntryPage", [operation.data ?? {}]);
      results.push({ opId: operation.opId, type: operation.type, ok: true, documents: created.map(journalPagePreview) });
    } else if (operation.type === "journal.update_page") {
      const entry = game.journal.get(operation.target?.journalId);
      if (!entry) throw new Error(`JournalEntry not found: ${operation.target?.journalId}`);
      const page = entry.pages?.get(operation.target?.pageId);
      if (!page) throw new Error(`JournalEntryPage not found: ${operation.target?.pageId}`);
      const updated = await page.update(operation.data ?? {});
      results.push({ opId: operation.opId, type: operation.type, ok: true, document: journalPagePreview(updated) });
    } else {
      throw new Error(`Unsupported bridge plan operation: ${operation.type}`);
    }
  }

  return redact({
    applied: true,
    planId: plan.planId,
    planHash: plan.planHash,
    worldId: plan.worldId,
    operationCount: results.length,
    results
  });
}

function safeEvalScript(source, context = {}) {
  const asyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return asyncFunction(
    "game",
    "canvas",
    "ui",
    "CONFIG",
    "foundry",
    "context",
    `"use strict";\n${source}`
  )(game, canvas, ui, CONFIG, foundry, context);
}

function socketStateName() {
  switch (socket?.readyState) {
    case WebSocket.CONNECTING:
      return "connecting";
    case WebSocket.OPEN:
      return "open";
    case WebSocket.CLOSING:
      return "closing";
    case WebSocket.CLOSED:
      return "closed";
    default:
      return "none";
  }
}

function bridgeDiagnostics() {
  const packageInfo = game.modules?.get(MODULE_ID);
  const enabled = game.settings.get(MODULE_ID, "enabled");
  const credential = game.settings.get(MODULE_ID, "bridgeToken");
  const url = game.settings.get(MODULE_ID, "bridgeUrl") || DEFAULT_URL;

  return {
    id: MODULE_ID,
    version: MODULE_VERSION,
    manifestVersion: packageInfo?.version ?? null,
    packageActive: packageInfo?.active === true,
    compatibility: packageInfo?.compatibility ?? null,
    gmOnly: true,
    authorization: authorizationStatus,
    enabled,
    credentialConfigured: Boolean(credential),
    urlConfigured: Boolean(url),
    socketState: socketStateName(),
    runtimeEvents: runtimeEventSummary(),
    runtimeTimeline: {
      stored: timelineEvents.length,
      maxStored: MAX_TIMELINE_EVENTS,
      recent: timelineEvents.slice(-5)
    }
  };
}

async function handleBridgeRequest(method, args = {}) {
  switch (method) {
    case "foundry_status":
      return {
        connected: true,
        gm: game.user?.isGM === true,
        user: game.user ? { id: game.user.id, name: game.user.name, role: game.user.role } : null,
        world: { id: game.world.id, title: game.world.title },
        system: { id: game.system.id, title: game.system.title, version: game.system.version },
        foundry: { version: game.version, release: game.release },
        bridge: bridgeDiagnostics(),
        activeScene: canvas?.scene ? { id: canvas.scene.id, name: canvas.scene.name } : null,
        modules: Array.from(game.modules.values()).map((module) => ({
          id: module.id,
          title: module.title,
          active: module.active,
          version: module.version
        }))
      };

    case "list_collections":
      return collectionEntries();

    case "get_document": {
      const document = getDocument(args.collection, args.id ?? args.name);
      return toPlainDocument(document, { includeEmbedded: args.includeEmbedded === true });
    }

    case "search_documents": {
      const collection = getCollection(args.collection);
      const query = String(args.query ?? "").toLowerCase();
      const limit = Number(args.limit ?? 50);
      const results = [];
      for (const document of collection.values()) {
        const plain = toPlainDocument(document);
        const haystack = JSON.stringify({
          id: plain._id,
          name: plain.name,
          title: plain.title,
          type: plain.type,
          system: plain.system,
          flags: plain.flags
        }).toLowerCase();
        if (!query || haystack.includes(query)) {
          results.push({
            id: plain._id,
            name: plain.name ?? plain.title,
            type: plain.type,
            folder: plain.folder
          });
        }
        if (results.length >= limit) break;
      }
      return results;
    }

    case "list_scenes":
      return game.scenes.map((scene) => ({
        id: scene.id,
        name: scene.name,
        active: scene.active,
        navigation: scene.navigation,
        dimensions: scene.dimensions,
        tokenCount: scene.tokens?.size ?? 0
      }));

    case "inspect_scene": {
      const scene = args.id ? game.scenes.get(args.id) : canvas?.scene;
      if (!scene) throw new Error("Scene not found");
      return toPlainDocument(scene, { includeEmbedded: true });
    }

    case "list_compendium_packs":
      return listCompendiumPacks(args);

    case "search_compendium":
      return searchCompendium(args);

    case "get_compendium_document":
      return getCompendiumDocument(args);

    case "summarize_actor": {
      const actor = getDocument("actors", args.id);
      return summarizeActorDocument(actor, {
        includeItems: args.includeItems === true,
        itemLimit: args.itemLimit
      });
    }

    case "summarize_scene": {
      const scene = args.id ? game.scenes.get(args.id) : canvas?.scene;
      if (!scene) throw new Error("Scene not found");
      return summarizeSceneDocument(scene, {
        includeTokens: args.includeTokens === true,
        tokenLimit: args.tokenLimit
      });
    }

    case "summarize_world_index":
      return summarizeWorldIndex(args);

    case "search_world":
      return searchWorld(args);

    case "audit_scene_readiness":
      return auditSceneReadiness(args);

    case "audit_actor_readiness":
      return auditActorReadiness(args);

    case "list_users":
      return game.users.map((user) => redact({
        id: user.id,
        name: user.name,
        role: user.role,
        active: user.active,
        isGM: user.isGM,
        character: user.character?.id ?? user.character
      }));

    case "read_settings": {
      const namespace = args.namespace ? String(args.namespace) : null;
      const settings = [];
      for (const [key, setting] of game.settings.settings) {
        if (namespace && !key.startsWith(`${namespace}.`)) continue;
        let value = "[UNREADABLE]";
        try {
          const dot = key.indexOf(".");
          const scope = key.slice(0, dot);
          const settingKey = key.slice(dot + 1);
          value = isSensitiveField(key) ? "[REDACTED]" : game.settings.get(scope, settingKey);
        } catch {
          value = "[UNREADABLE]";
        }
        settings.push(redact({
          key,
          scope: setting.scope,
          config: setting.config,
          type: setting.type?.name,
          value
        }));
      }
      return settings;
    }

    case "get_runtime_events":
      return getRuntimeEvents(args);

    case "get_runtime_timeline":
      return getRuntimeTimeline(args);

    case "clear_runtime_events":
      return clearRuntimeEvents();

    case "plan_journal_changes":
      return planJournalChanges(args);

    case "apply_bridge_plan":
      return applyBridgePlan(args);

    case "create_document": {
      const documentClass = getDocumentClass(args.documentName);
      const created = await documentClass.create(args.data ?? {});
      return toPlainDocument(created);
    }

    case "update_document": {
      const document = getDocument(args.collection, args.id);
      const updated = await document.update(args.data ?? {});
      return toPlainDocument(updated);
    }

    case "delete_document": {
      const document = getDocument(args.collection, args.id);
      const deleted = await document.delete();
      return { deleted: true, id: deleted.id, name: deleted.name };
    }

    case "create_embedded_document": {
      const parent = getDocument(args.parentCollection, args.parentId);
      const created = await parent.createEmbeddedDocuments(args.embeddedName, [args.data ?? {}]);
      return created.map((document) => toPlainDocument(document));
    }

    case "update_embedded_document": {
      const parent = getDocument(args.parentCollection, args.parentId);
      const updated = await parent.updateEmbeddedDocuments(args.embeddedName, [args.data ?? {}]);
      return updated.map((document) => toPlainDocument(document));
    }

    case "delete_embedded_document": {
      const parent = getDocument(args.parentCollection, args.parentId);
      const deleted = await parent.deleteEmbeddedDocuments(args.embeddedName, [args.embeddedId]);
      return deleted.map((document) => ({ id: document.id, deleted: true }));
    }

    case "create_chat_message": {
      const message = await ChatMessage.create({
        content: args.content ?? "",
        speaker: args.speaker ?? ChatMessage.getSpeaker(),
        whisper: args.whisper,
        blind: args.blind
      });
      return toPlainDocument(message);
    }

    case "run_macro": {
      const macro = game.macros.get(args.id) ?? game.macros.getName(args.name);
      if (!macro) throw new Error(`Macro not found: ${args.id ?? args.name}`);
      const result = await macro.execute(args.context ?? {});
      return redact(result ?? { executed: true });
    }

    case "run_gm_script": {
      if (args.dangerous !== true) {
        throw new Error("run_gm_script requires dangerous=true");
      }
      const result = await safeEvalScript(String(args.script ?? ""), args.context ?? {});
      const text = JSON.stringify(redact(result ?? null));
      if (text.length > MAX_RESULT_CHARS) {
        return {
          truncated: true,
          length: text.length,
          preview: text.slice(0, MAX_RESULT_CHARS)
        };
      }
      return redact(result ?? null);
    }

    default:
      throw new Error(`Unsupported bridge method: ${method}`);
  }
}

function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function handleLifecycleResponse(payload = {}) {
  const item = lifecyclePending.get(payload.id);
  if (!item) return;
  window.clearTimeout(item.timer);
  lifecyclePending.delete(payload.id);
  if (payload.ok) item.resolve(payload.result);
  else item.reject(new Error(payload.error || "Lifecycle credential request failed"));
}

function sendLifecycleRequest(type, args = {}) {
  if (!game.user?.isGM) throw new Error("Lifecycle setup is only available to GM users.");
  if (authorizationStatus.trusted !== true) {
    throw new Error("Authorize this world with Codex Foundry Bridge before storing lifecycle credentials.");
  }
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error("Codex Foundry Bridge daemon is not connected.");
  }

  const token = game.settings.get(MODULE_ID, "bridgeToken");
  const id = ++lifecycleRequestCounter;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      lifecyclePending.delete(id);
      reject(new Error("Timed out waiting for lifecycle credential response."));
    }, 30000);
    lifecyclePending.set(id, { resolve, reject, timer });
    send({
      type,
      id,
      token,
      args: {
        worldId: game.world.id,
        ...args
      }
    });
  });
}

function currentWorldPayload(token = game.settings.get(MODULE_ID, "bridgeToken")) {
  return {
    token,
    worldId: game.world.id,
    worldTitle: game.world.title,
    systemId: game.system.id,
    systemVersion: game.system.version,
    foundryVersion: game.version,
    user: { id: game.user.id, name: game.user.name, role: game.user.role, isGM: game.user.isGM }
  };
}

function sendHello(token) {
  send({
    type: "hello",
    ...currentWorldPayload(token)
  });
}

function authorizeCurrentWorld() {
  authorizationPromptDismissedForWorld = null;
  send({
    type: "authorizeWorld",
    ...currentWorldPayload()
  });
}

function revokeCurrentWorld() {
  authorizationPromptDismissedForWorld = game.world.id;
  send({
    type: "revokeWorld",
    ...currentWorldPayload()
  });
}

function gmUsers() {
  return Array.from(game.users ?? []).filter((user) => user?.isGM === true || Number(user?.role) >= 4);
}

function lifecycleWizardId() {
  return `${MODULE_ID}-lifecycle-setup`;
}

function closeLifecycleSetupWizard() {
  document.getElementById(lifecycleWizardId())?.remove();
}

function lifecycleStatusRows(status) {
  if (!status) return "";
  return [
    ["World", `${game.world.title} (${game.world.id})`],
    ["Lifecycle config", status.configPath],
    ["Visible app login", status.loginVisibleApp ? `enabled on CDP ${status.visibleCdpPort}` : "disabled"],
    ["Bridge GM client", `CDP ${status.bridgeCdpPort}`],
    ["Admin credential", status.admin.required ? `${status.admin.exists ? "stored" : "missing"} (${status.admin.target})` : "not required"],
    ["GM credential", status.gm.allowBlank ? "blank access key configured" : `${status.gm.exists ? "stored" : "missing"} (${status.gm.target})`]
  ].map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("");
}

function renderLifecycleSetupWizard(status = null, message = "", error = "") {
  closeLifecycleSetupWizard();
  const users = gmUsers();
  const selectedUser = status?.gm?.userId ?? game.user.id;
  const userOptions = users.map((user) => {
    const selected = user.id === selectedUser ? " selected" : "";
    return `<option value="${escapeHtml(user.id)}"${selected}>${escapeHtml(user.name)} (${escapeHtml(user.id)})</option>`;
  }).join("");
  const adminField = status?.admin?.required
    ? [
        "<label>",
        "<span>Foundry administrator password</span>",
        "<input type=\"password\" name=\"adminPassword\" autocomplete=\"off\" placeholder=\"Leave blank to keep stored credential\">",
        "</label>"
      ].join("")
    : "";
  const gmPasswordDisabled = status?.gm?.allowBlank ? " disabled" : "";
  const supported = status?.supported !== false;
  const content = [
    `<div class="${MODULE_ID}-overlay">`,
    `<form class="${MODULE_ID}-wizard">`,
    "<header>",
    "<h2>Codex Foundry Bridge Lifecycle Setup</h2>",
    `<button type="button" data-action="close" title="Close" aria-label="Close">x</button>`,
    "</header>",
    message ? `<p class="notice">${escapeHtml(message)}</p>` : "",
    error ? `<p class="error">${escapeHtml(error)}</p>` : "",
    !supported ? "<p class=\"error\">Windows Credential Manager storage is not available in this environment.</p>" : "",
    status ? `<dl>${lifecycleStatusRows(status)}</dl>` : "<p>Loading lifecycle status...</p>",
    "<label>",
    "<span>Game Master user</span>",
    `<select name="gmUserId">${userOptions}</select>`,
    "</label>",
    adminField,
    "<label>",
    "<span>World GM access key</span>",
    `<input type="password" name="gmPassword" autocomplete="off" placeholder="Leave blank to keep stored credential"${gmPasswordDisabled}>`,
    "</label>",
    "<label class=\"check\">",
    `<input type="checkbox" name="allowBlankGmPassword"${status?.gm?.allowBlank ? " checked" : ""}>`,
    "<span>This GM user has a blank access key</span>",
    "</label>",
    "<footer>",
    "<button type=\"button\" data-action=\"refresh\">Refresh</button>",
    "<button type=\"submit\">Store Lifecycle Settings</button>",
    "</footer>",
    "</form>",
    "</div>"
  ].join("");

  const wrapper = document.createElement("div");
  wrapper.id = lifecycleWizardId();
  wrapper.innerHTML = [
    "<style>",
    `#${lifecycleWizardId()} .${MODULE_ID}-overlay{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:24px;}`,
    `#${lifecycleWizardId()} .${MODULE_ID}-wizard{width:min(720px,calc(100vw - 48px));max-height:calc(100vh - 48px);overflow:auto;background:#f3efe4;color:#181511;border:1px solid #4b4235;box-shadow:0 18px 80px rgba(0,0,0,.5);padding:18px;display:grid;gap:12px;}`,
    `#${lifecycleWizardId()} header,#${lifecycleWizardId()} footer{display:flex;align-items:center;justify-content:space-between;gap:12px;}`,
    `#${lifecycleWizardId()} h2{font-size:20px;margin:0;}`,
    `#${lifecycleWizardId()} dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 12px;margin:0;padding:10px;background:rgba(0,0,0,.06);}`,
    `#${lifecycleWizardId()} dt{font-weight:700;}`,
    `#${lifecycleWizardId()} dd{margin:0;word-break:break-word;}`,
    `#${lifecycleWizardId()} label{display:grid;gap:4px;font-weight:700;}`,
    `#${lifecycleWizardId()} label.check{display:flex;align-items:center;gap:8px;font-weight:400;}`,
    `#${lifecycleWizardId()} input,#${lifecycleWizardId()} select{min-height:32px;padding:5px 7px;}`,
    `#${lifecycleWizardId()} .notice{margin:0;color:#124d21;}`,
    `#${lifecycleWizardId()} .error{margin:0;color:#8a1f17;}`,
    "</style>",
    content
  ].join("");
  document.body.appendChild(wrapper);

  const form = wrapper.querySelector("form");
  const blankCheckbox = form.querySelector("input[name='allowBlankGmPassword']");
  const gmPassword = form.querySelector("input[name='gmPassword']");
  blankCheckbox.addEventListener("change", () => {
    gmPassword.disabled = blankCheckbox.checked;
    if (blankCheckbox.checked) gmPassword.value = "";
  });
  wrapper.querySelector("[data-action='close']").addEventListener("click", closeLifecycleSetupWizard);
  wrapper.querySelector("[data-action='refresh']").addEventListener("click", () => {
    void openLifecycleSetupWizard("Lifecycle status refreshed.");
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const allowBlankGmPassword = formData.get("allowBlankGmPassword") === "on";
    const payload = {
      worldId: game.world.id,
      gmUserId: String(formData.get("gmUserId") ?? ""),
      allowBlankGmPassword,
      foundryUrl: window.location.origin
    };
    const adminPassword = String(formData.get("adminPassword") ?? "");
    const worldPassword = String(formData.get("gmPassword") ?? "");
    if (adminPassword) payload.adminPassword = adminPassword;
    if (!allowBlankGmPassword && worldPassword) payload.gmPassword = worldPassword;

    try {
      const updated = await sendLifecycleRequest("storeLifecycleCredentials", payload);
      renderLifecycleSetupWizard(updated, "Lifecycle credentials and non-secret settings were stored.");
    } catch (submitError) {
      renderLifecycleSetupWizard(status, "", submitError instanceof Error ? submitError.message : String(submitError));
    }
  });
}

async function openLifecycleSetupWizard(message = "") {
  try {
    renderLifecycleSetupWizard(null, "Loading lifecycle status...");
    const status = await sendLifecycleRequest("lifecycleCredentialStatus", { worldId: game.world.id });
    renderLifecycleSetupWizard(status, message);
  } catch (error) {
    renderLifecycleSetupWizard(null, "", error instanceof Error ? error.message : String(error));
  }
}

function registerLifecycleSetupMenu() {
  const BaseApplication = globalThis.FormApplication ?? globalThis.Application;
  if (!BaseApplication || !game.settings?.registerMenu) return;
  class LifecycleSetupMenu extends BaseApplication {
    render(force, options) {
      void openLifecycleSetupWizard();
      return this;
    }
  }
  game.settings.registerMenu(MODULE_ID, "lifecycleSetup", {
    name: "Lifecycle Credential Setup",
    label: "Open Setup",
    hint: "Store local restart/login credentials for this trusted GM world.",
    icon: "fas fa-key",
    type: LifecycleSetupMenu,
    restricted: true
  });
}

async function showAuthorizationPrompt(payload = {}) {
  if (!game.user?.isGM) return;
  if (authorizationStatus.trusted === true) return;
  if (authorizationPromptOpen) return;
  if (authorizationPromptDismissedForWorld === game.world.id) return;

  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (!DialogV2?.confirm) {
    authorizationPromptDismissedForWorld = game.world.id;
    ui.notifications?.warn?.("Codex Foundry Bridge is not authorized for this world. Run await CodexFoundryBridge.authorizeCurrentWorld() to trust it.");
    return;
  }

  authorizationPromptOpen = true;
  try {
    const world = payload.world ?? currentWorldPayload();
    const content = [
      "<p>Codex Foundry Bridge is not authorized for this world.</p>",
      "<p>Authorize this GM world to allow local Codex MCP tools to inspect or modify it through this browser session.</p>",
      "<dl>",
      `<dt>World</dt><dd>${escapeHtml(world.worldTitle ?? game.world.title)} (${escapeHtml(world.worldId ?? game.world.id)})</dd>`,
      `<dt>System</dt><dd>${escapeHtml(world.systemId ?? game.system.id)} ${escapeHtml(world.systemVersion ?? game.system.version)}</dd>`,
      `<dt>Bridge URL</dt><dd>${escapeHtml(game.settings.get(MODULE_ID, "bridgeUrl") || DEFAULT_URL)}</dd>`,
      "</dl>"
    ].join("");

    const confirmed = await DialogV2.confirm({
      window: { title: "Authorize Codex Foundry Bridge" },
      content,
      yes: { label: "Authorize This World" },
      no: { label: "Not Now" }
    });

    if (confirmed === true) {
      authorizeCurrentWorld();
    } else {
      authorizationPromptDismissedForWorld = game.world.id;
    }
  } finally {
    authorizationPromptOpen = false;
  }
}

function handleAuthorizationStatus(payload = {}) {
  authorizationStatus = {
    trusted: payload.trusted === true,
    world: payload.world ?? null,
    trustedWorlds: Array.isArray(payload.trustedWorlds) ? payload.trustedWorlds : []
  };

  if (authorizationStatus.trusted) {
    authorizationPromptDismissedForWorld = null;
    console.info(`${MODULE_ID}: authorized for ${game.world.id}.`);
  } else {
    void showAuthorizationPrompt(payload);
  }
}

function connect() {
  if (!game.user?.isGM) {
    console.info(`${MODULE_ID}: bridge disabled for non-GM user.`);
    return;
  }

  const enabled = game.settings.get(MODULE_ID, "enabled");
  const token = game.settings.get(MODULE_ID, "bridgeToken");
  const url = game.settings.get(MODULE_ID, "bridgeUrl") || DEFAULT_URL;

  if (!enabled || !token) {
    console.info(`${MODULE_ID}: set a local bridge token and enable the bridge to connect.`);
    return;
  }

  socket = new WebSocket(url);

  socket.addEventListener("open", () => {
    sendHello(token);
  });

  socket.addEventListener("message", async (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (error) {
      console.warn(`${MODULE_ID}: invalid bridge payload`, error);
      return;
    }

    if (payload.type === "authorizationStatus") {
      handleAuthorizationStatus(payload);
      return;
    }

    if (payload.type === "lifecycleResponse") {
      handleLifecycleResponse(payload);
      return;
    }

    if (payload.type !== "request") return;

    recordTimelineEvent("bridge-request", {
      action: "received",
      requestId: payload.id,
      method: payload.method
    });

    if (authorizationStatus.trusted !== true) {
      recordTimelineEvent("bridge-request", {
        action: "refused",
        requestId: payload.id,
        method: payload.method,
        reason: "world-not-authorized"
      });
      send({
        type: "response",
        id: payload.id,
        ok: false,
        error: "Codex Foundry Bridge is not authorized for this world."
      });
      return;
    }

    try {
      const result = await handleBridgeRequest(payload.method, payload.args ?? {});
      recordTimelineEvent("bridge-request", {
        action: "completed",
        requestId: payload.id,
        method: payload.method,
        ok: true
      });
      send({ type: "response", id: payload.id, ok: true, result: redact(result) });
    } catch (error) {
      recordRuntimeEvent("error", "bridge-request", {
        method: payload.method,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      recordTimelineEvent("bridge-request", {
        action: "completed",
        requestId: payload.id,
        method: payload.method,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
      send({
        type: "response",
        id: payload.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  socket.addEventListener("close", () => {
    socket = null;
    for (const [id, item] of lifecyclePending) {
      window.clearTimeout(item.timer);
      item.reject(new Error("Codex Foundry Bridge daemon connection closed."));
      lifecyclePending.delete(id);
    }
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(connect, RECONNECT_MS);
  });

  socket.addEventListener("error", () => {
    // The close handler schedules reconnects. Avoid logging every retry.
  });
}

async function setToken(token) {
  await game.settings.set(MODULE_ID, "bridgeToken", token);
  await game.settings.set(MODULE_ID, "enabled", true);
  authorizationPromptDismissedForWorld = null;
  if (socket) socket.close();
  connect();
}

Hooks.once("init", () => {
  installRuntimeCapture();

  game.settings.register(MODULE_ID, "enabled", {
    name: "Enable Codex Foundry Bridge",
    hint: "Connect this GM client to the local Codex MCP bridge.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, "bridgeUrl", {
    name: "Bridge URL",
    hint: "Local WebSocket URL for the Codex bridge.",
    scope: "client",
    config: true,
    type: String,
    default: DEFAULT_URL
  });

  game.settings.register(MODULE_ID, "bridgeToken", {
    name: "Bridge Token",
    hint: "Local token shared with the Codex MCP server. Do not share it.",
    scope: "client",
    config: false,
    type: String,
    default: ""
  });

  registerLifecycleSetupMenu();
});

Hooks.once("ready", () => {
  patchNotificationCapture();
  installTimelineHooks();
  globalThis.CodexFoundryBridge = {
    connect,
    setToken,
    authorizeCurrentWorld,
    revokeCurrentWorld,
    authorizationStatus: () => authorizationStatus,
    status: async () => handleBridgeRequest("foundry_status", {}),
    request: async (method, args) => handleBridgeRequest(method, args),
    openLifecycleSetup: openLifecycleSetupWizard,
    getRuntimeEvents,
    getRuntimeTimeline,
    clearRuntimeEvents,
    installTimelineHooks,
    installRuntimeCapture
  };
  connect();
});
