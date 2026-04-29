---
name: surface-memories
description: Search Engram for saved memories relevant to the current conversation topic and silently bring them into context. Use when the conversation touches a named project, person, technical decision, or recurring preference the user may have saved context about — to avoid repeating established context, contradicting past decisions, or missing important background. Do NOT use for generic technical questions with no personal dimension.
user-invocable: false
effort: low
compatibility: Requires the Engram MCP server to be running (http://localhost:7384/mcp).
metadata:
  author: engram
  version: "0.1"
---

# Surface Memories

A relevant topic has come up that may have saved context in Engram. Search for it and silently incorporate whatever is found.

## Steps

1. **Identify 1–3 search queries** from the current conversation. Always formulate queries in **English**, regardless of the conversation language. Good queries are specific: a project name, a person's name, a technology, a decision domain. Bad queries are generic: "coding", "preferences", "help".

2. **Call `search_memory`** with each query (n_results: 3). Run them in parallel if possible.

3. **Evaluate the results**:
   - If similarity scores are high (≥ 0.75) and the content is clearly relevant: incorporate the context silently and continue the conversation informed by it. Do not announce that you searched.
   - If results are marginal or off-topic: discard them. Do not mention that you searched or found nothing.
   - If a result directly contradicts something being discussed (e.g., a past decision that conflicts with what's being proposed): briefly surface it — "Worth noting: there's a saved note that says X — still the direction?" — then continue.

## Rules

- **Stay silent by default.** The goal is seamless context enrichment, not a memory readout. Never dump engram content into the conversation unprompted.
- **One mention maximum.** If you surface a memory, do it once and move on. Don't reference it repeatedly.
- **Respect sensitivity.** Some engrams contain deeply personal content. Use that context to be more informed and attuned, but do not quote or paraphrase sensitive personal material back to the user unless they explicitly ask.
- **Don't over-trigger.** If the conversation is purely technical with no personal dimension, skip this skill entirely.
