# IMPORTANT.md Content Strategy

## What to include

**Identity & role**
- Job title, domain, team size
- Years of experience in key areas
- Primary programming languages and frameworks they reach for by default

**Working style**
- Communication preferences (terse vs. detailed, examples vs. theory)
- How they like code structured (comments, naming, test coverage expectations)
- Preferred tooling (editor, shell, package managers, CI)

**Active projects**
- What they're building right now (1–3 sentences per project)
- Key architectural choices already made (don't re-litigate them)
- Known constraints (deadlines, tech debt, team skill level)

**Persistent preferences**
- Things they've explicitly said they like or dislike
- Recurring frustrations to avoid
- Patterns they've confirmed work well for them

**Context that saves time**
- Anything that would cause a future AI to suggest the wrong thing without knowing it
- Examples: "already tried X and it failed for Y reason", "team can't use Z due to licensing"

## What to exclude

- One-off errors and their fixes (belong in commit messages, not profiles)
- Specifics of today's conversation
- Things that change weekly (current sprint, what they had for lunch)
- Praise or flattery ("you're great at…")
- Anything that sounds like a session log

## Format template

```markdown
# About You

[name] is [role] at [context]. He/she has [X] years of experience in [domain].

## Working Style
...

## Technical Preferences
...

## Active Projects
...

## Important Context
...
```

Keep total length under 400 words. Ruthlessly cut anything a future AI session wouldn't benefit from knowing.
