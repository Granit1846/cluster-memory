#!/bin/sh
# Record commit keywords into the project's trail, so a decision tied to a commit
# stays findable later. Install: cp examples/git-post-commit.sh .git/hooks/post-commit
# and make it executable (chmod +x .git/hooks/post-commit).
set -eu

CLUSTER_MEMORY="${CLUSTER_MEMORY:-$(git rev-parse --show-toplevel)/scripts/cluster-memory.mjs}"
message="$(git log -1 --pretty=%s%n%b)"
files="$(git diff-tree --no-commit-id --name-only -r HEAD | head -20 | tr '\n' ',' )"

node "$CLUSTER_MEMORY" record \
  --tool git-commit \
  --question "$message" \
  --keywords "" 2>/dev/null || true

node "$CLUSTER_MEMORY" remember \
  --question "commit: $(printf '%s' "$message" | head -1)" \
  --answer "$message" \
  --files "$files" \
  --outcome useful 2>/dev/null || true
