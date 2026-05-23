import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BRIDGE_VERSION, listBridgeTools } from "./tool-registry.js";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");

export const BRIDGE_RESOURCE_URIS = {
  quickstart: "foundry://bridge/quickstart",
  capabilities: "foundry://bridge/capabilities",
  readme: "foundry://bridge/readme"
};

export const BRIDGE_FIRST_CONTACT_PROMPT = "foundry_bridge_first_contact";

const QUICKSTART_PATH = path.join(ROOT, "docs", "AGENT_QUICKSTART.md");
const CAPABILITIES_PATH = path.join(ROOT, "docs", "bridge-capabilities.json");
const README_PATH = path.join(ROOT, "README.md");

function readTextFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

export function readAgentQuickstartMarkdown() {
  return readTextFile(QUICKSTART_PATH);
}

export function readCapabilitiesManifestText() {
  return readTextFile(CAPABILITIES_PATH);
}

export function readReadmeMarkdown() {
  return readTextFile(README_PATH);
}

function resourceText(uri, mimeType, text) {
  return {
    contents: [
      {
        uri: typeof uri === "string" ? uri : uri.href,
        mimeType,
        text
      }
    ]
  };
}

export function buildBridgeQuickstartPayload() {
  const registry = listBridgeTools();
  const exampleTools = registry.tools
    .filter((tool) => Array.isArray(tool.examples) && tool.examples.length)
    .map((tool) => ({
      name: tool.name,
      title: tool.title,
      examples: tool.examples
    }));

  return {
    bridgeVersion: BRIDGE_VERSION,
    registry: {
      version: registry.registryVersion,
      checksum: registry.checksum,
      toolCount: registry.toolCount,
      fallback: registry.fallback
    },
    firstContact: [
      "Call bridge_self_check first to learn daemon, version, trust, and readiness state.",
      "Call list_bridge_tools next to inspect the complete registry, risks, gates, input keys, output shapes, and examples.",
      "Prefer direct MCP tools when visible; use call_bridge_tool only when direct MCP discovery lags.",
      "Do not call trusted-session tools until a GM has opened, authorized, and trusted the target world.",
      "Prefer plan_* tools plus apply_bridge_plan for writes so changes are previewed and confirmed.",
      "Validate disposable behavior on scratch unless the user explicitly names another world.",
      "Treat restart_foundry_world and run_gm_script as explicit-danger workflows."
    ],
    safetyRules: [
      "Localhost daemon and CODEX_FOUNDRY_BRIDGE_TOKEN authentication are required.",
      "Live-world reads and writes require a trusted GM Foundry session.",
      "call_bridge_tool is a dispatch fallback, not a privilege bypass.",
      "apply_bridge_plan requires matching planId, planHash, and worldId confirmation.",
      "run_gm_script and restart_foundry_world require dangerous=true.",
      "Outputs are redacted for token-like and credential-like fields, but agents should still avoid requesting secrets."
    ],
    preferredWorkflow: [
      "Diagnose: bridge_self_check, then list_bridge_tools.",
      "Read: use compact summaries, search, audits, and compendium tools before raw get_document calls.",
      "Write: use plan_journal_changes, plan_scene_changes, plan_document_changes, or plan_chat_messages before apply_bridge_plan.",
      "Maintain: use backup/revoke/install/lifecycle tools only when the user clearly asks for local maintenance."
    ],
    resources: BRIDGE_RESOURCE_URIS,
    prompt: BRIDGE_FIRST_CONTACT_PROMPT,
    exampleTools
  };
}

export function getBridgeQuickstart({ format = "json" } = {}) {
  const normalized = String(format ?? "json").toLowerCase();
  if (normalized === "markdown") return readAgentQuickstartMarkdown();
  if (normalized !== "json") {
    throw new Error('get_bridge_quickstart format must be "json" or "markdown".');
  }
  return buildBridgeQuickstartPayload();
}

export function bridgeFirstContactPromptText() {
  return [
    "You are connected to Foundry Codex Bridge.",
    "",
    "First contact workflow:",
    "1. Call bridge_self_check before attempting live-world work.",
    "2. Call list_bridge_tools and inspect category, risk, readOnly, requiresTrustedSession, fallbackCallable, inputKeys, outputShape, and examples.",
    `3. Read ${BRIDGE_RESOURCE_URIS.quickstart} and ${BRIDGE_RESOURCE_URIS.capabilities} when MCP resources are available.`,
    "4. Prefer direct MCP tools. Use call_bridge_tool only when direct MCP discovery is stale or incomplete.",
    "5. Do not use trusted-session tools until a GM session is trusted.",
    "6. Prefer preview/apply workflows for writes, and validate disposable behavior on scratch unless the user explicitly chooses another world.",
    "7. Treat restart_foundry_world and run_gm_script as dangerous=true workflows and never use them casually."
  ].join("\n");
}

export function registerBridgeOnboarding(server) {
  server.registerResource(
    "foundry_bridge_agent_quickstart",
    BRIDGE_RESOURCE_URIS.quickstart,
    {
      title: "Foundry Bridge Agent Quickstart",
      description: "First-contact workflow for agents using Foundry Codex Bridge.",
      mimeType: "text/markdown"
    },
    async (uri) => resourceText(uri, "text/markdown", readAgentQuickstartMarkdown())
  );

  server.registerResource(
    "foundry_bridge_capabilities",
    BRIDGE_RESOURCE_URIS.capabilities,
    {
      title: "Foundry Bridge Capability Manifest",
      description: "Deterministic machine-readable registry metadata for all bridge tools.",
      mimeType: "application/json"
    },
    async (uri) => resourceText(uri, "application/json", readCapabilitiesManifestText())
  );

  server.registerResource(
    "foundry_bridge_readme",
    BRIDGE_RESOURCE_URIS.readme,
    {
      title: "Foundry Bridge README",
      description: "Public README with setup, safety, workflow, and lifecycle guidance.",
      mimeType: "text/markdown"
    },
    async (uri) => resourceText(uri, "text/markdown", readReadmeMarkdown())
  );

  server.registerPrompt(
    BRIDGE_FIRST_CONTACT_PROMPT,
    {
      title: "Foundry Bridge First Contact",
      description: "Bootstrap prompt for agents learning a new Foundry Codex Bridge installation."
    },
    async () => ({
      description: "Use this before live Foundry work on a new bridge installation.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: bridgeFirstContactPromptText()
          }
        }
      ]
    })
  );
}
