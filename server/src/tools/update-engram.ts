import { z } from "zod";
import type { EngramChroma } from "../chroma.js";
import type { Vault } from "../vault.js";
import type { VaultIndex } from "../vault-index.js";
import { updateEngramWikilinks } from "../vault.js";

export const UpdateEngramInput = z.object({
  id: z.string().uuid().describe("Engram UUID (as returned by list_engrams or search_memory)"),
  setAbstract: z
    .string()
    .min(1)
    .optional()
    .describe("Replace the abstract field in frontmatter with this value"),
  addTags: z
    .array(z.string().min(1).max(64))
    .optional()
    .describe("Tags to add to frontmatter — merged with any existing tags"),
  addWikilinks: z
    .array(z.string().uuid())
    .optional()
    .describe("UUIDs of other engrams to link to in the Related Memories section"),
});

export type UpdateEngramInput = z.infer<typeof UpdateEngramInput>;

export async function updateEngram(
  input: UpdateEngramInput,
  vault: Vault,
  vaultIndex: VaultIndex,
  chroma: EngramChroma
) {
  const location = await vaultIndex.resolveWithFallback(input.id, vault.root, chroma);
  if (!location) throw new Error(`Engram not found: ${input.id}`);

  let content = vault.readEngram(location.date, location.filename);
  let tagsAdded = 0;
  let wikilinksAdded = 0;

  if (input.setAbstract) {
    const escaped = input.setAbstract.replace(/\n/g, " ").replace(/"/g, '\\"').trim();
    if (/^abstract:\s*".*"$/m.test(content)) {
      content = content.replace(/^abstract:\s*".*"$/m, `abstract: "${escaped}"`);
    } else {
      // No abstract line yet — insert after the id line.
      content = content.replace(/^(id:\s*"[^"]+")$/m, `$1\nabstract: "${escaped}"`);
    }
  }

  if (input.addTags && input.addTags.length > 0) {
    const match = content.match(/^tags:\s*\[(.*?)\]/m);
    const existing = match?.[1]
      ? match[1].split(",").map((t) => t.trim().replace(/^"|"$/g, "")).filter(Boolean)
      : [];
    const merged = Array.from(new Set([...existing, ...input.addTags]));
    content = content.replace(
      /^tags:\s*\[.*?\]/m,
      `tags: [${merged.map((t) => `"${t}"`).join(", ")}]`
    );
    tagsAdded = merged.length - existing.length;
  }

  if (input.addWikilinks && input.addWikilinks.length > 0) {
    const newPaths: string[] = [];
    for (const targetId of input.addWikilinks) {
      const loc = vaultIndex.resolve(targetId);
      if (!loc) continue;
      const wikiPath = `${loc.date}/${loc.filename.replace(/\.md$/, "")}`;
      if (content.includes(`[[${wikiPath}]]`)) continue;
      newPaths.push(wikiPath);
      wikilinksAdded++;
    }
    if (newPaths.length > 0) {
      content = updateEngramWikilinks(content, newPaths);
    }
  }

  vault.updateEngram(location.date, location.filename, content);

  return {
    id: input.id,
    abstractSet: !!input.setAbstract,
    tagsAdded,
    wikilinksAdded,
    message: `Updated: ${input.setAbstract ? "abstract set, " : ""}${tagsAdded} tag(s) added, ${wikilinksAdded} wikilink(s) added`,
  };
}
