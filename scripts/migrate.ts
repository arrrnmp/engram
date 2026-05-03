#!/usr/bin/env bun
/**
 * Interactive migration script for re-embedding all engrams.
 * Used when the embedding model changes and vector dimensions no longer match.
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { join } from "path";
import { loadConfig } from "../server/src/config.js";
import { EngramChroma } from "../server/src/chroma.js";
import { Vault, parseEngram } from "../server/src/vault.js";
import { createEmbeddingProvider } from "../server/src/embeddings/index.js";
import { ensureChromaRunning, CHROMA_PORT } from "./ensure-chroma.js";
import { ensureEmbedServer } from "./ensure-embed-server.js";

const EMBED_PORT = 8001;

const ROOT = join(import.meta.dir, "..");
const SERVER = join(ROOT, "server");

function log(msg: string) { console.log(`[migrate] ${msg}`); }
function die(msg: string): never { console.error(`[migrate] ERROR: ${msg}`); process.exit(1); }

async function confirm(prompt: string): Promise<boolean> {
  const { createInterface } = await import("readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}

async function main() {
  // Load config from server directory
  process.chdir(SERVER);
  const config = loadConfig();
  const vault = new Vault(config.vault.path);
  const chroma = new EngramChroma(config);

  const startedChroma = await ensureChromaRunning(ROOT);
  const startedEmbed = await ensureEmbedServer(ROOT);

  const cleanup = () => {
    if (startedChroma) Bun.spawnSync(["lsof", "-ti", String(CHROMA_PORT)], { stdout: "pipe" });
    if (startedChroma) {
      const r = Bun.spawnSync(["lsof", "-ti", String(CHROMA_PORT)], { stdout: "pipe" });
      const pid = r.stdout.toString().trim();
      if (pid) { process.kill(Number(pid)); log("Stopped ChromaDB."); }
    }
    if (startedEmbed) {
      const r = Bun.spawnSync(["lsof", "-ti", String(EMBED_PORT)], { stdout: "pipe" });
      const pid = r.stdout.toString().trim();
      if (pid) { process.kill(Number(pid)); log("Stopped embedding server."); }
    }
  };

  log("Connecting to ChromaDB...");
  await chroma.init();

  const actualDims = await chroma.getDimensions();
  log(`Current ChromaDB dimensions: ${actualDims ?? "empty collection"}`);

  log("Loading embedding provider...");
  const embedder = await createEmbeddingProvider(config);
  const { provider, model } = embedder.modelInfo();
  const expectedDims = embedder.expectedDimensions();
  log(`Embedding provider: ${provider}/${model} (${expectedDims} dims)`);

  if (actualDims === expectedDims) {
    log(`Dimensions already match (${expectedDims}). No migration needed.`);
    const force = process.argv.includes("--force");
    if (!force) {
      process.exit(0);
    }
    log("--force flag set, proceeding anyway.");
  }

  // List all engrams from vault
  const entries = vault.listEngrams();
  log(`Found ${entries.length} engram(s) in vault.`);

  if (entries.length === 0) {
    log("No engrams to migrate. Exiting.");
    process.exit(0);
  }

  if (!await confirm(`Re-embed all ${entries.length} engram(s) with ${provider}/${model}?`)) {
    log("Aborted.");
    process.exit(0);
  }

  // Drop and recreate the collection with the new dimension
  if (actualDims !== null && actualDims !== expectedDims) {
    log(`Dimension change: ${actualDims} → ${expectedDims}. Recreating collection...`);
    await chroma.recreate();
  }

  let success = 0;
  let failed = 0;

  for (const entry of entries) {
    if (!entry.id || !entry.relativePath) continue;
    try {
      const raw = vault.readEngram(entry.relativePath);
      const { body } = parseEngram(raw);
      const embedding = await embedder.embed(body, { taskInstruction: "Represent the following document for retrieval: " });
      await chroma.upsert(
        {
          id: entry.id,
          content: body,
          title: entry.title,
          date: entry.date,
          filename: entry.filename,
          relativePath: entry.relativePath,
          vaultPath: vault.root,
          abstract: entry.abstract,
          type: entry.type,
        },
        embedding
      );
      success++;
      if (success % 10 === 0) log(`Progress: ${success}/${entries.length}`);
    } catch (err) {
      failed++;
      log(`Failed: ${entry.relativePath} — ${err}`);
    }
  }

  log(`Migration complete: ${success} succeeded, ${failed} failed.`);

  // Write updated collection meta
  const metaPath = join(vault.root, ".engram-collection-meta.json");
  writeFileSync(
    metaPath,
    JSON.stringify({
      provider,
      model,
      dimensions: expectedDims,
      migratedAt: new Date().toISOString(),
    }, null, 2),
    "utf-8"
  );
  log(`Updated ${metaPath}`);

  // Stop services we started
  cleanup();

  // Cleanup backup flag
  if (process.argv.includes("--cleanup-backup")) {
    log("--cleanup-backup: backup data can be removed manually from ChromaDB if needed.");
  }
}

main().catch(die);
