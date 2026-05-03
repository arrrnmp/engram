import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig } from "../config.js";

describe("loadConfig", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "engram-config-test-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns valid config when JSON is valid", () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({ vault: { path: "/tmp/test-vault" } })
    );

    const config = loadConfig();
    expect(config.vault.path).toBe("/tmp/test-vault");
    expect(config.server.port).toBe(7384); // default
    expect(config.chroma.host).toBe("http://localhost:8000"); // default
  });

  test("searches paths in order: config.local.json, config.json, parent dirs", () => {
    writeFileSync(
      join(tempDir, "config.local.json"),
      JSON.stringify({ vault: { path: "/local" } })
    );
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({ vault: { path: "/regular" } })
    );

    const config = loadConfig();
    expect(config.vault.path).toBe("/local"); // config.local.json takes precedence
  });

  test("falls back to config.json when config.local.json is missing", () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({ vault: { path: "/regular" } })
    );

    const config = loadConfig();
    expect(config.vault.path).toBe("/regular");
  });

  test("applies Zod defaults for missing optional fields", () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({
        vault: { path: "/tmp/v" },
      })
    );

    const config = loadConfig();
    expect(config.server.port).toBe(7384);
    expect(config.server.https).toBe(false);
    expect(config.chroma.collection).toBe("engrams");
    expect(config.wikilinks.threshold).toBe(0.72);
    expect(config.wikilinks.maxLinks).toBe(5);
    expect(config.embedding.queryCacheSize).toBe(64);
    expect(config.embedding.overheadBuffer).toBe(0.25);
    expect(config.watcher.enabled).toBe(true);
  });

  test("throws descriptive error on invalid JSON", () => {
    writeFileSync(join(tempDir, "config.json"), "{ invalid json");

    expect(() => loadConfig()).toThrow();
  });

  test("throws descriptive error on Zod validation failure (missing required field)", () => {
    writeFileSync(join(tempDir, "config.json"), JSON.stringify({}));

    expect(() => loadConfig()).toThrow("Invalid config");
  });

  test("throws on Zod validation failure (wrong type)", () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({
        vault: { path: "/tmp/v" },
        server: { port: "not-a-number" },
      })
    );

    expect(() => loadConfig()).toThrow("Invalid config");
  });

  test("handles missing files gracefully by falling back", () => {
    expect(() => loadConfig()).toThrow("No config.json found");
  });

  test("uses explicit configPath when provided", () => {
    const customPath = join(tempDir, "custom", "config.json");
    mkdirSync(join(tempDir, "custom"), { recursive: true });
    writeFileSync(customPath, JSON.stringify({ vault: { path: "/custom/vault" } }));

    const config = loadConfig(customPath);
    expect(config.vault.path).toBe("/custom/vault");
  });

  test("validates captioning fields when present", () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({
        vault: { path: "/tmp/v" },
        captioning: {
          provider: "auto",
          host: "http://localhost:8002/v1",
          maxTokens: 256,
          temperature: 0.7,
        },
      })
    );

    const config = loadConfig();
    expect(config.captioning?.provider).toBe("auto");
    expect(config.captioning?.maxTokens).toBe(256);
  });

  test("allows optional certFile and keyFile when https is false", () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({
        vault: { path: "/tmp/v" },
        server: { https: false, certFile: "/path/to/cert.pem" },
      })
    );

    const config = loadConfig();
    expect(config.server.https).toBe(false);
    expect(config.server.certFile).toBe("/path/to/cert.pem");
  });

  test("validates port range", () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({
        vault: { path: "/tmp/v" },
        server: { port: 80 },
      })
    );

    expect(() => loadConfig()).toThrow("Invalid config");
  });
});
