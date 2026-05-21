import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildCapabilityManifest } from "../scripts/generate-capability-manifest.mjs";
import {
  BRIDGE_VERSION,
  TOOL_DEFINITIONS,
  publicToolDefinition,
  toolRegistryChecksum
} from "../src/tool-registry.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = path.join(projectRoot, "docs", "bridge-capabilities.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const generatedManifest = buildCapabilityManifest();
const toolNames = TOOL_DEFINITIONS.map((tool) => tool.name);
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
  "apply_bridge_plan"
];

assert.deepEqual(manifest, generatedManifest);
assert.equal(manifest.bridgeVersion, BRIDGE_VERSION);
assert.equal(manifest.checksum, toolRegistryChecksum());
assert.equal(manifest.toolCount, TOOL_DEFINITIONS.length);
assert.equal(manifest.tools.length, TOOL_DEFINITIONS.length);
assert.deepEqual(
  manifest.tools.map((tool) => tool.name),
  toolNames
);

for (const definition of TOOL_DEFINITIONS) {
  const publicDefinition = publicToolDefinition(definition);
  const manifestTool = manifest.tools.find((tool) => tool.name === definition.name);

  assert.ok(manifestTool, `Manifest missing tool: ${definition.name}`);
  assert.deepEqual(manifestTool, publicDefinition);
  assert.equal(typeof manifestTool.category, "string", `${definition.name} category`);
  assert.notEqual(manifestTool.category, "", `${definition.name} category`);
  assert.equal(typeof manifestTool.outputShape, "string", `${definition.name} outputShape`);
  assert.notEqual(manifestTool.outputShape, "", `${definition.name} outputShape`);
  assert.equal(typeof manifestTool.risk, "string", `${definition.name} risk`);
  assert.notEqual(manifestTool.risk, "", `${definition.name} risk`);
  assert.equal(typeof manifestTool.readOnly, "boolean", `${definition.name} readOnly`);
  assert.equal(typeof manifestTool.requiresTrustedSession, "boolean", `${definition.name} requiresTrustedSession`);
  assert.equal(typeof manifestTool.directMcpExposure, "boolean", `${definition.name} directMcpExposure`);
  assert.equal(typeof manifestTool.fallbackCallable, "boolean", `${definition.name} fallbackCallable`);
  assert.deepEqual(
    manifestTool.inputKeys,
    Object.keys(definition.inputSchema ?? {}).sort(),
    `${definition.name} inputKeys`
  );
}

const fallbackTool = manifest.tools.find((tool) => tool.name === "call_bridge_tool");
assert.equal(fallbackTool.fallbackCallable, false);
for (const tool of manifest.tools.filter((entry) => entry.name !== "call_bridge_tool")) {
  assert.equal(tool.fallbackCallable, true, `${tool.name} should be fallback-callable`);
}

for (const name of highLevelReadTools) {
  const tool = manifest.tools.find((entry) => entry.name === name);
  assert.ok(tool, `Manifest missing high-level read tool: ${name}`);
  assert.equal(tool.category, "live-read", `${name} category`);
  assert.equal(tool.risk, "read", `${name} risk`);
  assert.equal(tool.readOnly, true, `${name} readOnly`);
  assert.equal(tool.requiresTrustedSession, true, `${name} trusted session gate`);
  assert.equal(tool.directMcpExposure, true, `${name} direct MCP exposure`);
  assert.equal(tool.fallbackCallable, true, `${name} fallback callable`);
}

for (const name of transactionTools) {
  const tool = manifest.tools.find((entry) => entry.name === name);
  assert.ok(tool, `Manifest missing transaction tool: ${name}`);
  assert.equal(tool.category, "transaction", `${name} category`);
  assert.equal(tool.requiresTrustedSession, true, `${name} trusted session gate`);
  assert.equal(tool.directMcpExposure, true, `${name} direct MCP exposure`);
  assert.equal(tool.fallbackCallable, true, `${name} fallback callable`);
}

const journalPlanTool = manifest.tools.find((entry) => entry.name === "plan_journal_changes");
assert.equal(journalPlanTool.risk, "read");
assert.equal(journalPlanTool.readOnly, true);

const scenePlanTool = manifest.tools.find((entry) => entry.name === "plan_scene_changes");
assert.equal(scenePlanTool.risk, "read");
assert.equal(scenePlanTool.readOnly, true);
assert.deepEqual(scenePlanTool.inputKeys, ["changes", "sceneId", "sceneName"]);

const applyPlanTool = manifest.tools.find((entry) => entry.name === "apply_bridge_plan");
assert.equal(applyPlanTool.risk, "write");
assert.equal(applyPlanTool.readOnly, false);

const client = new Client({ name: "foundry-codex-bridge-manifest", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/mcp.js"],
  cwd: projectRoot,
  stderr: "pipe",
  env: {
    ...process.env,
    CODEX_FOUNDRY_BRIDGE_TOKEN: process.env.CODEX_FOUNDRY_BRIDGE_TOKEN || "manifest-test-token",
    FOUNDRY_BRIDGE_PORT: "30125"
  }
});

try {
  await client.connect(transport);
  const mcpToolList = await client.listTools();
  const mcpToolsByName = new Map(mcpToolList.tools.map((tool) => [tool.name, tool]));

  assert.deepEqual(
    mcpToolList.tools.map((tool) => tool.name).sort(),
    [...toolNames].sort()
  );

  for (const tool of manifest.tools) {
    const mcpTool = mcpToolsByName.get(tool.name);
    assert.ok(mcpTool, `MCP missing tool: ${tool.name}`);
    assert.deepEqual(
      Object.keys(mcpTool.inputSchema?.properties ?? {}).sort(),
      tool.inputKeys,
      `${tool.name} MCP input keys`
    );
  }

  const fallbackArgsSchema = mcpToolsByName.get("call_bridge_tool").inputSchema.properties.args;
  assert.equal(fallbackArgsSchema.type, "object");
  assert.equal(fallbackArgsSchema.additionalProperties.constructor, Object);
  assert.equal(fallbackArgsSchema.propertyNames.type, "string");
} finally {
  await client.close();
}

const readme = fs.readFileSync(path.join(projectRoot, "README.md"), "utf8");
assert.match(readme, /docs\/V1_RELEASE_AUDIT_AND_PLAN\.md/);
assert.match(readme, /docs\/bridge-capabilities\.json/);
assert.match(readme, /call_bridge_tool/);
assert.match(readme, /direct MCP/i);

console.log("Manifest parity checks passed.");
