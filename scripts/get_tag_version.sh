#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [[ -z "$repo_root" ]]; then
  echo "Error: must be run inside a git repository." >&2
  exit 1
fi

head_epoch=$(git -C "$repo_root" show -s --format=%ct HEAD)

read -r year month day day_start day_end <<<"$(node - <<'NODE' "$head_epoch"
const epoch = Number(process.argv[1]);
const date = new Date(epoch * 1000);
const year = date.getUTCFullYear();
const month = String(date.getUTCMonth() + 1).padStart(2, '0');
const day = String(date.getUTCDate()).padStart(2, '0');
const dayStart = Date.UTC(year, date.getUTCMonth(), date.getUTCDate()) / 1000;
const dayEnd = dayStart + 86399;
console.log(year, month, day, dayStart, dayEnd);
NODE
)"

commit_count=$(git -C "$repo_root" rev-list --count --since="@${day_start}" --until="@${day_end}" HEAD)

echo "v${year}.${month}.${day}.${commit_count}"
