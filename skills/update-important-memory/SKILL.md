---
name: update-important-memory
description: Review all saved Engrams and rewrite IMPORTANT.md with a synthesized, up-to-date profile of the user. Run when the user invokes /update-important-memory. Never run automatically — this is a deliberate, user-triggered operation.
disable-model-invocation: true
user-invocable: true
effort: high
compatibility: Requires the Engram MCP server to be running (http://localhost:7384/mcp).
metadata:
  author: engram
  version: "0.1"
---

# Update Important Memory

You have been explicitly asked to rebuild the user's persistent memory profile from all saved Engrams.

## Purpose

IMPORTANT.md is an evergreen profile of the user. It is loaded at the start of every session via /prefill. It should capture durable facts — not a log of past conversations. Length should match the amount of relevant information: if the user has a lot of important context across many domains, the file should reflect that fully. Do not trim detail to hit a word target.

## Steps

1. **List all Engrams** by calling `list_engrams` (no filters). Note the total count, date range, and the `abstract` field on each entry.

2. **Read the current IMPORTANT.md** via `get_important_context`. Keep it in mind as a baseline.

3. **Identify high-value engrams** from the list. Use each engram's `abstract` (returned by `list_engrams`) as a first-pass filter — read the abstract carefully and decide whether the full body is needed. Use `read_engrams` in batches (up to 20 IDs) for efficiency; use `read_engram` for follow-up on specific IDs when needed. Read full content for any engram where:
   - The abstract is absent (older engrams may not have one)
   - The abstract suggests content that goes beyond what IMPORTANT.md already captures
   - The abstract is ambiguous about details that matter for the profile

   You do **not** need to call `read_engram` for engrams whose abstract clearly shows they are already fully represented in the existing IMPORTANT.md (e.g. a synthesis engram whose themes are already captured).

4. **Search for key themes** by calling `search_memory` with several targeted queries to catch anything the abstract pass may have missed:
   - `"user preferences and working style"`
   - `"technical stack and tools"`
   - `"ongoing projects and goals"`
   - `"personal background and role"`
   - `"important decisions and constraints"`

   These are conceptual queries — use the default `mode: "semantic"`.

   If a specific named project, tool, technology, or person surfaced during the abstract scan in step 3, add a targeted query for it using `mode: "hybrid"`. The keyword pass gives exact-match lift for proper nouns that the vector might rank below thematically related but less relevant results.

   Read any result not already covered in step 3 (prefer batched `read_engrams` when multiple IDs are pending).

5. **Synthesize** the findings into a new IMPORTANT.md. Always write in **English**, regardless of the language of the source engrams. Write in **third person** — this file is read by a future AI model, not by the user. Use whatever name or pronoun the user goes by (e.g. "Alex prefers…", "They are working on…"), never "You prefer…".

   **Preserve everything that matters.** The existing IMPORTANT.md is the baseline — treat every fact in it as worth keeping unless a newer engram explicitly contradicts or supersedes it. New engrams add to the profile; they do not replace it. Length is determined by the content, not a word limit. A richer profile is better than a shorter one.

6. **Call `update_important_context`** with the synthesized content.

7. **Confirm** to the user: tell them what changed at a high level (e.g., "Updated to reflect your new role and the Engram project"). Mention how many engrams were reviewed (full reads) vs. scanned by abstract only.

## Rules

- Do not pad with generic filler. Every sentence should be something a future session could act on.
- The existing IMPORTANT.md is additive input, not a draft to shorten. Preserve all facts it contains unless directly contradicted by newer engrams.
- Prefer the most recent information when facts conflict across Engrams.
- Do not include ephemeral details (what you discussed today, specific error messages, etc.).
- Keep it stable: the profile should change slowly over months, not session to session.
- Never truncate for length. If the profile is long because the user's context is rich, that is correct behaviour.
