import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { z } from "zod";

const ConfigSchema = z.object({
  vault: z.object({
    path: z.string().min(1),
  }),
  server: z
    .object({
      port: z.number().int().min(1024).max(65535).default(7384),
      https: z.boolean().default(false),
      certFile: z.string().optional(),
      keyFile: z.string().optional(),
    })
    .default({}),
  chroma: z
    .object({
      host: z.string().url().default("http://localhost:8000"),
      collection: z.string().default("engrams"),
    })
    .default({}),
  wikilinks: z
    .object({
      threshold: z.number().min(0).max(1).default(0.72),
      maxLinks: z.number().int().min(1).max(20).default(5),
    })
    .default({}),
  embedding: z
    .object({
      queryCacheSize: z.number().int().min(0).max(1024).default(64),
      overheadBuffer: z.number().min(0.1).max(0.5).default(0.25),
      quant: z.enum(["q8_0", "q6_k", "q5_k_m", "q4_k_m"]).optional(),
      batchSize: z.number().int().min(1).max(256).optional(),
      batchMaxChars: z.number().int().min(1000).optional(),
      vllm: z
        .object({
          host: z.string().url().default("http://localhost:8001"),
          healthTimeout: z.number().int().min(1000).max(30000).default(2000),
        })
        .default({}),
    })
    .default({}),
  watcher: z
    .object({
      enabled: z.boolean().default(true),
      libreOfficePath: z.string().default("libreoffice"),
    })
    .default({}),
captioning: z
    .object({
      provider: z.enum(["auto", "ollama", "openai"]).default("auto"),
      host: z.string().url().default("http://localhost:11434/v1"),
      model: z.string().default("engram-caption"),
      prompt: z.string().default("Describe this image concisely for search and retrieval."),
      fallbackHost: z.string().url().optional(),
      fallbackModel: z.string().optional(),
      fallbackProvider: z.enum(["ollama", "openai"]).optional(),
    })
    .optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(configPath?: string): Config {
  const paths = [
    configPath,
    join(process.cwd(), "config.local.json"),
    join(process.cwd(), "config.json"),
    join(process.cwd(), "..", "config.local.json"),
    join(process.cwd(), "..", "config.json"),
  ].filter(Boolean) as string[];

  for (const p of paths) {
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, "utf-8"));
      const result = ConfigSchema.safeParse(raw);
      if (!result.success) {
        throw new Error(`Invalid config at ${p}:\n${result.error.message}`);
      }
      return result.data;
    }
  }

  throw new Error(
    "No config.json found. Copy config.json from the repo root and set vault.path."
  );
}
