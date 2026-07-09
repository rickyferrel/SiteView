---
name: wrap
description: End-of-session wrap-up — commit outstanding work, update CLAUDE.md where the mental model changed, and write a HANDOFF.md if a task is mid-flight. Use when the user says "wrap up", "update the claude.md", "write a handoff", or is clearly finishing a work session.
---

# Wrap up the session

The goal: the next session (or another agent, e.g. Claude Chrome) can pick up cold with zero re-explaining. Three steps, in order:

## 1. Inventory what actually changed

`git status` + `git log --oneline -5` + `git diff --stat`. Summarize the session's outcome in 2–3 sentences for the user — features landed, bugs fixed, anything left broken.

## 2. Update CLAUDE.md — surgically

Only touch sections whose **mental model changed** (new subsystem, new gotcha discovered, changed architecture, new external service). Do NOT:
- rewrite or reformat untouched sections,
- log a changelog of the session ("we fixed X today") — git history records that,
- duplicate what the code or README already says.

A good CLAUDE.md edit is 1–10 lines: a new row in the code map, a new gotcha bullet, a corrected fact. If nothing about the mental model changed, say so and skip the edit.

## 3. HANDOFF.md — only if something is mid-flight

If a task is incomplete or an external step is pending (deploy, migration, another agent's work), write/refresh `HANDOFF.md` with:
- **State**: what's done and verified, what's not.
- **Next step**: the exact command/action to resume, and where (file:line, URL, console page).
- **Gotchas discovered this session** that the next agent would otherwise re-learn the hard way.
- Credentials/endpoints by reference (where they live), never inline secrets.

If everything is finished and shipped, delete stale handoff content instead of letting it rot.

## 4. Offer to commit

Uncommitted work at session end is how work gets lost to a folder rename or a crashed laptop. Offer to commit (and push via the ship flow if the user wants it live). Then suggest starting the next feature in a **fresh session** — long sessions degrade and burn tokens.
