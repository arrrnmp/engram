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

1. **List all Engrams** by calling `list_engrams` (no filters). Note the total count and date range.

2. **Read the current IMPORTANT.md** via `get_important_context`. Keep it in mind as a baseline.

3. **Search for key themes** by calling `search_memory` with several targeted queries to surface the most relevant engrams. Run multiple searches covering different aspects:
   - `"user preferences and working style"`
   - `"technical stack and tools"`
   - `"ongoing projects and goals"`
   - `"personal background and role"`
   - `"important decisions and constraints"`

4. **Read the full content** of all engrams using `read_engram`. Excerpts from `search_memory` are truncated — full reads are required to avoid losing detail. Do not skip engrams; the current IMPORTANT.md may contain facts (hardware, homelab, projects, relationships) that came from engrams not surfaced by the theme searches.

5. **Synthesize** the findings into a new IMPORTANT.md. Always write in **English**, regardless of the language of the source engrams. Write in **third person** — this file is read by a future AI model, not by the user. Use whatever name or pronoun the user goes by (e.g. "Alex prefers…", "They are working on…"), never "You prefer…".

   **Preserve everything that matters.** The existing IMPORTANT.md is the baseline — treat every fact in it as worth keeping unless a newer engram explicitly contradicts or supersedes it. New engrams add to the profile; they do not replace it. Length is determined by the content, not a word limit. A richer profile is better than a shorter one.

6. **Call `update_important_context`** with the synthesized content.

7. **Confirm** to the user: tell them what changed at a high level (e.g., "Updated to reflect your new role and the Engram project"). Mention how many engrams were reviewed.

## Rules

- Do not pad with generic filler. Every sentence should be something a future session could act on.
- The existing IMPORTANT.md is additive input, not a draft to shorten. Preserve all facts it contains unless directly contradicted by newer engrams.
- Prefer the most recent information when facts conflict across Engrams.
- Do not include ephemeral details (what you discussed today, specific error messages, etc.).
- Keep it stable: the profile should change slowly over months, not session to session.
- Never truncate for length. If the profile is long because the user's context is rich, that is correct behaviour.
