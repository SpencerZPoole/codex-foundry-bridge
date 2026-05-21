#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { listBridgeTools } from "../src/tool-registry.js";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const MANIFEST_PATH = path.join(ROOT, "docs", "bridge-capabilities.json");

export function buildCapabilityManifest() {
  const registry = listBridgeTools();
  return {
    bridgeVersion: registry.bridgeVersion,
    registryVersion: registry.registryVersion,
    checksum: registry.checksum,
    toolCount: registry.toolCount,
    fallback: registry.fallback,
    tools: registry.tools
  };
}

function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function main() {
  const content = serializeManifest(buildCapabilityManifest());
  if (process.argv.includes("--check")) {
    const existing = fs.existsSync(MANIFEST_PATH)
      ? fs.readFileSync(MANIFEST_PATH, "utf8")
      : "";
    if (existing !== content) {
      console.error(`Capability manifest is out of date: ${MANIFEST_PATH}`);
      process.exit(1);
    }
    console.log(`Capability manifest is current: ${MANIFEST_PATH}`);
    return;
  }

  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, content, "utf8");
  console.log(`Wrote capability manifest: ${MANIFEST_PATH}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
