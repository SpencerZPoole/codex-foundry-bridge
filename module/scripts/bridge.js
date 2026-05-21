const MODULE_ID = "codex-foundry-bridge";
const MODULE_VERSION = "0.2.4";
const DEFAULT_URL = "ws://127.0.0.1:30123/foundry";
const RECONNECT_MS = 5000;
const MAX_RESULT_CHARS = 1_000_000;
const MAX_RUNTIME_EVENTS = 250;
const RUNTIME_CAPTURE_FLAG = "__codexFoundryBridgeRuntimeCaptureInstalled";
const CONSOLE_PATCH_FLAG = "__codexFoundryBridgeConsolePatched";
const NOTIFICATION_PATCH_FLAG = "__codexFoundryBridgeNotificationsPatched";
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
const pending = new Map();
let runtimeEvents = [];
let authorizationStatus = { trusted: null, world: null, trustedWorlds: [] };
let authorizationPromptOpen = false;
let authorizationPromptDismissedForWorld = null;

function isSensitiveField(key) {
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
    runtimeEvents: runtimeEventSummary()
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

    case "clear_runtime_events":
      return clearRuntimeEvents();

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

    if (payload.type !== "request") return;

    if (authorizationStatus.trusted !== true) {
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
      send({ type: "response", id: payload.id, ok: true, result: redact(result) });
    } catch (error) {
      recordRuntimeEvent("error", "bridge-request", {
        method: payload.method,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
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
});

Hooks.once("ready", () => {
  patchNotificationCapture();
  globalThis.CodexFoundryBridge = {
    connect,
    setToken,
    authorizeCurrentWorld,
    revokeCurrentWorld,
    authorizationStatus: () => authorizationStatus,
    status: async () => handleBridgeRequest("foundry_status", {}),
    request: async (method, args) => handleBridgeRequest(method, args),
    getRuntimeEvents,
    clearRuntimeEvents,
    installRuntimeCapture
  };
  connect();
});
