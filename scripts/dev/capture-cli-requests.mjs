#!/usr/bin/env node
// Developer tool (not run in CI): records the HTTP requests Claude Code and Codex send to
// a model endpoint, for tests/fixtures/protocol-adapter/clients/.
//
//   node scripts/dev/capture-cli-requests.mjs serve [--port 0] [--out DIR] [--plan text]
//   node scripts/dev/capture-cli-requests.mjs record [--cli claude|codex|all]
//        [--claude-bin claude] [--codex-bin codex] [--out tests/fixtures/protocol-adapter/clients]
//
// Safety: the server binds 127.0.0.1 only, every CLI runs with throw-away HOME,
// CLAUDE_CONFIG_DIR / CODEX_HOME and working directory under the system temp dir, the
// credential is the literal "fixture", and outbound HTTP(S) is routed to a dead local proxy
// so a CLI can never reach a real model API.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { codexModelCatalog } from "../../server/features/providers/native-config.js";
import { messagesStream, responsesStream } from "./capture-cli-streams.mjs";

const SECRET_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "proxy-authorization",
]);
const MODEL = "qwen3-coder:30b";
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const mcpServer = path.join(import.meta.dirname, "fixture-mcp-server.mjs");

// ---------- capture server ----------

function cleanHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !SECRET_HEADERS.has(name.toLowerCase())),
  );
}

export function startCaptureServer({
  port = 0,
  plan = "text",
  reasoning = false,
  onRequest,
}) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = raw;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        // keep raw text
      }
      const record = {
        method: req.method,
        path: req.url,
        headers: cleanHeaders(req.headers),
        body,
      };
      onRequest?.(record);
      const pathname = req.url.split("?")[0];
      if (req.method === "POST" && pathname === "/v1/messages") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(messagesStream(body ?? {}, plan));
      } else if (
        req.method === "POST" &&
        ["/responses", "/v1/responses"].includes(pathname)
      ) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(responsesStream(body ?? {}, plan, { reasoning }));
      } else if (["HEAD", "GET"].includes(req.method) && pathname === "/api/hello") {
        res.writeHead(200).end();
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not found" } }));
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () =>
      resolve({ server, port: server.address().port }),
    ),
  );
}

// ---------- anonymization ----------

function replacer(pairs) {
  const ordered = pairs
    .filter(([from]) => from)
    .sort((a, b) => b[0].length - a[0].length);
  const generic = [
    [/\/(?:private\/)?var\/folders\/[^\s"'`]+?\/T\/[A-Za-z0-9._-]+/g, "/workspace"],
    [/\/(?:Users|home)\/(?!user\b)[^/\s"'`]+/g, "/home/user"],
    // Product addresses inside the CLI prompts (e.g. the commit trailer) are kept.
    [
      /\b(?!noreply@anthropic\.com\b)[A-Za-z0-9._%+-]+@(?!example\.test\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      "user@example.test",
    ],
  ];
  const apply = (text) => {
    let out = text;
    for (const [from, to] of ordered) out = out.split(from).join(to);
    for (const [pattern, to] of generic) out = out.replace(pattern, to);
    return out;
  };
  const walk = (value) => {
    if (typeof value === "string") return apply(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [apply(k), walk(v)]),
      );
    return value;
  };
  return walk;
}

// ---------- recorder ----------

function tempRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "capture-cli-")));
}

function runCli(command, args, { env, cwd, stdin, timeoutMs = 120_000 }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env,
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.stdin.end(stdin ?? "");
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(kill, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      kill();
      resolve({ code, output });
    });
  });
}

const deadProxy = {
  HTTPS_PROXY: "http://127.0.0.1:9",
  HTTP_PROXY: "http://127.0.0.1:9",
  https_proxy: "http://127.0.0.1:9",
  http_proxy: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
};

async function capture(spec, launch) {
  const root = tempRoot();
  const dirs = Object.fromEntries(
    ["home", "config", "work"].map((name) => [name, path.join(root, name)]),
  );
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  const records = [];
  const { server, port } = await startCaptureServer({
    plan: spec.plan,
    reasoning: spec.reasoning,
    onRequest: (record) => records.push(record),
  });
  try {
    const result = await runCli(...launch({ port, dirs }));
    return { records, result, root };
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

const claudeCases = [
  { name: "text", plan: "text", files: ["text"], prompt: "Reply with the word hello." },
  {
    name: "tool",
    plan: "bash",
    files: ["tool-call", "tool-result"],
    prompt: "List the files in the current directory.",
    args: ["--allowedTools", "Bash(ls)"],
  },
  {
    name: "mcp",
    plan: "mcp",
    files: ["mcp", "mcp-tool-result"],
    prompt: "Look up the project documentation for the topic adapters.",
    mcp: true,
  },
  { name: "image", plan: "text", files: ["image"], image: true },
];

function claudeLaunch(bin, spec) {
  return ({ port, dirs }) => {
    const args = ["-p", "--model", MODEL, ...(spec.args ?? [])];
    let stdin = spec.prompt;
    if (spec.mcp) {
      const config = {
        mcpServers: { fixture: { command: process.execPath, args: [mcpServer] } },
      };
      const file = path.join(dirs.config, "mcp.json");
      fs.writeFileSync(file, JSON.stringify(config));
      args.push(
        "--mcp-config",
        file,
        "--strict-mcp-config",
        "--allowedTools",
        "mcp__fixture",
      );
    }
    if (spec.image) {
      args.push(
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
      );
      const content = [
        { type: "text", text: "Describe this image." },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: PNG_1X1 },
        },
      ];
      stdin = `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
    }
    const env = {
      PATH: process.env.PATH,
      HOME: dirs.home,
      TMPDIR: dirs.home,
      TZ: "UTC",
      CLAUDE_CONFIG_DIR: dirs.config,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_AUTH_TOKEN: "fixture",
      ANTHROPIC_MODEL: MODEL,
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      ...deadProxy,
    };
    return [bin, args, { env, cwd: dirs.work, stdin }];
  };
}

const codexCases = [
  { name: "text", plan: "text", files: ["text"], prompt: "Reply with the word hello." },
  {
    name: "function-call",
    plan: "function",
    files: ["function-call", "function-call-output"],
    prompt: "List the files in the current directory.",
  },
  {
    name: "apply-patch",
    plan: "custom",
    files: ["apply-patch", "apply-patch-output"],
    prompt: "Create hello.txt containing hello.",
    args: ["--sandbox", "workspace-write"],
  },
  {
    name: "mcp",
    plan: "mcp",
    files: ["mcp", "mcp-output"],
    prompt: "Look up the project documentation for the topic adapters.",
    mcp: true,
  },
  {
    name: "web-search-disabled",
    plan: "text",
    files: ["web-search-disabled"],
    prompt: "Reply with the word hello.",
    args: ["-c", 'web_search="disabled"'],
  },
  {
    name: "reasoning",
    plan: "function",
    reasoning: true,
    files: ["reasoning", "reasoning-replay"],
    prompt: "List the files in the current directory.",
    args: ["-c", 'model_reasoning_effort="high"', "-c", 'model_reasoning_summary="auto"'],
  },
  {
    name: "image",
    plan: "text",
    files: ["image"],
    prompt: "Describe this image.",
    image: true,
  },
];

function codexLaunch(bin, spec) {
  return ({ port, dirs }) => {
    const catalog = codexModelCatalog(
      { modelId: MODEL, label: MODEL },
      {
        contextTokens: 131072,
        description: "Capture model",
        reasoning: Boolean(spec.reasoning),
      },
    );
    if (spec.image) catalog.models[0].input_modalities = ["text", "image"];
    const catalogFile = path.join(dirs.config, "models.json");
    fs.writeFileSync(catalogFile, JSON.stringify(catalog));
    const provider = `{name="capture",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",env_key="CAPTURE_KEY"}`;
    const args = [
      "exec",
      "--skip-git-repo-check",
      "-C",
      dirs.work,
      "-c",
      `model_providers.capture=${provider}`,
      "-c",
      "model_provider=capture",
      "-c",
      `model="${MODEL}"`,
      "-c",
      `model_catalog_json="${catalogFile}"`,
      ...(spec.args ?? []),
    ];
    if (spec.mcp) {
      args.push("-c", `mcp_servers.fixture.command="${process.execPath}"`);
      args.push("-c", `mcp_servers.fixture.args=["${mcpServer}"]`);
    }
    if (spec.image) {
      const image = path.join(dirs.work, "pixel.png");
      fs.writeFileSync(image, Buffer.from(PNG_1X1, "base64"));
      // `-i` takes several values; `--` keeps the prompt from being read as an image.
      args.push("-i", image, "--");
    }
    args.push(spec.prompt);
    const env = {
      PATH: process.env.PATH,
      HOME: dirs.home,
      TMPDIR: dirs.home,
      TZ: "UTC",
      CODEX_HOME: dirs.config,
      CAPTURE_KEY: "fixture",
      ...deadProxy,
    };
    return [bin, args, { env, cwd: dirs.work }];
  };
}

const isMainLoop = (record) =>
  record.method === "POST" &&
  /^\/v1\/(messages|responses)(\?|$)/.test(record.path) &&
  Array.isArray(record.body?.tools) &&
  record.body.tools.length > 0;

async function recordCli(label, cases, launchFor, outDir, rawDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const skipped = [];
  for (const spec of cases) {
    const { records, result, root } = await capture(spec, launchFor(spec));
    fs.writeFileSync(
      path.join(rawDir, `${label}-${spec.name}.json`),
      JSON.stringify({ records, result }, null, 2),
    );
    const scrub = replacer([
      [root, "/workspace"],
      // Claude Code names project folders after the cwd with every non-alphanumeric
      // character replaced by "-".
      [root.replace(/[^a-zA-Z0-9]/g, "-"), "-workspace"],
      [os.homedir(), "/home/user"],
      [os.userInfo().username, "user"],
      [os.hostname(), "host.example.test"],
    ]);
    const main = records.filter(isMainLoop);
    spec.files.forEach((file, index) => {
      const record = main[index];
      if (!record) {
        skipped.push(`${label}/${file}`);
        return;
      }
      const { path: requestPath, headers, body } = scrub(record);
      fs.writeFileSync(
        path.join(outDir, `${file}.json`),
        `${JSON.stringify({ path: requestPath, headers, body }, null, 2)}\n`,
      );
    });
    console.log(`${label}/${spec.name}: ${records.length} requests, exit ${result.code}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
  return skipped;
}

function option(args, name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}

async function main() {
  const [command = "serve", ...args] = process.argv.slice(2);
  if (command === "serve") {
    const out = option(args, "out");
    if (out) fs.mkdirSync(out, { recursive: true });
    let count = 0;
    const max = Number(option(args, "max", "0"));
    const { server, port } = await startCaptureServer({
      port: Number(option(args, "port", "0")),
      plan: option(args, "plan", "text"),
      reasoning: args.includes("--reasoning"),
      onRequest: (record) => {
        count += 1;
        if (out)
          fs.writeFileSync(
            path.join(out, `${String(count).padStart(3, "0")}.json`),
            JSON.stringify(record, null, 2),
          );
        if (max && count >= max) setImmediate(() => server.close());
      },
    });
    console.log(`capture server on http://127.0.0.1:${port}`);
    const timeout = Number(option(args, "timeout", "0"));
    if (timeout) setTimeout(() => process.exit(0), timeout).unref();
    return;
  }
  if (command !== "record") throw new Error(`Unknown command: ${command}`);
  const cli = option(args, "cli", "all");
  const out = path.resolve(
    option(args, "out", "tests/fixtures/protocol-adapter/clients"),
  );
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-raw-"));
  const skipped = [];
  if (cli === "all" || cli === "claude") {
    const bin = option(args, "claude-bin", "claude");
    skipped.push(
      ...(await recordCli(
        "claude-code",
        claudeCases,
        (spec) => claudeLaunch(bin, spec),
        path.join(out, "claude-code"),
        rawDir,
      )),
    );
  }
  if (cli === "all" || cli === "codex") {
    const bin = option(args, "codex-bin", "codex");
    skipped.push(
      ...(await recordCli(
        "codex",
        codexCases,
        (spec) => codexLaunch(bin, spec),
        path.join(out, "codex"),
        rawDir,
      )),
    );
  }
  console.log(`raw captures: ${rawDir}`);
  if (skipped.length) console.log(`not captured: ${skipped.join(", ")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
