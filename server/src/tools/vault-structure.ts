import { readdirSync, statSync, existsSync } from "fs";
import { join, resolve } from "path";
import type { Vault } from "../vault.js";

export interface VaultNode {
  name: string;
  type: "dir" | "file";
  children?: VaultNode[];
  fileType?: "markdown" | "image" | "pdf" | "video" | "other";
  truncated?: boolean;
}

export interface VaultStructureResult {
  tree: VaultNode[];
  summary: string;
}

export const GetVaultStructureInput = {};

const SKIP_NAMES = new Set(["IMPORTANT.md", ".chroma-data", ".dilucidate-meta.json", ".engram-body-hashes.json", ".engram-media-cache.json", ".engram-collection-meta.json"]);

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif", ".avif"]);
const PDF_EXTENSIONS = new Set([".pdf"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mpeg", ".mpg"]);

function getFileType(name: string): "markdown" | "image" | "pdf" | "video" | "other" {
  const ext = name.toLowerCase().slice(name.lastIndexOf("."));
  if (ext === ".md") return "markdown";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (PDF_EXTENSIONS.has(ext)) return "pdf";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return "other";
}

function scanDir(dir: string, vaultRoot: string, maxDepth: number, currentDepth: number): VaultNode[] {
  if (currentDepth >= maxDepth) return [];
  const nodes: VaultNode[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (SKIP_NAMES.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      const children = currentDepth + 1 < maxDepth
        ? scanDir(fullPath, vaultRoot, maxDepth, currentDepth + 1)
        : undefined;
      const node: VaultNode = {
        name: entry.name,
        type: "dir",
        ...(children !== undefined ? { children } : { truncated: true }),
      };
      nodes.push(node);
    } else {
      nodes.push({
        name: entry.name,
        type: "file",
        fileType: getFileType(entry.name),
      });
    }
  }

  return nodes;
}

function countNodes(nodes: VaultNode[]): { dirs: number; markdown: number; images: number; pdfs: number; videos: number; other: number } {
  let dirs = 0, markdown = 0, images = 0, pdfs = 0, videos = 0, other = 0;
  for (const node of nodes) {
    if (node.type === "dir") {
      dirs++;
      if (node.children) {
        const sub = countNodes(node.children);
        dirs += sub.dirs;
        markdown += sub.markdown;
        images += sub.images;
        pdfs += sub.pdfs;
        videos += sub.videos;
        other += sub.other;
      }
    } else {
      switch (node.fileType) {
        case "markdown": markdown++; break;
        case "image": images++; break;
        case "pdf": pdfs++; break;
        case "video": videos++; break;
        default: other++; break;
      }
    }
  }
  return { dirs, markdown, images, pdfs, videos, other };
}

function buildSummary(nodes: VaultNode[]): string {
  const c = countNodes(nodes);
  const parts: string[] = [];
  if (c.dirs) parts.push(`${c.dirs} director${c.dirs === 1 ? "y" : "ies"}`);
  if (c.markdown) parts.push(`${c.markdown} markdown file${c.markdown === 1 ? "" : "s"}`);
  if (c.images) parts.push(`${c.images} image${c.images === 1 ? "" : "s"}`);
  if (c.pdfs) parts.push(`${c.pdfs} PDF${c.pdfs === 1 ? "" : "s"}`);
  if (c.videos) parts.push(`${c.videos} video${c.videos === 1 ? "" : "s"}`);
  if (c.other) parts.push(`${c.other} other file${c.other === 1 ? "" : "s"}`);
  return parts.join(", ");
}

export function getVaultStructure(vault: Vault, maxDepth: number = 5): VaultStructureResult {
  if (!existsSync(vault.root)) {
    return { tree: [], summary: "Vault directory does not exist." };
  }

  const tree = scanDir(vault.root, vault.root, maxDepth, 0);
  const summary = buildSummary(tree);

  return { tree, summary };
}

export function sanitizeFolderPath(folder: string, vaultRoot: string): string {
  const stripped = folder.replace(/^\/+|\/+$/g, "");
  const segments = stripped.split("/").filter((s) => s.length > 0 && s !== "." && s !== "..");
  const clean = segments.join("/");
  const resolved = resolve(vaultRoot, clean);
  const vaultResolved = resolve(vaultRoot);
  if (!resolved.startsWith(vaultResolved + "/") && resolved !== vaultResolved) {
    throw new Error(`Folder path escapes vault root: ${folder}`);
  }
  return clean;
}
