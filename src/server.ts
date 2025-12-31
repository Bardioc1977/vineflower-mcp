import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import https from "node:https";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_CAPTURE_CHARS = 200_000;
const DEFAULT_MAX_JARS = 500;
const DEFAULT_THREADS = 4;

const MCP_TIMEOUT_MS = getEnvInt("MCP_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
const MCP_MAX_CAPTURE_CHARS = getEnvInt("MCP_MAX_CAPTURE_CHARS", DEFAULT_MAX_CAPTURE_CHARS);
const MCP_MAX_JARS = getEnvInt("MCP_MAX_JARS", DEFAULT_MAX_JARS);
const DEFAULT_THREADS_ENV = getEnvInt("VINEFLOWER_THREADS", DEFAULT_THREADS);

const VINEFLOWER_BIN = process.env.VINEFLOWER_BIN || "vineflower";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_VINEFLOWER_DIR = path.join(PROJECT_ROOT, ".vineflower");
const LOCAL_VINEFLOWER_JAR = path.join(LOCAL_VINEFLOWER_DIR, "vineflower.jar");
const DEFAULT_VINEFLOWER_VERSION = "1.10.1";

type VineflowerCommand = {
  bin: string;
  argsPrefix: string[];
  display: string;
  version: string | null;
  mode: "bin" | "jar";
  jarPath?: string;
};

const ALLOWED_EXTRA_ARGS = new Set([
  "--decompile-generics",
  "--decompile-synthetics",
  "--decompile-annotations",
  "--remove-bridge",
  "--remove-synthetic",
  "--include-runtime",
  "--log-level",
  "--indent-string",
  "--line-separator",
  "--rename",
  "--rename-parameters",
  "--use-debug-line-numbers",
  "--bytecode-source",
  "--dump-original-lines",
  "--decompile-enums",
  "--decompile-preview",
  "--use-unicode-escapes",
  "--separate-auxiliary-classes",
  "--keep-kotlin-metadata",
  "--warn-on-unresolved",
  "--print-statistics"
]);

const PlanInputSchema = z.object({
  searchDir: z.string().min(1),
  jarGlobHint: z.string().optional(),
  maxResults: z.number().int().positive().max(200000).default(2000)
});

const DecompileInputSchema = z.object({
  inputJars: z.array(z.string().min(1)).min(1),
  libraryJars: z.array(z.string().min(1)).optional().default([]),
  outputDir: z.string().min(1),
  overwrite: z.boolean().optional().default(false),
  mode: z.enum(["sources", "meta", "sources+meta"]).optional().default("sources+meta"),
  options: z
    .object({
      threads: z.number().int().positive().optional(),
      extraArgs: z.array(z.string()).optional().default([])
    })
    .optional()
    .default({})
});

const IndexInputSchema = z.object({
  sourceRoot: z.string().min(1),
  maxFileBytes: z.number().int().positive().max(50_000_000).optional().default(500_000),
  maxFiles: z.number().int().positive().max(200_000).optional().default(50_000)
});

const PlanToolSchema = {
  type: "object",
  properties: {
    searchDir: { type: "string" },
    jarGlobHint: { type: "string" },
    maxResults: { type: "integer", default: 2000 }
  },
  required: ["searchDir"],
  additionalProperties: false
};

const DecompileToolSchema = {
  type: "object",
  properties: {
    inputJars: { type: "array", items: { type: "string" } },
    libraryJars: { type: "array", items: { type: "string" }, default: [] },
    outputDir: { type: "string" },
    overwrite: { type: "boolean", default: false },
    mode: { type: "string", enum: ["sources", "meta", "sources+meta"], default: "sources+meta" },
    options: {
      type: "object",
      properties: {
        threads: { type: "integer" },
        extraArgs: { type: "array", items: { type: "string" } }
      },
      additionalProperties: false
    }
  },
  required: ["inputJars", "outputDir"],
  additionalProperties: false
};

const IndexToolSchema = {
  type: "object",
  properties: {
    sourceRoot: { type: "string" },
    maxFileBytes: { type: "integer", default: 500000 },
    maxFiles: { type: "integer", default: 50000 }
  },
  required: ["sourceRoot"],
  additionalProperties: false
};

async function main() {
  const allowedRoot = await resolveAllowedRoot();
  const vineflowerCommand = await ensureVineflower();
  const setupOnly =
    process.argv.includes("--setup") || process.argv.includes("--prefetch-vineflower");

  if (setupOnly) {
    console.error(`Vineflower ready: ${vineflowerCommand.display}`);
    return;
  }

  const server = new Server(
    {
      name: "vineflower-mcp",
      version: "1.0.0-beta1"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "java_decompile_plan",
          description: "Scan for JAR files under a directory and classify them for decompilation planning.",
          inputSchema: PlanToolSchema
        },
        {
          name: "java_decompile_vineflower",
          description: "Run Vineflower headless via CLI to decompile JARs into Java sources.",
          inputSchema: DecompileToolSchema
        },
        {
          name: "java_sources_index",
          description: "Index decompiled Java sources for packages, classes, and entrypoints.",
          inputSchema: IndexToolSchema
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;

    if (name === "java_decompile_plan" || name === "java.decompile.plan") {
      const args = PlanInputSchema.parse(rawArgs ?? {});
      const result = await handlePlan(args, allowedRoot);
      return toToolResult(result);
    }

    if (name === "java_decompile_vineflower" || name === "java.decompile.vineflower") {
      const args = DecompileInputSchema.parse(rawArgs ?? {});
      const result = await handleDecompile(args, allowedRoot, vineflowerCommand);
      return toToolResult(result);
    }

    if (name === "java_sources_index" || name === "java.sources.index") {
      const args = IndexInputSchema.parse(rawArgs ?? {});
      const result = await handleIndex(args, allowedRoot);
      return toToolResult(result);
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("vineflower-mcp server ready");
}

function toToolResult(data: unknown) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

async function resolveAllowedRoot() {
  const candidate = process.env.MCP_ALLOWED_ROOT?.trim() || process.cwd();
  try {
    return await fs.realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function getEnvInt(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function getEnvBoolean(name: string, fallback: boolean) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function isWithinAllowedRoot(allowedRoot: string, candidate: string) {
  const relative = path.relative(allowedRoot, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolvePathWithinAllowed(
  inputPath: string,
  allowedRoot: string,
  mustExist: boolean
) {
  const resolved = mustExist ? await fs.realpath(inputPath) : path.resolve(inputPath);
  if (!isWithinAllowedRoot(allowedRoot, resolved)) {
    throw new Error(`Path is outside MCP_ALLOWED_ROOT: ${inputPath}`);
  }
  return resolved;
}

async function ensureVineflower(): Promise<VineflowerCommand> {
  const explicitJar = process.env.VINEFLOWER_JAR?.trim();
  const allowDownload = getEnvBoolean("MCP_VINEFLOWER_AUTO_DOWNLOAD", false);

  if (explicitJar) {
    const jarPath = await fs.realpath(explicitJar);
    const javaOk = await probeCommand("java", ["-version"]);
    if (!javaOk.ok) {
      throw new Error(
        "Java runtime not found. Install Java or set VINEFLOWER_BIN to a vineflower CLI binary."
      );
    }
    const versionProbe = await probeCommand("java", ["-jar", jarPath, "--version"]);
    return {
      bin: "java",
      argsPrefix: ["-jar", jarPath],
      display: `java -jar ${jarPath}`,
      version: versionProbe.version,
      mode: "jar",
      jarPath
    };
  }

  const binProbe = await probeCommand(VINEFLOWER_BIN, ["--version"]);
  if (binProbe.ok) {
    return {
      bin: VINEFLOWER_BIN,
      argsPrefix: [],
      display: VINEFLOWER_BIN,
      version: binProbe.version,
      mode: "bin"
    };
  }

  const localJarExists = await statOrNull(LOCAL_VINEFLOWER_JAR);
  if (localJarExists?.isFile()) {
    const javaOk = await probeCommand("java", ["-version"]);
    if (!javaOk.ok) {
      throw new Error(
        "Vineflower jar found but Java is missing. Install Java or set VINEFLOWER_BIN."
      );
    }
    const versionProbe = await probeCommand("java", ["-jar", LOCAL_VINEFLOWER_JAR, "--version"]);
    return {
      bin: "java",
      argsPrefix: ["-jar", LOCAL_VINEFLOWER_JAR],
      display: `java -jar ${LOCAL_VINEFLOWER_JAR}`,
      version: versionProbe.version,
      mode: "jar",
      jarPath: LOCAL_VINEFLOWER_JAR
    };
  }

  console.error("Vineflower not found.");
  console.error("Option 1: Install a global CLI and set VINEFLOWER_BIN if needed.");
  console.error("  macOS (Homebrew): brew install vineflower");
  console.error("  Other platforms: download the jar and set VINEFLOWER_JAR=/path/to/vineflower.jar");
  console.error(
    `Option 2: Allow auto-download by setting MCP_VINEFLOWER_AUTO_DOWNLOAD=1 (will place ${LOCAL_VINEFLOWER_JAR}).`
  );

  if (!allowDownload) {
    throw new Error("Vineflower is required but not available.");
  }

  const javaOk = await probeCommand("java", ["-version"]);
  if (!javaOk.ok) {
    throw new Error(
      "Java runtime not found. Install Java or set VINEFLOWER_BIN to a vineflower CLI binary."
    );
  }

  await downloadVineflowerJar(LOCAL_VINEFLOWER_JAR);
  const versionProbe = await probeCommand("java", ["-jar", LOCAL_VINEFLOWER_JAR, "--version"]);
  return {
    bin: "java",
    argsPrefix: ["-jar", LOCAL_VINEFLOWER_JAR],
    display: `java -jar ${LOCAL_VINEFLOWER_JAR}`,
    version: versionProbe.version,
    mode: "jar",
    jarPath: LOCAL_VINEFLOWER_JAR
  };
}

async function probeCommand(bin: string, args: string[]) {
  try {
    const result = await runCommand(bin, args, 10_000, 8_000);
    if (result.timedOut) {
      return { ok: false, version: null };
    }
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    const version = combined ? combined.split("\n")[0]?.trim() : null;
    return { ok: true, version };
  } catch {
    return { ok: false, version: null };
  }
}

async function downloadVineflowerJar(destPath: string) {
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const version = await resolveVineflowerVersion();
  const url = `https://repo1.maven.org/maven2/org/jetbrains/java/decompiler/vineflower/${version}/vineflower-${version}.jar`;
  console.error(`Downloading Vineflower ${version} from ${url}`);
  await downloadFile(url, destPath);
}

async function resolveVineflowerVersion() {
  const envVersion = process.env.VINEFLOWER_VERSION?.trim();
  if (envVersion) {
    return envVersion;
  }
  const metadataUrl =
    "https://repo1.maven.org/maven2/org/jetbrains/java/decompiler/vineflower/maven-metadata.xml";
  try {
    const xml = await fetchText(metadataUrl);
    const release = xml.match(/<release>([^<]+)<\/release>/)?.[1];
    const latest = xml.match(/<latest>([^<]+)<\/latest>/)?.[1];
    return release || latest || DEFAULT_VINEFLOWER_VERSION;
  } catch {
    return DEFAULT_VINEFLOWER_VERSION;
  }
}

async function fetchText(url: string) {
  return new Promise<string>((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        const location = response.headers.location;
        response.resume();
        if (location) {
          fetchText(location).then(resolve, reject);
          return;
        }
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Request failed with status ${response.statusCode}`));
        return;
      }
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        data += chunk;
      });
      response.on("end", () => resolve(data));
    });
    request.on("error", reject);
  });
}

async function downloadFile(url: string, destPath: string) {
  await new Promise<void>((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        const location = response.headers.location;
        response.resume();
        if (location) {
          downloadFile(location, destPath).then(resolve, reject);
          return;
        }
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with status ${response.statusCode}`));
        return;
      }
      const fileStream = createWriteStream(destPath);
      pipeline(response, fileStream).then(resolve, reject);
    });
    request.on("error", reject);
  });
}

async function handlePlan(
  args: z.infer<typeof PlanInputSchema>,
  allowedRoot: string
) {
  const searchDir = await resolvePathWithinAllowed(args.searchDir, allowedRoot, true);
  const dirStat = await fs.stat(searchDir);
  if (!dirStat.isDirectory()) {
    throw new Error(`searchDir is not a directory: ${args.searchDir}`);
  }

  const hint = args.jarGlobHint?.toLowerCase() ?? "";
  const jars: Array<{ path: string; sizeBytes: number; kind: string; nameHint: string }> = [];
  const counts = {
    total: 0,
    library: 0,
    product: 0,
    unknown: 0,
    truncated: false
  };

  const queue: string[] = [searchDir];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }

    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      console.error(`Failed to read directory ${current}:`, error);
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".jar")) {
        continue;
      }
      if (hint && !entry.name.toLowerCase().includes(hint)) {
        continue;
      }
      const stat = await fs.stat(entryPath);
      const kind = classifyJar(entry.name);
      jars.push({
        path: entryPath,
        sizeBytes: stat.size,
        kind,
        nameHint: path.basename(entry.name, ".jar")
      });
      counts.total += 1;
      counts[kind as "library" | "product" | "unknown"] += 1;
      if (jars.length >= args.maxResults) {
        counts.truncated = true;
        return { jars, counts };
      }
    }
  }

  return { jars, counts };
}

function classifyJar(fileName: string) {
  const lower = fileName.toLowerCase();
  const libraryHints = [
    "kotlin",
    "guava",
    "slf4j",
    "log4j",
    "jackson",
    "hibernate",
    "spring",
    "netty",
    "grpc",
    "apache",
    "commons-"
  ];
  for (const hint of libraryHints) {
    if (lower.includes(hint)) {
      return "library";
    }
  }
  const productHints = ["api", "service", "impl", "app", "core"];
  for (const hint of productHints) {
    if (lower.includes(hint)) {
      return "product";
    }
  }
  return "unknown";
}

async function handleDecompile(
  args: z.infer<typeof DecompileInputSchema>,
  allowedRoot: string,
  vineflowerCommand: VineflowerCommand
) {
  if (args.inputJars.length + args.libraryJars.length > MCP_MAX_JARS) {
    throw new Error(`Too many jars: limit is ${MCP_MAX_JARS}`);
  }

  const inputJars = await resolveExistingFiles(args.inputJars, allowedRoot, "inputJars");
  const libraryJars = await resolveExistingFiles(args.libraryJars, allowedRoot, "libraryJars");

  const outputDir = await resolvePathWithinAllowed(args.outputDir, allowedRoot, false);
  const outputStat = await statOrNull(outputDir);
  if (outputStat?.isFile()) {
    throw new Error(`outputDir is a file: ${args.outputDir}`);
  }
  if (outputStat && !args.overwrite) {
    throw new Error(`outputDir already exists and overwrite=false: ${args.outputDir}`);
  }
  if (outputStat && args.overwrite) {
    const realOutput = await fs.realpath(outputDir);
    if (!isWithinAllowedRoot(allowedRoot, realOutput)) {
      throw new Error(`Refusing to delete outside MCP_ALLOWED_ROOT: ${outputDir}`);
    }
    await fs.rm(realOutput, { recursive: true, force: true });
  }

  const threads = args.options.threads ?? DEFAULT_THREADS_ENV;
  const extraArgs = sanitizeExtraArgs(args.options.extraArgs ?? []);

  const jarPaths = [...inputJars.map((jar) => jar.path), ...libraryJars.map((jar) => jar.path)];
  const commandArgs = [`--threads=${threads}`, ...extraArgs, ...jarPaths, outputDir];
  const fullArgs = [...vineflowerCommand.argsPrefix, ...commandArgs];
  const version = vineflowerCommand.version || "unknown";

  const start = Date.now();
  const commandResult = await runCommand(
    vineflowerCommand.bin,
    fullArgs,
    MCP_TIMEOUT_MS,
    MCP_MAX_CAPTURE_CHARS
  );
  const durationMs = Date.now() - start;

  const stats = await collectJavaStats(outputDir);

  let manifestPath: string | undefined;
  let statsPath: string | undefined;
  if (args.mode === "sources+meta") {
    await fs.mkdir(outputDir, { recursive: true });
    const manifest = {
      tool: "java_decompile_vineflower",
      createdAt: new Date().toISOString(),
      allowedRoot,
      vineflower: {
        bin: vineflowerCommand.bin,
        version,
        mode: vineflowerCommand.mode,
        jar: vineflowerCommand.jarPath
      },
      command: formatCommand(vineflowerCommand.bin, fullArgs),
      inputJars: await attachJarMetadata(inputJars),
      libraryJars: await attachJarMetadata(libraryJars)
    };
    const statsPayload = {
      exitCode: commandResult.exitCode,
      durationMs,
      javaFiles: stats.javaFiles,
      packages: stats.packages
    };
    manifestPath = path.join(outputDir, "manifest.json");
    statsPath = path.join(outputDir, "stats.json");
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    await fs.writeFile(statsPath, JSON.stringify(statsPayload, null, 2));
  }

  return {
    ok: commandResult.exitCode === 0 && !commandResult.timedOut,
    exitCode: commandResult.exitCode,
    outputDir,
    stdout: commandResult.stdout,
    stderr: commandResult.stderr,
    artifacts: {
      sourceRoots: [outputDir],
      metaFiles: [manifestPath, statsPath].filter(Boolean),
      manifest: manifestPath,
      stats: statsPath
    },
    stats: {
      javaFiles: stats.javaFiles,
      packages: stats.packages,
      durationMs
    }
  };
}

async function resolveExistingFiles(
  paths: string[],
  allowedRoot: string,
  label: string
) {
  const resolved: Array<{ path: string; sizeBytes: number }> = [];
  for (const inputPath of paths) {
    const resolvedPath = await resolvePathWithinAllowed(inputPath, allowedRoot, true);
    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) {
      throw new Error(`${label} must be files: ${inputPath}`);
    }
    resolved.push({ path: resolvedPath, sizeBytes: stat.size });
  }
  return resolved;
}

async function attachJarMetadata(jars: Array<{ path: string; sizeBytes: number }>) {
  const result: Array<{ path: string; sizeBytes: number; sha256: string }> = [];
  for (const jar of jars) {
    result.push({
      path: jar.path,
      sizeBytes: jar.sizeBytes,
      sha256: await sha256File(jar.path)
    });
  }
  return result;
}

async function sha256File(filePath: string) {
  const hash = crypto.createHash("sha256");
  const stream = createReadStream(filePath);
  return new Promise<string>((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function statOrNull(targetPath: string) {
  try {
    return await fs.stat(targetPath);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function sanitizeExtraArgs(extraArgs: string[]) {
  const sanitized: string[] = [];
  for (const arg of extraArgs) {
    if (!arg || typeof arg !== "string") {
      continue;
    }
    if (arg.includes("..") || arg.includes("/") || arg.includes("\\")) {
      continue;
    }
    const [name, value] = arg.split("=", 2);
    if (!ALLOWED_EXTRA_ARGS.has(name)) {
      continue;
    }
    if (value !== undefined && /[\\/]/.test(value)) {
      continue;
    }
    sanitized.push(value !== undefined ? `${name}=${value}` : name);
  }
  return sanitized;
}

function formatCommand(bin: string, args: string[]) {
  return [bin, ...args].map(quoteArg).join(" ");
}

function quoteArg(arg: string) {
  if (/^[A-Za-z0-9._+=:-]+$/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/"/g, "\\\"")}"`;
}

async function runCommand(
  bin: string,
  args: string[],
  timeoutMs: number,
  maxCaptureChars: number
) {
  const start = Date.now();
  const child = spawn(bin, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let timedOut = false;

  const onStdout = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    if (stdout.length < maxCaptureChars) {
      const remaining = maxCaptureChars - stdout.length;
      stdout += text.slice(0, remaining);
      if (text.length > remaining) {
        stdoutTruncated = true;
      }
    } else {
      stdoutTruncated = true;
    }
  };

  const onStderr = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    if (stderr.length < maxCaptureChars) {
      const remaining = maxCaptureChars - stderr.length;
      stderr += text.slice(0, remaining);
      if (text.length > remaining) {
        stderrTruncated = true;
      }
    } else {
      stderrTruncated = true;
    }
  };

  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", onStderr);

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (code !== null) {
        resolve(code);
      } else {
        resolve(signal ? 128 : -1);
      }
    });
  });

  stdout = finalizeCapture(stdout, maxCaptureChars, stdoutTruncated);
  stderr = finalizeCapture(stderr, maxCaptureChars, stderrTruncated);

  return {
    exitCode,
    stdout,
    stderr,
    timedOut,
    durationMs: Date.now() - start
  };
}

function finalizeCapture(text: string, max: number, truncated: boolean) {
  if (!truncated) {
    return text;
  }
  const suffix = "\n...[truncated]";
  if (text.length + suffix.length <= max) {
    return text + suffix;
  }
  if (max <= suffix.length) {
    return suffix.slice(0, max);
  }
  return text.slice(0, max - suffix.length) + suffix;
}

async function collectJavaStats(outputDir: string) {
  const stats = {
    javaFiles: 0,
    packages: 0
  };
  const dirStat = await statOrNull(outputDir);
  if (!dirStat || !dirStat.isDirectory()) {
    return stats;
  }

  const packages = new Set<string>();
  const queue = [outputDir];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".java")) {
        continue;
      }
      stats.javaFiles += 1;
      const rel = path.relative(outputDir, entryPath);
      const dir = path.dirname(rel);
      const pkg = dir === "." ? "" : dir.split(path.sep).join(".");
      packages.add(pkg);
    }
  }
  stats.packages = packages.size;
  return stats;
}

async function handleIndex(
  args: z.infer<typeof IndexInputSchema>,
  allowedRoot: string
) {
  const sourceRoot = await resolvePathWithinAllowed(args.sourceRoot, allowedRoot, true);
  const rootStat = await fs.stat(sourceRoot);
  if (!rootStat.isDirectory()) {
    throw new Error(`sourceRoot is not a directory: ${args.sourceRoot}`);
  }

  const symbols: Record<string, { classes: string[]; files: string[] }> = {};
  const mains: Array<{ className: string | null; file: string; package: string }> = [];

  let javaFilesIndexed = 0;
  let servicesHints = 0;

  const queue = [sourceRoot];
  while (queue.length > 0 && javaFilesIndexed < args.maxFiles) {
    const current = queue.pop();
    if (!current) {
      continue;
    }
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (javaFilesIndexed >= args.maxFiles) {
        break;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".java")) {
        continue;
      }
      const stat = await fs.stat(entryPath);
      if (stat.size > args.maxFileBytes) {
        continue;
      }
      const content = await fs.readFile(entryPath, "utf8");
      const packageName = extractPackage(content);
      const classNames = extractClassNames(content);
      const hasMain = hasMainMethod(content);
      const hasServiceLoader = content.includes("ServiceLoader");

      const relPath = path.relative(sourceRoot, entryPath);
      if (!symbols[packageName]) {
        symbols[packageName] = { classes: [], files: [] };
      }
      const symbolEntry = symbols[packageName];
      for (const className of classNames) {
        if (!symbolEntry.classes.includes(className)) {
          symbolEntry.classes.push(className);
        }
      }
      if (!symbolEntry.files.includes(relPath)) {
        symbolEntry.files.push(relPath);
      }

      if (hasMain) {
        const className = classNames[0] ?? null;
        mains.push({
          className: className ? (packageName ? `${packageName}.${className}` : className) : null,
          file: relPath,
          package: packageName
        });
      }

      if (hasServiceLoader) {
        servicesHints += 1;
      }

      javaFilesIndexed += 1;
    }
  }

  const symbolsPath = path.join(sourceRoot, "symbols.json");
  const entrypointsPath = path.join(sourceRoot, "entrypoints.json");
  await fs.writeFile(symbolsPath, JSON.stringify(symbols, null, 2));
  await fs.writeFile(entrypointsPath, JSON.stringify({ mains }, null, 2));

  return {
    ok: true,
    sourceRoot,
    artifacts: {
      symbols: symbolsPath,
      entrypoints: entrypointsPath
    },
    stats: {
      javaFilesIndexed,
      packages: Object.keys(symbols).length,
      mains: mains.length,
      servicesHints
    }
  };
}

function extractPackage(content: string) {
  const match = content.match(/^\s*package\s+([a-zA-Z0-9_.]+)\s*;/m);
  return match?.[1] ?? "";
}

function extractClassNames(content: string) {
  const classRegex = /\b(class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  const names: string[] = [];
  let match: RegExpExecArray | null = null;
  while ((match = classRegex.exec(content))) {
    names.push(match[2]);
  }
  return names;
}

function hasMainMethod(content: string) {
  return /\bpublic\s+static\s+void\s+main\s*\(\s*String\s*(\[\s*\]|\.\.\.)\s+\w+\s*\)/.test(
    content
  );
}

main().catch((error) => {
  console.error("fatal error:", error);
  process.exit(1);
});
