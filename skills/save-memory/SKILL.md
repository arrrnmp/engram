---
name: save-memory
description: Save the current conversation as an Engram in the Engram memory database. Use when the user explicitly asks to save, remember, or record the current conversation or a specific topic discussed. Never run automatically — only when the user invokes /save-memory.
compatibility: Requires the Engram MCP server to be running (http://localhost:7384/mcp). See the Engram repo for setup.
metadata:
  author: engram
  version: "0.1"
---

# Save Memory

You have been explicitly asked by the user to save the current conversation as an Engram.

## Steps

1. **Review the conversation** to identify what is worth remembering. Focus on:
   - Key decisions, preferences, or facts the user shared
   - Project context, goals, or constraints
   - Personal details the user would want recalled in future sessions
   - Technical choices or architectural decisions

2. **Compose the Engram content** in markdown. Write it as a clear, self-contained note that will make sense when read in isolation months from now. Write in **third person** — this is a note about the user for a future model to read, not a message to the user. Use "Aaron prefers…" or "The user prefers…", never "You prefer…". Do not reference the conversation meta ("you said", "we discussed") — write the facts directly.

3. **Choose a concise title** (3–8 words) that describes what was learned. Good: "Prefers TypeScript with Strict Mode". Poor: "Conversation about code".

4. **Call `save_memory`** with:
   - `title`: the concise title you chose
   - `content`: the markdown content you composed
   - `date`: today's date in YYYY-MM-DD format (if you know it), otherwise omit

5. **Report back** to the user: confirm the Engram was saved and mention how many related memories were auto-linked (if any).

## What makes a good Engram

- Self-contained: reads clearly without this conversation's context
- Factual: states what was learned, not how the conversation went
- Focused: one topic per Engram is better than one giant dump
- Durable: written so it will still be accurate and useful in 6 months

## Example output format

```
Engram saved: 2026-04-26/prefers-bun-over-node.md
Linked to 2 related memories: project-goals, typescript-setup
```
