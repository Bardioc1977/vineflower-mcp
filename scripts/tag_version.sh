#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [[ -z "$repo_root" ]]; then
  echo "Error: must be run inside a git repository." >&2
  exit 1
fi

version="$("$repo_root/scripts/get_tag_version.sh")"
version_no_v="${version#v}"

(
  cd "$repo_root"
  npm version --no-git-tag-version "$version_no_v" >/dev/null
)

update_version_in_file() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    return
  fi

  node - <<'NODE' "$file" "$version_no_v"
const fs = require("fs");

const [file, version] = process.argv.slice(2);
const contents = fs.readFileSync(file, "utf8");
const marker = 'name: "vineflower-mcp"';
const markerIndex = contents.indexOf(marker);

if (markerIndex === -1) {
  console.error(`Error: could not find server name marker in ${file}.`);
  process.exit(1);
}

const afterMarker = contents.slice(markerIndex);
const versionRegex = /version:\s*["'][^"']+["']/;
const match = versionRegex.exec(afterMarker);

if (!match) {
  console.error(`Error: could not find version to update in ${file}.`);
  process.exit(1);
}

const updatedAfter = afterMarker.replace(versionRegex, `version: "${version}"`);
const updated = contents.slice(0, markerIndex) + updatedAfter;

if (updated !== contents) {
  fs.writeFileSync(file, updated);
}
NODE
}

update_version_in_file "$repo_root/src/server.ts"
update_version_in_file "$repo_root/dist/server.js"

echo "$version"
