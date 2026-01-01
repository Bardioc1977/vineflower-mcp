#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
version="${2:-}"

if [[ -z "$mode" || -z "$version" ]]; then
  echo "Usage: $0 <release|push> <version>" >&2
  exit 1
fi

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [[ -z "$repo_root" ]]; then
  echo "Error: must be run inside a git repository." >&2
  exit 1
fi

has_disallowed_changes=false
while IFS= read -r -d '' entry; do
  [[ -z "$entry" ]] && continue
  path="${entry:3}"
  if [[ "$path" == *" -> "* ]]; then
    path="${path##* -> }"
  fi
  case "$path" in
    package.json|package-lock.json|src/server.ts|dist/server.js) ;;
    *)
      echo "Error: working tree has changes in $path." >&2
      has_disallowed_changes=true
      ;;
  esac
done < <(git -C "$repo_root" status --porcelain=v1 -z)

if [[ "$has_disallowed_changes" == "true" ]]; then
  exit 1
fi

if [[ "$mode" == "release" ]]; then
  if git -C "$repo_root" rev-parse -q --verify "refs/tags/$version" >/dev/null; then
    echo "Error: tag $version already exists." >&2
    exit 1
  fi
elif [[ "$mode" == "push" ]]; then
  if ! git -C "$repo_root" rev-parse -q --verify "refs/tags/$version" >/dev/null; then
    echo "Error: tag $version does not exist locally." >&2
    exit 1
  fi
else
  echo "Error: unknown mode $mode (expected release or push)." >&2
  exit 1
fi
