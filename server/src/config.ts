import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { z } from "zod";

const EmbeddingProviderSchema = z.enum(["auto", "ollama", "mlx", "nvidia", "openai"]);

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
      provider: EmbeddingProviderSchema.default("auto"),
      model: z.enum(["8b", "4b"]).optional(),
      overheadBuffer: z.number().min(0.1).max(0.5).default(0.25),
      ollama: z
        .object({ host: z.string().url().default("http://localhost:11434") })
        .default({}),
      mlx: z
        .object({ host: z.string().url().default("http://localhost:8080") })
        .default({}),
      nvidia: z
        .object({ host: z.string().url().default("http://localhost:8001") })
        .default({}),
      openai: z
        .object({
          apiKey: z.string().min(1),
          model: z
            .enum(["text-embedding-3-small", "text-embedding-3-large"])
            .default("text-embedding-3-small"),
        })
        .optional(),
    })
    .default({}),
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
