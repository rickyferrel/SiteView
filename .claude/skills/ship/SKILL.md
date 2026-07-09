---
name: ship
description: Commit, push to main, then watch the deploy and smoke-check production. Use whenever the user says "commit and push", "push to main", "ship it", or asks to deploy — this repo deploys prod straight from main, so pushing IS deploying.
---

# Ship: commit → push → verify prod

Pushing `main` deploys production (Amplify auto-builds every push). Treat every push as a deploy: verify before, smoke-check after.

**Cloud/web sessions can't push `main` directly** — they push a feature branch and open a PR. In that case do the preflight below, push the branch, and tell the user plainly: merging the PR is the deploy, and the post-merge smoke check below is on them (or a later session).

## 1. Preflight (before committing)

- `git status` + `git diff --stat` — say what's about to ship; flag anything unexpected (env files, stray debug code, unrelated changes).
- Typecheck/build: `npx tsc --noEmit`; prefer `npm run build` if the change touches server/config code.
- **Schema rule**: if `src/lib/schema.ts` changed, `migrate.sql` must contain the mirrored change (and remind the user to run `npm run migrate` against RDS after deploy). Editing one without the other silently forks dev vs prod schemas — block the push and fix it if they've drifted.
- If the diff is large or risky, offer `/code-review` first (low effort is fine) — there's no CI on these repos, so this is the only gate.

## 2. Commit & push

- One descriptive commit (subject explains the user-visible change, not the mechanics). End the message with:
  `Co-Authored-By: Claude <noreply@anthropic.com>` (or the current model's footer).
- Push to `main` only when that's what the user asked; otherwise branch.

## 3. Post-push verification (don't skip — this is the point of the skill)

- Amplify builds ~3–8 min. Poll in background: `curl -s -o /dev/null -w "%{http_code} %{time_total}s" https://main.d1fccqopge5j62.amplifyapp.com/api/dev` until the new build serves. Healthy = fast `200` JSON array. A ~8s empty-body `500` = Lambda OOM, i.e. runtime lost the `PG*` env vars and fell back to PGlite (see CLAUDE.md Production section). Also spot-check the page the change touched.
- Report: commit hash, what shipped, deploy status, smoke result. If smoke fails, say so plainly and start diagnosing — never end on "pushed, hope it works."
