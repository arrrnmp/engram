---
name: update-important-memory
description: Review all saved Engrams and rewrite IMPORTANT.md with a synthesized, up-to-date profile of the user. Run when the user invokes /update-important-memory. Never run automatically — this is a deliberate, user-triggered operation.
compatibility: Requires the Engram MCP server to be running (http://localhost:7384/mcp).
metadata:
  author: engram
  version: "0.1"
---

# Update Important Memory

You have been explicitly asked to rebuild the user's persistent memory profile from all saved Engrams.

## Purpose

IMPORTANT.md is a concise, evergreen profile of the user. It is loaded at the start of every session via /prefill. It should capture durable facts — not a log of past conversations.

## Steps

1. **List all Engrams** by calling `list_engrams` (no filters). Note the total count and date range.

2. **Read the current IMPORTANT.md** via `get_important_context`. Keep it in mind as a baseline.

3. **Search for key themes** by calling `search_memory` with several targeted queries to surface the most relevant engrams. Run multiple searches covering different aspects:
   - `"user preferences and working style"`
   - `"technical stack and tools"`
   - `"ongoing projects and goals"`
   - `"personal background and role"`
   - `"important decisions and constraints"`

4. **Read the full content** of the top results using `read_engram` (pass the `id` from search results). Excerpts from `search_memory` are truncated — reading in full ensures you don't miss important context. Prioritise the most recent and highest-similarity results; you don't need to read every engram.

   See [references/strategy.md](references/strategy.md) for guidance on what to include.

4. **Synthesize** the findings into a new IMPORTANT.md. Write in **third person** — this file is read by a future AI model, not by the user ("Aaron prefers…", "Aaron is working on…", never "You prefer…"). Keep it under 400 words. Focus on what a future AI assistant genuinely needs to know to be useful to this user.

5. **Call `update_important_context`** with the synthesized content.

6. **Confirm** to the user: tell them what changed at a high level (e.g., "Updated to reflect your new role and the Engram project"). Mention how many engrams were reviewed.

## Rules

- Do not pad with generic filler. Every sentence should be something a future session could act on.
- Prefer the most recent information when facts conflict across Engrams.
- Do not include ephemeral details (what you discussed today, specific error messages, etc.).
- Keep it stable: the profile should change slowly over months, not session to session.
