---
name: fix
description: Triage and fix a reported bug or user complaint — reproduce first, root-cause with evidence, fix minimally, then prove the original report is resolved. Use when the user pastes a complaint/bug report ("I just got this complaint...", "when I do X it errors"), attaches an error screenshot, or says something worked in draft/dev but not live/prod.
---

# Fix: complaint → reproduction → root cause → verified fix

Complaints here come from real users (operators editing lots in the portal, viewers of the embedded map). The failure mode to avoid: patching the first plausible suspect without ever seeing the bug happen. Order is mandatory:

## 1. Restate the bug as expected vs actual

One or two sentences back to the user: "Expected: X. Actual: Y. Trigger: Z." If the complaint includes numbers (lot counts, prices, acreage), write down the expected arithmetic — the fix must reproduce those exact numbers later. If you can't fill in all three of expected/actual/trigger from what was given, ask now — one question beats a wrong fix.

## 2. Reproduce before editing

Find the code path, then actually trigger it: curl the endpoint, run the flow in the dev server, or feed the same data through the function. If the report says "works in draft but not published/prod", diff those two paths specifically — the bug lives in the difference (snapshotting, env, caching, serialization). Only if reproduction is genuinely impossible (prod-only, missing data) proceed on evidence from logs/code, and say you couldn't reproduce.

## 3. Root-cause with evidence

Name the cause as `file.ts:line` plus the mechanism, in plain language. "The dropdown queries all employees because the filter param is dropped in X" — not "there was an issue with the filter." Before fixing, tell the user the diagnosis in one short paragraph.

## 4. Fix minimally, then sweep

Smallest change that kills the mechanism. Then check sibling code paths for the same mistake (the other export columns, the other status filters, the published-vs-draft twin) — complaints usually reveal a class of bug, not an instance.

## 5. Prove it

Re-run the exact reproduction from step 2 and show it passing — recompute the complainant's numbers if they gave any. Typecheck passing is not proof; the original scenario passing is. Then report: cause → fix → proof, and offer to ship (/ship).
