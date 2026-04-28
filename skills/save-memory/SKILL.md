---
name: save-memory
description: Save the current conversation as one or more Engrams in the Engram memory database. Use when the user explicitly asks to save, remember, or record the current conversation or a specific topic discussed. Never run automatically — only when the user invokes /save-memory.
disable-model-invocation: true
user-invocable: true
effort: high
compatibility: Requires the Engram MCP server to be running (http://localhost:7384/mcp). See the Engram repo for setup.
metadata:
  author: engram
  version: "0.2"
---

# Save Memory

You have been explicitly asked by the user to save the current conversation as Engrams.

The goal is maximum detail preservation. A future model reading these Engrams should understand exactly what happened, what was decided, and what was learned — as if they had been in the conversation. One compressed summary loses detail. Multiple focused Engrams preserve it.

## Phase 1 — Full extraction pass

Go through the entire conversation from start to finish, chronologically. Do not filter or summarize yet — capture everything that could be worth remembering:

- Decisions made and the reasoning behind them
- Preferences, opinions, or working style observations
- Technical choices, constraints, or architectural directions
- Personal context, goals, or background details
- Problems solved and how they were resolved
- Open questions or things left unresolved
- Anything the user said that revealed how they think or what they care about

Write this out as an internal structured draft. Completeness matters here — it is easier to discard detail later than to recover it.

## Phase 2 — Topic grouping

From the extraction draft, identify 2–5 distinct topics. A good topic boundary is: would a future model searching for one thing also need the other? If yes, same Engram. If no, separate.

Aim for focused, searchable topics — not one giant dump, not trivially small fragments.

## Phase 3 — Write and save

For each topic, compose a self-contained Engram and call `save_memory`:

- **`title`**: 3–8 words, specific enough to be findable. Good: "Engram Server — Ollama Lifecycle Design". Poor: "Technical discussion".
- **`content`**: Markdown. Write in **third person** — this is a note about Aaron for a future model, not a message to Aaron. Use "Aaron decided…", "Aaron prefers…", never "You decided…". Do not reference the conversation itself ("we discussed", "you mentioned") — write the facts directly as standing knowledge.
- **`date`**: today's date in YYYY-MM-DD format.
- **`type`**: use the most fitting category — `"chat"`, `"decision"`, `"code"`, `"idea"` — or omit if none fits.

Call `save_memory` once per topic. Save them sequentially so wikilinks can cross-reference correctly.

## Phase 4 — Report

After all saves complete, tell the user:

```
Saved N engrams:
- "Title 1" → 2026-04-28/title-1.md (linked to: X, Y)
- "Title 2" → 2026-04-28/title-2.md
- ...
```

## What makes a good Engram

- **Self-contained**: reads clearly without this conversation's context
- **Factual**: states what was learned, not how the conversation went  
- **Detailed**: preserves reasoning and nuance, not just conclusions
- **Durable**: accurate and useful in 6 months
