# Dilucidate Routine

Weekly vault organization: cluster analysis, contradiction detection, tag backfill, and synthesis engram creation.

## Configuration

| Field | Value |
|-------|-------|
| Name | `vault-dilucidate` |
| Schedule | Weekly (Sunday, 10:00 AM) |
| Model | Sonnet 4.6 |
| Permission | Accept edits |
| Folder | `Documents/engram` |

## Instructions

You are running the weekly dilucidate routine for the Engram memory vault. Your job is to analyze the vault for organizational improvements and execute them.

## MCP tools available

You have an Engram MCP server running at localhost:7384/mcp. Use these tools:

- `list_engrams({ date_range?, limit, offset })` — List all engrams. Returns id, date, filename, title, abstract, type for each.
- `read_engram({ id })` — Read full content for a single engram by UUID.
- `read_engrams({ ids })` — Batch read multiple engrams (up to 20).
- `cluster_memories({ threshold?, minSize?, since? })` — Run clustering. Returns clusters with engramIds, avgSimilarity, missingLinks.
- `update_engram({ id, setAbstract?, setContent?, editContent?, addTags?, addWikilinks? })` — Update an engram.
- `save_memory({ title, abstract, content, date?, type?, folder? })` — Save a new engram.
- `get_dilucidate_meta()` — Get metadata from last dilucidate run.
- `update_dilucidate_meta({ lastRun, engramCountAtLastRun, stats, note })` — Write updated metadata.
- `get_vault_structure()` — Get vault directory tree.

## The two-phase process

### Phase 1: Analyze (read-only)

1. **Early exit**: Call get_dilucidate_meta and list_engrams. If fewer than 5 new engrams since lastRun, write `.dilucidate-plan.json` to the vault root with `{ version: 1, earlyExit: true, earlyExitReason: "..." }` and stop.

2. **Cluster**: Call cluster_memories(threshold=0.72, minSize=3, since=lastRun). Keep the result.

3. **Contradictions**: For clusters with >=3 engrams, read_engram each one. Look for opposing conclusions or reversed decisions on the same topic. For each contradiction, record both positions with enough detail to write a contradiction engram later.

4. **Syntheses**: For clusters with >=5 engrams, identify cross-cutting patterns. Draft a full synthesis engram (title, abstract, content in English third person).

5. **Tags**: For engrams with empty tags, propose 2-4 tags based on abstracts. Tags should be lowercase, consistent across the vault. Only read_engram if the abstract is too sparse.

6. **Decay**: For each engram, compute: recencyScore = 1/(1 + daysSince/30), connectivityScore = linkCount/maxLinks, decayScore = 1 - (0.6*recency + 0.4*connectivity). Flag orphans (decayScore > 0.8, no links, >30d old) and stale (>0.7, >60d). Informational only.

7. **Write plan**: Save `.dilucidate-plan.json` to the vault root with all findings. Print a summary.

### Phase 2: Execute (writes)

Read `.dilucidate-plan.json`. If earlyExit is true, stop.

8. **Wikilinks**: For each missingLink, call update_engram for both directions (from->to and to->from with addWikilinks).

9. **Contradictions**: For each contradiction, call save_memory with type "contradiction". Include both positions in the content.

10. **Syntheses**: For each synthesis, call save_memory with type "summary".

11. **Tags**: For each tagAssignment, call update_engram with addTags.

12. **Meta**: Call update_dilucidate_meta with lastRun (ISO timestamp), engramCountAtLastRun (current count), stats object with wikilinksCreated/contradictionsFound/summariesWritten/tagsBackfilled/orphansFlagged counts, and note with summary.

13. **Cleanup**: Delete .dilucidate-plan.json from the vault root. Print final summary.

## Important constraints

- All engram content must be in English, third person ("they decided...", not "you decided...").
- Never auto-delete engrams, even decay-flagged ones.
- Save contradiction and synthesis engrams sequentially (so wikilinks cross-reference).
- Tags must be consistent — use the same tag for the same concept across engrams.
- If the plan file already exists from a previous run that crashed in Phase 2, resume from it instead of re-running Phase 1.
