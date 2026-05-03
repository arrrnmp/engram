import { join } from "path";

export const CHROMA_PORT = 8000;

async function isChromaRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${CHROMA_PORT}/api/v2/heartbeat`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch { return false; }
}

export async function ensureChromaRunning(root: string): Promise<Bun.Subprocess | null> {
  if (await isChromaRunning()) {
    console.log(`[engram] ChromaDB already running on port ${CHROMA_PORT}`);
    return null;
  }

  console.log(`[engram] Starting ChromaDB on port ${CHROMA_PORT}...`);
  const proc = Bun.spawn(
    ["uv", "run", "chroma", "run", "--host", "0.0.0.0", "--port", String(CHROMA_PORT), "--path", join(root, ".chroma-data")],
    {
      cwd: root,
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
      env: { ...process.env, RUST_LOG: "warn" },
    }
  );

  let ready = false;
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(500);
    if (await isChromaRunning()) { ready = true; break; }
  }
  if (!ready) {
    console.error("[engram] ERROR: ChromaDB failed to start within 10 seconds.");
    process.exit(1);
  }
  console.log("[engram] ChromaDB ready.");
  return proc;
}
