---
name: dilucidate
description: Weekly memory graph analysis. Links related memories, flags contradictions, writes synthesis engrams for clusters, backfills tags, and surfaces decaying memories. Run when the user invokes /dilucidate.
disable-model-invocation: true
user-invocable: true
effort: high
---

# /dilucidate — Memory Graph Analysis

Run a two-phase pipeline: **Analyze** (read-only) then **Act** (write), with a user approval gate between them.

Always write all output — engram content, summaries, tags, reports — in **English**.

---

## Phase 1: Analyze (read-only)

### Step 1 — Early exit check

Call `get_dilucidate_meta`. If it returns a non-null `meta`:
- Get the current engram count via `list_engrams`
- If `currentCount - meta.engramCountAtLastRun < 5`, tell the user:
  ```
  Only N new memories since last dilucidation (YYYY-MM-DD).
  Come back when you have at least 5 new memories.
  ```
  Then stop.

If `meta` is null, this is the first run — proceed regardless.

### Step 2 — Semantic clustering

Call `list_engrams` (no filters) — keep this result; it is reused in Steps 5 and 6 without calling it again. Note the `abstract` field on each entry.

Call `cluster_memories` with:
- `threshold: 0.72` (default)
- `minSize: 3`
- `since`: the `lastRun` date from meta (or omit for first run)

Note the clusters and `missingLinks` within each cluster.

### Step 3 — Contradiction detection

For each cluster with 3+ engrams:
1. Call `read_engram` for each engram in the cluster
2. Analyze whether any two engrams contain opposing conclusions, decisions, or recommendations
3. Two engrams contradict if they recommend different approaches to the same problem, or if a later one reverses an earlier decision without acknowledging it
4. Record each contradiction as `{ engramA: UUID, engramB: UUID, summary: "one-line description" }`

Note: a summary engram cannot contradict its own source engrams — skip those.

### Step 4 — Synthesis candidates

Clusters with 5+ engrams are candidates for a synthesis engram. For each:
1. Read all engrams in the cluster
2. Identify what emerges from reading them *together* — cross-cutting patterns, the overall picture, how the pieces relate to each other — that is not visible from any single engram alone. Do not compress or replace the source engrams. The synthesis adds a new layer of understanding on top of them; all detail remains in the originals.

### Step 5 — Tag audit

The `list_engrams` result from Step 2 is already available. For each engram where `tags` is absent or `[]`:
1. Check the `abstract` field — if it is present and detailed enough, propose 2–4 relevant tags directly from the abstract (e.g. `"psychology"`, `"career"`, `"relationships"`) without calling `read_engram`
2. Only call `read_engram` if the abstract is absent or too sparse to determine good tags

### Step 6 — Decay scoring

For each engram from the `list_engrams` result in Step 2:

```
daysSinceDate = days between engram date and today
recencyScore = 1 / (1 + daysSinceDate / 30)
```

Read the engram to count wikilinks in its `## Related Memories` section. Let `maxLinks` be the highest link count across all engrams.

```
connectivityScore = linkCount / max(maxLinks, 1)
decayScore = 1 - (0.6 * recencyScore + 0.4 * connectivityScore)
```

Flag:
- **Orphans**: decayScore > 0.8 AND linkCount = 0 AND daysSinceDate > 30
- **Stale**: decayScore > 0.7 AND daysSinceDate > 60

These are informational only — never auto-delete.

### Step 7 — Present report and wait for approval

Present the report as plain text in this structure:

---
**Dilucidation Report — YYYY-MM-DD**

New memories since last run: N

**Clusters (N found)**
- "Theme" — N engrams, N missing links
- "Theme" — N engrams, synthesis candidate

**Contradictions (N found)**
- "Summary" (date A) ↔ (date B)

**Synthesis candidates (N)**
- "Theme" cluster — N engrams

**Tags (N engrams with empty tags)**
- Title → proposed, tags

**Decay**
- N orphans (>30d, 0 links): "title", ...
- N stale engrams

**Proposed actions**
1. Create N wikilinks across N clusters
2. Save N contradiction engrams
3. Save N synthesis engrams
4. Backfill tags for N engrams

Proceed? [y / n / specify which steps to skip]

---

**Wait for explicit user approval before proceeding to Phase 2.**

---

## Phase 2: Act (write, only after approval)

### Step 8 — Create missing wikilinks

For each `missingLink` from the cluster output:
- Call `update_engram` with `id: link.from, addWikilinks: [link.to]`
- Call `update_engram` with `id: link.to, addWikilinks: [link.from]`

### Step 9 — Save contradiction engrams

For each detected contradiction, call `save_memory` with:
- `type: "contradiction"`
- `title`: the contradiction summary (e.g. "Auth strategy: JWT vs session cookies")
- `content`: a markdown body with both sides clearly stated:

```markdown
## Conflicting Positions

**Position A** — [[date/filename-of-engram-A]]
Summary of what engram A says.

**Position B** — [[date/filename-of-engram-B]]
Summary of what engram B says.

These positions conflict. One needs to be resolved or superseded.
```

The wikilink engine will automatically link back to both referenced engrams.

### Step 10 — Save synthesis engrams

For each synthesis candidate, call `save_memory` with:
- `type: "summary"`
- `title`: cluster theme + " — Synthesis" (e.g. "Psychological Architecture — Synthesis")
- `content`: the synthesis prepared in Step 4 — the cross-cutting patterns and overall picture that emerge from reading the cluster together. Written in English, third person. Link to each source engram using `[[date/filename]]` so readers can navigate to the full detail. Do not try to compress or replace the source engrams — they remain the authoritative record.

### Step 11 — Backfill tags

For each engram with proposed tags:
- Call `update_engram` with `id: engramId, addTags: [proposed, tags]`

### Step 12 — Update metadata

Build the updated meta JSON and call `update_dilucidate_meta`:

```json
{
  "lastRun": "<ISO timestamp>",
  "engramCountAtLastRun": <current total>,
  "stats": {
    "wikilinksCreated": N,
    "contradictionsFound": N,
    "summariesWritten": N,
    "tagsBackfilled": N,
    "orphansFlagged": N
  },
  "history": [<previous history entries>, <new entry for this run>]
}
```

### Step 13 — Print final summary

Dilucidation complete:
- N wikilinks created
- N contradictions saved
- N synthesis engrams written
- N engrams tagged
- N orphans flagged (not deleted — review manually)
