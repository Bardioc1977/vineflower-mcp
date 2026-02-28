# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm ci            # Install dependencies
npm run dev       # Run server in dev mode (tsx, no build needed)
npm run build     # Compile TypeScript to dist/
npm run start     # Run compiled server (requires build first)
MCP_VINEFLOWER_AUTO_DOWNLOAD=1 npm run setup:vineflower  # Prefetch Vineflower jar
```

There are no tests. CI runs `npm ci && npm run build`.

## Architecture

This is a single-file MCP (Model Context Protocol) server: all logic lives in `src/server.ts`, which compiles to `dist/server.js`. The server communicates over stdio using `@modelcontextprotocol/sdk`.

**Three MCP tools are exposed:**

1. **`java_decompile_plan`** — Scans a directory tree for `.jar` files, classifies each as `library`/`product`/`unknown` by filename heuristics, and returns a list for the caller to plan decompilation.

2. **`java_decompile_vineflower`** — Invokes the Vineflower decompiler (CLI binary or `java -jar`) on one or more input JARs, writes Java sources to `outputDir`, and (in `sources+meta` mode) writes `manifest.json` and `stats.json` alongside the sources.

3. **`java_sources_index`** — Walks decompiled `.java` sources, extracts package names and class names via regex, detects `main()` entrypoints and `ServiceLoader` usage, then writes `symbols.json` and `entrypoints.json` to the source root.

**Security model:** Symlinks are not followed during directory traversal. `extraArgs` passed to Vineflower are checked against an allowlist (`ALLOWED_EXTRA_ARGS`).

**Vineflower resolution order:**
1. `VINEFLOWER_JAR` env var (explicit jar path, uses `java -jar`)
2. `VINEFLOWER_BIN` env var or `vineflower` on PATH (CLI binary)
3. `.vineflower/vineflower.jar` in the project root (auto-downloaded if `MCP_VINEFLOWER_AUTO_DOWNLOAD=1`)

## Versioning and releases

Version format: `vYYYY.MM.DD.N` (UTC date + commit count for that day).

```bash
npm run tag:release        # Bump package.json + create git tag
npm run tag:push           # Push the tag to origin
npm run tag:release:push   # Do both in one step
```

The release workflow (`.github/workflows/release.yml`) validates that the pushed tag matches the computed version and publishes `vineflower-mcp-dist.tgz` (containing `dist/`, `README.md`, `package.json`) as a GitHub Release asset.

Tag scripts require a clean working tree; the only permitted local changes are the `package.json`/`package-lock.json` version bump.

## Key environment variables

| Variable | Default | Purpose |
|---|---|---|
| `VINEFLOWER_BIN` | `vineflower` | Vineflower CLI binary name/path |
| `VINEFLOWER_JAR` | — | Explicit path to vineflower.jar |
| `VINEFLOWER_THREADS` | `4` | Default thread count for decompilation |
| `VINEFLOWER_VERSION` | `1.10.1` | Version to download if auto-download is used |
| `MCP_TIMEOUT_MS` | `1800000` | Max time for a Vineflower subprocess |
| `MCP_MAX_CAPTURE_CHARS` | `200000` | Max stdout/stderr chars captured per run |
| `MCP_MAX_JARS` | `500` | Max total JARs per decompile call |
| `MCP_VINEFLOWER_AUTO_DOWNLOAD` | `0` | Allow downloading Vineflower from Maven Central |
| `MCP_VERBOSE` | `1` | Stream subprocess output and scan progress to stderr |
