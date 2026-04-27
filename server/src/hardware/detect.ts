import { execSync, spawnSync } from "child_process";
import { readFileSync, existsSync } from "fs";

export type HardwarePlatform =
  | "apple-silicon"
  | "nvidia-blackwell"
  | "nvidia-cuda"
  | "cpu";

export interface HardwareInfo {
  platform: HardwarePlatform;
  totalMemoryGB: number;
  availableMemoryGB: number;
  gpuName?: string;
  computeCapability?: number;
}

export function detectHardware(): HardwareInfo {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return detectAppleSilicon();
  }

  const nvidia = detectNvidia();
  if (nvidia) return nvidia;

  return detectCPU();
}

function detectAppleSilicon(): HardwareInfo {
  const totalGB = sysctlMemory();
  return {
    platform: "apple-silicon",
    totalMemoryGB: totalGB,
    // Unified memory: GPU and CPU share the same pool. Reserve 15% for OS.
    availableMemoryGB: totalGB * 0.85,
  };
}

function detectNvidia(): HardwareInfo | null {
  const result = spawnSync("nvidia-smi", [
    "--query-gpu=name,memory.total,compute_cap",
    "--format=csv,noheader,nounits",
  ]);
  if (result.status !== 0 || !result.stdout) return null;

  const line = result.stdout.toString().trim().split("\n")[0];
  const parts = line.split(", ").map((s: string) => s.trim());
  if (parts.length < 3) return null;

  const [name, vramMBStr, ccStr] = parts;
  const vramGB = parseInt(vramMBStr) / 1024;
  const cc = parseFloat(ccStr);

  return {
    platform: cc >= 10.0 ? "nvidia-blackwell" : "nvidia-cuda",
    totalMemoryGB: vramGB,
    availableMemoryGB: vramGB,
    gpuName: name,
    computeCapability: cc,
  };
}

function detectCPU(): HardwareInfo {
  const totalGB = process.platform === "linux" ? linuxMemory() : sysctlMemory();
  return {
    platform: "cpu",
    totalMemoryGB: totalGB,
    availableMemoryGB: totalGB * 0.7,
  };
}

function sysctlMemory(): number {
  try {
    const out = execSync("sysctl -n hw.memsize", { encoding: "utf-8" }).trim();
    return parseInt(out) / 1024 ** 3;
  } catch {
    return 8;
  }
}

function linuxMemory(): number {
  try {
    const meminfo = readFileSync("/proc/meminfo", "utf-8");
    const match = meminfo.match(/MemTotal:\s+(\d+)/);
    return match ? parseInt(match[1]) / 1024 ** 2 : 8;
  } catch {
    return 8;
  }
}
