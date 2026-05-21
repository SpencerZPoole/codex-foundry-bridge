import { createHash } from "node:crypto";
import { z } from "zod";

export const BRIDGE_VERSION = "0.2.12";
export const TOOL_REGISTRY_VERSION = 1;

const AnyJson = z.any().optional();
const AnyObject = z.record(z.string(), z.any()).optional();
const BridgePlanObject = z.record(z.string(), z.any());
const BridgePlanConfirmation = z.object({
  planId: z.string(),
  planHash: z.string(),
  worldId: z.string()
});
const SceneChangeObject = z.object({
  action: z.string(),
  sceneId: z.string().optional(),
  sceneName: z.string().optional(),
  tokenId: z.string().optional(),
  tokenName: z.string().optional(),
  actorId: z.string().optional(),
  actorName: z.string().optional(),
  lightId: z.string().optional(),
  lightName: z.string().optional(),
  noteId: z.string().optional(),
  noteName: z.string().optional(),
  journalId: z.string().optional(),
  journalName: z.string().optional(),
  pageId: z.string().optional(),
  pageName: z.string().optional(),
  data: z.record(z.string(), z.any()).optional()
});
const DocumentChangeObject = z.object({
  action: z.string(),
  documentName: z.string(),
  id: z.string().optional(),
  name: z.string().optional(),
  folderType: z.string().optional(),
  data: z.record(z.string(), z.any())
});
const ChatMessagePlanObject = z.object({
  kind: z.string(),
  audience: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  contentFormat: z.string().optional(),
  recipientIds: z.array(z.string()).optional(),
  recipientNames: z.array(z.string()).optional(),
  speakerAlias: z.string().optional(),
  blind: z.boolean().optional(),
  checkName: z.string().optional(),
  dc: z.union([z.string(), z.number()]).optional(),
  subjectActorId: z.string().optional(),
  subjectActorName: z.string().optional(),
  prompt: z.string().optional()
});

const CATEGORY = {
  diagnostics: "diagnostics",
  dispatch: "dispatch",
  liveRead: "live-read",
  localRead: "local-read",
  diagnosticWrite: "diagnostic-write",
  transaction: "transaction",
  liveWrite: "live-write",
  destructive: "destructive",
  execute: "execute",
  lifecycle: "lifecycle",
  localMaintenance: "local-maintenance"
};

function capabilityMetadata(category, outputShape, overrides = {}) {
  return {
    category,
    outputShape,
    fallbackCallable: true,
    directMcpExposure: true,
    ...overrides
  };
}

export const TOOL_DEFINITIONS = [
  {
    name: "foundry_status",
    title: "Foundry status",
    description: "Report Foundry runtime status, bridge daemon state, and active GM session metadata.",
    inputSchema: {},
    risk: "read",
    requiresTrustedSession: false,
    ...capabilityMetadata(CATEGORY.diagnostics, "FoundryStatusReport")
  },
  {
    name: "bridge_self_check",
    title: "Bridge self check",
    description: "Run a read-only bridge health check with diagnostics and actionable next steps.",
    inputSchema: {},
    risk: "read",
    requiresTrustedSession: false,
    ...capabilityMetadata(CATEGORY.diagnostics, "BridgeSelfCheckReport")
  },
  {
    name: "list_bridge_tools",
    title: "List bridge tools",
    description: "List bridge tool metadata, risk flags, and registry checksum.",
    inputSchema: {},
    risk: "read",
    requiresTrustedSession: false,
    ...capabilityMetadata(CATEGORY.diagnostics, "BridgeToolList")
  },
  {
    name: "call_bridge_tool",
    title: "Call bridge tool",
    description: "Fallback dispatcher for invoking any registered bridge tool when direct MCP discovery lags.",
    inputSchema: {
      method: z.string(),
      args: AnyObject
    },
    risk: "meta-dispatch",
    requiresTrustedSession: false,
    ...capabilityMetadata(CATEGORY.dispatch, "TargetToolResult", {
      fallbackCallable: false
    })
  },
  {
    name: "list_collections",
    title: "List Foundry collections",
    description: "List live Foundry world collections from the connected GM session.",
    inputSchema: {},
    risk: "read",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.liveRead, "CollectionSummary[]")
  },
  {
    name: "get_document",
    title: "Get Foundry document",
    description: "Read a Foundry document by collection and id or name.",
    inputSchema: {
      collection: z.string(),
      id: z.string(),
      includeEmbedded: z.boolean().optional()
    },
    risk: "read",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.liveRead, "FoundryDocument")
  },
  {
    name: "search_documents",
    title: "Search Foundry documents",
    description: "Search live documents in a collection.",
    inputSchema: {
      collection: z.string(),
      query: z.string().optional(),
      limit: z.number().optional()
    },
    risk: "read",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.liveRead, "DocumentSearchResult[]")
  },
  {
    name: "list_scenes",
    title: "List scenes",
    description: "List scenes in the active world.",
    inputSchema: {},
    risk: "read",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.liveRead, "SceneSummary[]")
  },
  {
    name: "inspect_scene",
    title: "Inspect scene",
    description: "Read a scene including embedded scene documents.",
    inputSchema: {
      id: z.string().optional()
    },
    risk: "read",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.liveRead, "SceneDocument")
  },
  {
    name: "list_compendium_packs",
    title: "List compendium packs",
    description: "List live Foundry compendium packs with compact metadata.",
    inputSchema: {
      packageName: z.string().optional(),
      documentName: z.string().optional(),
      query: z.string().optional(),
      limit: z.number().optional()
    },
    risk: "read",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.liveRead, "CompendiumPackSummary[]")
  },
  {
    name: "search_compendium",
    title: "Search compendium",
    description: "Search live Foundry compendium indexes without scraping pack storage files.",
    inputSchema: {
      pack: z.string().optional(),
      query: z.string().optional(),
      documentName: z.string().optional(),
      type: z.string().optional(),
      limit: z.number().optional(),
      fields: z.array(z.string()).optional()
    },
    risk: "read",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.liveRead, "CompendiumSearchResult[]")
  },
  {
    name: "get_compendium_document",
    title: "Get compendium document",
    description: "Read or summarize a single document from a live Foundry compendium pack.",
    inputSchema: {
      pack: z.string(),
      id: z.string(),
      summarize: z.boolean().optional()
    },
    risk: "read",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.liveRead, "CompendiumDocument")
  },
  {
    name: "summarize_actor",
    title: "Summarize actor",
    description: "Return a compact D35E-oriented summary of a live world actor.",
    inputSchema: {
      id: z.string(),
      includeItems: z.boolean().optional(),
      itemLimit: z.number().optional()
    },
    risk: "read",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.liveRead, "ActorSummary")
  },
  {
    name: "summarize_scene",
    title: "Summarize scene",
    description: "Return a compact summary of a live scene and optional token details.",
    inputSchema: {
      id: z.string().optional(),
      includeTokens: z.boolean().optional(),
      tokenLimit: z.number().optional()
    },
    risk: "read",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.liveRead, "SceneSummary")
  },
  {
    name: "summarize_world_index",
    title: "Summarize world index",
    description: "Return compact live-world counts, active scene state, users, compendium packs, runtime health, and optional samples.",
    inputSchema: {
      includeSamples: z.boolean().optional(),
      sampleLimit: z.number().optional()
    },
    risk: "read",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.liveRead, "WorldIndexSummary")
  },
  {
    name: "search_world",
    title: "Search world",
    description: "Search across live world collections and return compact stable-id results.",
    inputSchema: {
      query: z.string(),
      collections: z.array(z.string()).optional(),
      limit: z.number().optional()
    },
    risk: "read",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.liveRead, "WorldSearchResult[]")
  },
  {
    name: "audit_scene_readiness",
    title: "Audit scene readiness",
    description: "Read-only scene readiness audit for assets, linked actors, token state, grid, background, and scene document counts.",
    inputSchema: {
      id: z.string().optional(),
      includeTokens: z.boolean().optional(),
      tokenLimit: z.number().optional()
    },
    risk: "read",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.liveRead, "SceneReadinessAudit")
  },
  {
    name: "audit_actor_readiness",
    title: "Audit actor readiness",
    description: "Read-only actor readiness audit for images, token linkage, ownership, item gaps, and D35E summary availability.",
    inputSchema: {
      id: z.string().optional(),
      includeItems: z.boolean().optional(),
      itemLimit: z.number().optional()
    },
    risk: "read",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.liveRead, "ActorReadinessAudit")
  },
  {
    name: "list_users",
    title: "List users",
    description: "List Foundry users from the live world with sensitive fields redacted.",
    inputSchema: {},
    risk: "read",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.liveRead, "UserSummary[]")
  },
  {
    name: "list_chat_targets",
    title: "List chat targets",
    description: "List compact live Foundry chat delivery targets for GM, player, and active-user messages.",
    inputSchema: {
      includeGMs: z.boolean().optional(),
      includePlayers: z.boolean().optional(),
      activeOnly: z.boolean().optional()
    },
    risk: "read",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.liveRead, "ChatTargetSummary[]")
  },
  {
    name: "read_settings",
    title: "Read settings",
    description: "Read live Foundry settings with sensitive fields redacted.",
    inputSchema: {
      namespace: z.string().optional()
    },
    risk: "read",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.liveRead, "SettingSummary[]")
  },
  {
    name: "tail_logs",
    title: "Tail Foundry logs",
    description: "Read recent Foundry log lines from local log files with secret-like fields redacted.",
    inputSchema: {
      file: z.string().optional(),
      limit: z.number().optional()
    },
    risk: "read",
    requiresTrustedSession: false,
    ...capabilityMetadata(CATEGORY.localRead, "LogLine[]")
  },
  {
    name: "get_runtime_events",
    title: "Get runtime events",
    description: "Read recent live GM-client runtime warnings, errors, notifications, and bridge request failures.",
    inputSchema: {
      limit: z.number().optional(),
      level: z.string().optional(),
      source: z.string().optional(),
      since: z.string().optional()
    },
    risk: "read",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.liveRead, "RuntimeEvent[]")
  },
  {
    name: "get_runtime_timeline",
    title: "Get runtime timeline",
    description: "Read a bounded in-memory live-session timeline of runtime events, bridge requests, chat, scene, combat, and user activity.",
    inputSchema: {
      limit: z.number().optional(),
      since: z.string().optional(),
      type: z.string().optional()
    },
    risk: "read",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.liveRead, "RuntimeTimelineEvent[]")
  },
  {
    name: "clear_runtime_events",
    title: "Clear runtime events",
    description: "Clear the live GM-client runtime event buffer.",
    inputSchema: {},
    risk: "diagnostic-write",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.diagnosticWrite, "RuntimeEventClearResult")
  },
  {
    name: "export_world_snapshot",
    title: "Export world snapshot",
    description: "Create a sanitized live snapshot of collections and basic server metadata.",
    inputSchema: {},
    risk: "read",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.liveRead, "WorldSnapshot")
  },
  {
    name: "plan_journal_changes",
    title: "Plan journal changes",
    description: "Preview JournalEntry and JournalEntryPage create/update operations without mutating the world.",
    inputSchema: {
      action: z.string(),
      journalId: z.string().optional(),
      journalName: z.string().optional(),
      entryName: z.string().optional(),
      folderId: z.string().optional(),
      pageId: z.string().optional(),
      pageName: z.string().optional(),
      pageType: z.string().optional(),
      content: z.string().optional(),
      pages: z.array(z.object({
        name: z.string().optional(),
        pageName: z.string().optional(),
        type: z.string().optional(),
        pageType: z.string().optional(),
        content: z.string().optional()
      })).optional()
    },
    risk: "read",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.transaction, "BridgePlan")
  },
  {
    name: "plan_scene_changes",
    title: "Plan scene changes",
    description: "Preview Scene token, ambient light, and note create/update operations without mutating the world.",
    inputSchema: {
      sceneId: z.string().optional(),
      sceneName: z.string().optional(),
      changes: z.array(SceneChangeObject)
    },
    risk: "read",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.transaction, "BridgePlan")
  },
  {
    name: "plan_document_changes",
    title: "Plan document changes",
    description: "Preview Actor, Item, Scene, and Folder create/update operations without mutating the world.",
    inputSchema: {
      changes: z.array(DocumentChangeObject)
    },
    risk: "read",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.transaction, "BridgePlan")
  },
  {
    name: "plan_chat_messages",
    title: "Plan chat messages",
    description: "Preview high-level Foundry chat notices, handouts, GM notes, and secret-check prompts without posting them.",
    inputSchema: {
      messages: z.array(ChatMessagePlanObject)
    },
    risk: "read",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.transaction, "BridgePlan")
  },
  {
    name: "apply_bridge_plan",
    title: "Apply bridge plan",
    description: "Apply a confirmed bridge transaction plan through the trusted GM session.",
    inputSchema: {
      plan: BridgePlanObject,
      confirmation: BridgePlanConfirmation
    },
    risk: "write",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.transaction, "BridgePlanApplyResult")
  },
  {
    name: "create_document",
    title: "Create document",
    description: "Create a Foundry world document through the live GM session.",
    inputSchema: {
      documentName: z.string(),
      data: AnyJson
    },
    risk: "write",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.liveWrite, "CreatedDocument")
  },
  {
    name: "update_document",
    title: "Update document",
    description: "Update a Foundry world document through the live GM session.",
    inputSchema: {
      collection: z.string(),
      id: z.string(),
      data: AnyJson
    },
    risk: "write",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.liveWrite, "UpdatedDocument")
  },
  {
    name: "delete_document",
    title: "Delete document",
    description: "Delete a Foundry world document after creating a local backup.",
    inputSchema: {
      collection: z.string(),
      id: z.string()
    },
    risk: "destructive-with-backup",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.destructive, "DeleteResultWithBackup")
  },
  {
    name: "create_embedded_document",
    title: "Create embedded document",
    description: "Create an embedded Foundry document such as a TokenDocument on a Scene.",
    inputSchema: {
      parentCollection: z.string(),
      parentId: z.string(),
      embeddedName: z.string(),
      data: AnyJson
    },
    risk: "write",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.liveWrite, "CreatedEmbeddedDocument")
  },
  {
    name: "update_embedded_document",
    title: "Update embedded document",
    description: "Update an embedded Foundry document such as a TokenDocument on a Scene.",
    inputSchema: {
      parentCollection: z.string(),
      parentId: z.string(),
      embeddedName: z.string(),
      data: AnyJson
    },
    risk: "write",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.liveWrite, "UpdatedEmbeddedDocument")
  },
  {
    name: "delete_embedded_document",
    title: "Delete embedded document",
    description: "Delete an embedded Foundry document after creating a local backup.",
    inputSchema: {
      parentCollection: z.string(),
      parentId: z.string(),
      embeddedName: z.string(),
      embeddedId: z.string()
    },
    risk: "destructive-with-backup",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.destructive, "DeleteEmbeddedResultWithBackup")
  },
  {
    name: "create_chat_message",
    title: "Create chat message",
    description: "Create a chat message in the active world.",
    inputSchema: {
      content: z.string(),
      speaker: AnyJson,
      whisper: AnyJson,
      blind: z.boolean().optional()
    },
    risk: "write",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.liveWrite, "ChatMessage")
  },
  {
    name: "run_macro",
    title: "Run macro",
    description: "Run a Foundry macro by id or name through the GM session.",
    inputSchema: {
      id: z.string().optional(),
      name: z.string().optional(),
      context: AnyJson
    },
    risk: "execute-foundry-macro",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.execute, "MacroExecutionResult")
  },
  {
    name: "run_gm_script",
    title: "Run GM script",
    description: "Run explicit JavaScript in the live GM client. Requires dangerous=true.",
    inputSchema: {
      script: z.string(),
      context: AnyJson,
      dangerous: z.boolean()
    },
    risk: "dangerous-execute",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.execute, "ScriptExecutionResult")
  },
  {
    name: "list_installed_packages",
    title: "List installed packages",
    description: "List installed local systems, modules, and worlds from Foundry data.",
    inputSchema: {},
    risk: "read",
    requiresTrustedSession: false,
    ...capabilityMetadata(CATEGORY.localRead, "InstalledPackageReport")
  },
  {
    name: "read_foundry_options_sanitized",
    title: "Read sanitized Foundry options",
    description: "Read Foundry options.json with secrets redacted.",
    inputSchema: {},
    risk: "read-sensitive-redacted",
    requiresTrustedSession: false,
    ...capabilityMetadata(CATEGORY.localRead, "SanitizedFoundryOptions")
  },
  {
    name: "list_trusted_worlds",
    title: "List trusted worlds",
    description: "List Foundry worlds authorized to connect through this local bridge.",
    inputSchema: {},
    risk: "read",
    requiresTrustedSession: false,
    ...capabilityMetadata(CATEGORY.localRead, "TrustedWorldList")
  },
  {
    name: "restart_foundry_world",
    title: "Restart Foundry world",
    description: "Fully restart the local Foundry app, launch an explicit world, join as GM, and verify bridge readiness.",
    inputSchema: {
      worldId: z.string(),
      gmUserId: z.string().optional(),
      dangerous: z.boolean(),
      loginVisibleApp: z.boolean().optional(),
      allowHeadlessOnlyFallback: z.boolean().optional(),
      bridgeCdpPort: z.number().optional(),
      visibleCdpPort: z.number().optional(),
      timeouts: z.object({
        stopGraceMs: z.number().optional(),
        stopForceMs: z.number().optional(),
        startupMs: z.number().optional(),
        worldLaunchMs: z.number().optional(),
        gmJoinMs: z.number().optional(),
        bridgeReadyMs: z.number().optional(),
        pollMs: z.number().optional()
      }).optional()
    },
    risk: "dangerous-local-lifecycle",
    requiresTrustedSession: false,
    ...capabilityMetadata(CATEGORY.lifecycle, "FoundryLifecycleRestartResult")
  },
  {
    name: "revoke_trusted_world",
    title: "Revoke trusted world",
    description: "Remove a Foundry world from the local bridge trusted-world list.",
    inputSchema: {
      worldId: z.string()
    },
    risk: "local-config-write",
    requiresTrustedSession: false,
    ...capabilityMetadata(CATEGORY.localMaintenance, "TrustedWorldRevocationResult")
  },
  {
    name: "backup_world",
    title: "Backup world",
    description: "Copy the active world directory to the bridge backup folder.",
    inputSchema: {},
    risk: "local-backup-write",
    requiresTrustedSession: true,
    ...capabilityMetadata(CATEGORY.localMaintenance, "WorldBackupResult")
  },
  {
    name: "install_or_update_bridge_module",
    title: "Install or update bridge module",
    description: "Copy the bridge Foundry module into the local Foundry modules directory.",
    inputSchema: {},
    risk: "local-module-write",
    requiresTrustedSession: false,
    ...capabilityMetadata(CATEGORY.localMaintenance, "ModuleInstallResult")
  }
];

export function toolDefinitionByName(name) {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name) ?? null;
}

export function publicToolDefinition(tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    category: tool.category,
    outputShape: tool.outputShape,
    risk: tool.risk,
    readOnly: tool.risk === "read" || tool.risk === "read-sensitive-redacted",
    requiresTrustedSession: tool.requiresTrustedSession,
    directMcpExposure: tool.directMcpExposure,
    fallbackCallable: tool.fallbackCallable,
    inputKeys: Object.keys(tool.inputSchema ?? {}).sort()
  };
}

export function listBridgeTools() {
  return {
    bridgeVersion: BRIDGE_VERSION,
    registryVersion: TOOL_REGISTRY_VERSION,
    checksum: toolRegistryChecksum(),
    fallback: {
      tool: "call_bridge_tool",
      note: "Use call_bridge_tool when direct MCP discovery lags; the target tool's normal safety gates still apply."
    },
    toolCount: TOOL_DEFINITIONS.length,
    tools: TOOL_DEFINITIONS.map(publicToolDefinition)
  };
}

export function toolRegistryChecksum() {
  const payload = JSON.stringify({
    bridgeVersion: BRIDGE_VERSION,
    registryVersion: TOOL_REGISTRY_VERSION,
    tools: TOOL_DEFINITIONS.map(publicToolDefinition)
  });
  return createHash("sha256").update(payload).digest("hex");
}
