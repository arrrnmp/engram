---
name: prefill
description: Load the user's persistent memory profile (IMPORTANT.md) into context. Use when the user invokes /prefill at the start of a conversation to give the model background about who they are and what they care about. Never run automatically.
compatibility: Requires the Engram MCP server to be running (http://localhost:7384/mcp).
metadata:
  author: engram
  version: "0.1"
---

# Prefill Context

You have been asked to load the user's persistent memory profile.

## Steps

1. Call `get_important_context` with no arguments.

2. If the response contains content:
   - Read it carefully and internalize it as background context for this conversation
   - Acknowledge to the user that you've loaded their profile with a single brief line
   - Do **not** repeat the full IMPORTANT.md back to the user verbatim — just confirm it was loaded
   - Example: "Memory loaded. I know who you are and what you're working on."

3. If IMPORTANT.md is empty or does not exist:
   - Tell the user: "No memory profile found yet. Run /update-important-memory after a few saved conversations to build one."

## Important

- This skill only loads context — it does not save anything.
- Keep the acknowledgement short. The goal is silent context injection, not a summary.
- If you notice the profile is significantly outdated (e.g., references past projects that seem concluded), mention that the user may want to run /update-important-memory.
