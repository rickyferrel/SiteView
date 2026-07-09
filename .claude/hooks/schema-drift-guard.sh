#!/bin/bash
# PostToolUse(Edit|Write) guard: src/lib/schema.ts and migrate.sql must change together.
# CLAUDE.md rule — migrate.sql is the hand-maintained prod (RDS) mirror of schema.ts;
# editing one without the other silently forks dev vs prod schemas.
f=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))' 2>/dev/null)
case "$f" in
  */src/lib/schema.ts) ;;
  *) exit 0 ;;
esac
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
if git -C "$root" status --porcelain -- migrate.sql 2>/dev/null | grep -q .; then
  exit 0  # migrate.sql already has uncommitted changes — assumed mirrored
fi
echo "schema.ts was just edited but migrate.sql has no uncommitted changes. CLAUDE.md rule: every schema change must be mirrored by hand into migrate.sql (the prod RDS copy) or dev and prod schemas silently fork. Mirror the change into migrate.sql now, and remind the user to run 'npm run migrate' against RDS after this deploys. If this edit changed no DDL (comments/formatting only), state that and continue." >&2
exit 2
