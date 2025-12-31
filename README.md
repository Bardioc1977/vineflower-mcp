# vineflower-mcp

MCP stdio server that runs Vineflower via a CLI or downloaded jar to decompile Java JARs headlessly and index sources.

## Setup

```bash
npm i
npm run dev
```

Optional prefetch (downloads Vineflower jar only when `MCP_VINEFLOWER_AUTO_DOWNLOAD=1` is set):

```bash
MCP_VINEFLOWER_AUTO_DOWNLOAD=1 npm run setup:vineflower
```

## Environment

```bash
export MCP_ALLOWED_ROOT="/path/to/workspace"
export VINEFLOWER_BIN="vineflower"
export VINEFLOWER_JAR="/path/to/vineflower.jar"
export MCP_TIMEOUT_MS="1800000"
export MCP_MAX_CAPTURE_CHARS="200000"
export MCP_MAX_JARS="500"
export VINEFLOWER_THREADS="4"
export MCP_VINEFLOWER_AUTO_DOWNLOAD="1"
export VINEFLOWER_VERSION="1.10.1"
```

If no Vineflower binary is found, the server logs install options to stderr. To allow a one-time download
from Maven Central into `.vineflower/vineflower.jar`, set `MCP_VINEFLOWER_AUTO_DOWNLOAD=1` (requires Java).

## Example tool calls

### java_decompile_plan

```json
{
  "searchDir": "/path/to/workspace/jars",
  "jarGlobHint": "service",
  "maxResults": 2000
}
```

### java_decompile_vineflower

```json
{
  "inputJars": ["/path/to/workspace/jars/app.jar"],
  "libraryJars": ["/path/to/workspace/jars/lib.jar"],
  "outputDir": "/path/to/workspace/decompiled/app",
  "overwrite": true,
  "mode": "sources+meta",
  "options": {
    "threads": 4,
    "extraArgs": ["--decompile-generics", "--log-level=info"]
  }
}
```

### java_sources_index

```json
{
  "sourceRoot": "/path/to/workspace/decompiled/app",
  "maxFileBytes": 500000,
  "maxFiles": 50000
}
```
