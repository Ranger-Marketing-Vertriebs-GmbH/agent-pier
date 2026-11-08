/**
 * A fake `craft-anything-cli mcp` for tests: newline-delimited JSON-RPC 2.0 (MCP)
 * over stdio, the tool contract of Craft Anything 0.5.0, and no Claude or network.
 *
 *   node tests/helpers/fake-craft-mcp.mjs mcp --all-tools --allow-run
 *
 * Like the real binary it ignores SIGTERM, exits at once when stdin closes (leaving
 * its builders behind), answers tool results as
 * `{ content: [{ type: "text", text }], structuredContent, isError }` with
 * `{ result }` or `{ error: { code, message } }`, and sends `notifications/progress`
 * before each tool result. `rebuild_start` needs `--allow-run`.
 *
 * Each project lives in its `project_folder`: `craft.json` (request, target, stack,
 * status — `building`, `needs_you`, `stopped`, `ready` or `failed` as in 0.5.0 — note, checks, questions, conversation, agent_session and, for tests,
 * `fake_builder: { pid, claude_config_dir }`), `usage.json` and
 * `build-activity.log`. The project index (name → folder) is kept in
 * `$CRAFT_ANYTHING_CONFIG_DIR/fake-craft-projects.json`, so a new server finds the
 * projects of an earlier one (resume after a restart). The builder is
 * `/bin/sh -c "sleep 600 & wait" fake-craft-builder <folder>` in its own process
 * group; it inherits the server's environment.
 *
 * FAKE_CRAFT_SCRIPT (JSON, optional) drives every build round:
 *   {
 *     "steps": [                        // run in order after each rebuild_start
 *       { "wait": 200 },                // pause (ms)
 *       { "activity": "Reading the target" },          // a build-activity.log line
 *       { "ask": "question", "title": "Which colour?", "detail": "…",
 *         "choices": ["Red", "Blue"], "allow_text": true },  // waits for an answer
 *       { "ask": "approval", "title": "Run npm install?", "action": "npm install" },
 *       { "usage": { "input_tokens": 10, "output_tokens": 5, "cost_usd": 0.01 } },
 *       { "check": { "name": "build", "passed": true } },
 *       { "finish": "ready" | "failed", "note": "Done", "reply": "All set" }
 *     ],
 *     "hideTools": ["rebuild_start"],    // left out of tools/list
 *     "slowTools": { "rebuild_status": 5000 },  // answer these tools late (ms)
 *     "emptyTools": ["rebuild_start"],  // run these, then answer { result: {} }
 *     "silentInit": true,               // never answer initialize
 *     "ignoreStdinClose": true          // keep running when stdin closes
 *   }
 * Without steps a build runs until rebuild_stop. A question waits for
 * project_inbox_answer; in mode "decide" (project_questions_set) questions are
 * decided by the fake itself, approvals still wait. Resuming continues at the step
 * where the build stopped; a follow-up starts the steps again. While a question is
 * open the steps wait, also after a resume, until it is answered.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import path from "node:path";

const script = process.env.FAKE_CRAFT_SCRIPT
  ? JSON.parse(process.env.FAKE_CRAFT_SCRIPT)
  : {};
const steps = Array.isArray(script.steps) ? script.steps : [];
const allowRun = process.argv.includes("--allow-run");
const configDir = process.env.CRAFT_ANYTHING_CONFIG_DIR;
const indexFile = configDir && path.join(configDir, "fake-craft-projects.json");
const LABELS = {
  building: "Building",
  needs_you: "Needs you",
  stopped: "Paused",
  ready: "Ready",
  failed: "Failed",
};

process.on("SIGTERM", () => {}); // The real server ignores SIGTERM for seconds.

class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// --- Project state -------------------------------------------------------------

const projects = new Map(); // name → { folder, builder, step, timer, generation }

function readIndex() {
  try {
    return JSON.parse(readFileSync(indexFile, "utf8"));
  } catch {
    return {};
  }
}

function writeIndex() {
  if (!indexFile) return;
  mkdirSync(configDir, { recursive: true });
  const index = readIndex();
  for (const [name, project] of projects) index[name] = project.folder;
  writeFileSync(indexFile, JSON.stringify(index, null, 2));
}

function project(name) {
  if (typeof name !== "string" || !name)
    throw new ToolError("invalid_arguments", "project is required.");
  if (!projects.has(name)) {
    const folder = readIndex()[name];
    if (!folder || !existsSync(path.join(folder, "craft.json")))
      throw new ToolError("project_not_found", `No project named ${name}.`);
    projects.set(name, { name, folder, builder: null, step: 0, generation: 0 });
  }
  return projects.get(name);
}

const recordFile = (entry) => path.join(entry.folder, "craft.json");
const read = (entry) => JSON.parse(readFileSync(recordFile(entry), "utf8"));
function write(entry, record) {
  record.updated_at = new Date().toISOString();
  writeFileSync(recordFile(entry), JSON.stringify(record, null, 2));
}
function update(entry, change) {
  const record = read(entry);
  change(record);
  write(entry, record);
  return record;
}
function activity(entry, line) {
  appendFileSync(
    path.join(entry.folder, "build-activity.log"),
    `${new Date().toISOString()} ${line}\n`,
  );
}
function readUsage(entry) {
  try {
    return JSON.parse(readFileSync(path.join(entry.folder, "usage.json"), "utf8"));
  } catch {
    return { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  }
}

// --- Builder -------------------------------------------------------------------

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function startBuilder(entry) {
  const builder = spawn(
    "/bin/sh",
    ["-c", "sleep 600 & wait", "fake-craft-builder", entry.folder],
    { detached: true, stdio: "ignore" },
  );
  builder.unref();
  entry.builder = builder;
  entry.generation += 1;
  const generation = entry.generation;
  builder.once("exit", () => {
    if (entry.generation !== generation || entry.builder !== builder) return;
    entry.builder = null;
    // A builder that died on its own fails the build.
    try {
      update(entry, (r) => {
        if (r.status !== "building" && r.status !== "needs_you") return;
        r.status = "failed";
        r.note = "The builder ended unexpectedly.";
      });
    } catch {
      // The project folder is gone.
    }
  });
  update(entry, (record) => {
    record.status = record.questions.length ? "needs_you" : "building";
    record.note = record.questions.length ? record.questions[0].title : "Building";
    record.fake_builder = {
      pid: builder.pid,
      claude_config_dir: process.env.CLAUDE_CONFIG_DIR ?? null,
    };
  });
  activity(entry, `Builder started (pid ${builder.pid})`);
}

function stopBuilder(entry) {
  entry.generation += 1; // Pending script steps and exit handlers lapse.
  clearTimeout(entry.timer);
  const builder = entry.builder;
  entry.builder = null;
  if (builder?.pid && alive(builder.pid)) {
    try {
      process.kill(-builder.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

// --- Script --------------------------------------------------------------------

function runSteps(entry) {
  const generation = entry.generation;
  const next = (delay = 0) => {
    entry.timer = setTimeout(() => {
      if (entry.generation !== generation) return;
      const step = steps[entry.step];
      if (!step) return;
      entry.step += 1;
      const delay = perform(entry, step);
      if (delay !== undefined) next(delay);
    }, delay);
  };
  next();
}

/** Performs one step; returns the delay before the next, or undefined to wait. */
function perform(entry, step) {
  if (step.wait) return step.wait;
  if (step.activity) activity(entry, step.activity);
  if (step.usage) {
    const usage = readUsage(entry);
    for (const [key, value] of Object.entries(step.usage))
      usage[key] = (usage[key] ?? 0) + value;
    writeFileSync(path.join(entry.folder, "usage.json"), JSON.stringify(usage, null, 2));
  }
  if (step.check)
    update(entry, (record) => {
      record.checks.push({ ...step.check, at: new Date().toISOString() });
      record.last_check = record.checks.at(-1);
    });
  if (step.ask) {
    const record = read(entry);
    if (step.ask === "question" && record.questions_mode === "decide") {
      const choice = step.choices?.[0] ?? "decided";
      update(entry, (r) =>
        r.conversation.push({
          role: "builder",
          text: `Decided: ${step.title} → ${choice}`,
        }),
      );
      activity(entry, `Decided ${step.title}: ${choice}`);
      return 0;
    }
    const question = {
      id: `q${record.questions_asked + 1}`,
      kind: step.ask === "approval" ? "approval" : "question",
      title: step.title ?? "A question",
      detail: step.detail ?? "",
      choices: step.choices ?? [],
      allow_text: Boolean(step.allow_text),
      action: step.action ?? null,
    };
    update(entry, (r) => {
      r.questions_asked += 1;
      r.questions.push(question);
      r.status = "needs_you";
      r.note = question.title;
    });
    activity(entry, `Asked ${question.kind} ${question.id}: ${question.title}`);
    return undefined;
  }
  if (step.finish) {
    const builder = entry.builder;
    entry.builder = null;
    if (builder?.pid) {
      try {
        process.kill(-builder.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    update(entry, (record) => {
      record.status = step.finish === "failed" ? "failed" : "ready";
      record.note = step.note ?? LABELS[record.status];
      if (step.reply) record.last_reply = step.reply;
    });
    activity(entry, `Build ${step.finish}`);
    return undefined;
  }
  return 0;
}

// --- Tools ---------------------------------------------------------------------

function uniqueName(folder) {
  const base =
    path
      .basename(folder)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-") || "app";
  const taken = readIndex();
  for (const [key, entry] of projects) taken[key] = entry.folder;
  let name = base;
  for (let n = 2; taken[name] && taken[name] !== folder; n += 1) name = `${base}-${n}`;
  return name;
}

function startRound(entry, { resume = false } = {}) {
  if (entry.builder) throw new ToolError("already_running", `${entry.name} is building.`);
  if (!resume) entry.step = 0;
  startBuilder(entry);
  // Open questions hold the steps; answering them starts the (one) chain again.
  if (!read(entry).questions.length) runSteps(entry);
}

const tools = {
  rebuild_start(args) {
    if (!allowRun)
      throw new ToolError("run_not_allowed", "rebuild_start needs --allow-run.");
    if (args.project) {
      const entry = project(args.project);
      if (args.resume) {
        // Like Craft Anything 0.5.0, which refuses a resume without the request.
        if (!args.request)
          throw new ToolError("invalid_arguments", "missing field `request`.");
        startRound(entry, { resume: true });
        activity(entry, "Resumed");
      } else {
        if (!args.request)
          throw new ToolError("invalid_arguments", "request is required.");
        update(entry, (r) => r.conversation.push({ role: "user", text: args.request }));
        startRound(entry);
        activity(entry, `Follow-up: ${args.request}`);
      }
      return { project: entry.name, started: true };
    }
    if (!args.request || !args.target)
      throw new ToolError("invalid_arguments", "request and target are required.");
    if (!args.project_folder || !path.isAbsolute(args.project_folder))
      throw new ToolError(
        "invalid_arguments",
        "project_folder must be an absolute path.",
      );
    const folder = args.project_folder;
    mkdirSync(path.join(folder, "app"), { recursive: true });
    const name = uniqueName(folder);
    const entry = { name, folder, builder: null, step: 0, generation: 0 };
    projects.set(name, entry);
    write(entry, {
      project: name,
      request: args.request,
      target: args.target,
      stack: args.build_with ?? "Builder's choice",
      rounds: args.rounds ?? null,
      status: "building",
      note: "Building the first version…",
      checks: [],
      last_check: null,
      questions: [],
      questions_asked: 0,
      questions_mode: "ask",
      last_reply: null,
      conversation: [{ role: "user", text: args.request }],
      agent_session: `fake-session-${name}`,
    });
    writeFileSync(
      path.join(folder, "usage.json"),
      JSON.stringify({ input_tokens: 0, output_tokens: 0, cost_usd: 0 }, null, 2),
    );
    activity(entry, `Rebuild started: ${args.request}`);
    writeIndex();
    startRound(entry);
    return { project: name, started: true };
  },
  rebuild_status({ project: name }) {
    const entry = project(name);
    const record = read(entry);
    return {
      running: Boolean(entry.builder),
      queued: false,
      status: record.status,
      status_label: LABELS[record.status] ?? record.status,
      note: record.note,
      waiting: record.questions.length,
      last_check: record.last_check,
    };
  },
  project_show({ project: name }) {
    const entry = project(name);
    const record = read(entry);
    return {
      status: record.status,
      note: record.note,
      checks: record.checks,
      usage: readUsage(entry),
      last_reply: record.last_reply,
      questions: record.questions,
      conversation: record.conversation,
    };
  },
  project_inbox_answer({ project: name, id, choice, text, allow, always }) {
    const entry = project(name);
    const record = read(entry);
    const question = record.questions.find((q) => q.id === id);
    if (!question)
      throw new ToolError("question_not_found", `No open question ${id} in ${name}.`);
    const answer =
      question.kind === "approval"
        ? allow
          ? `allowed${always ? " always" : ""}`
          : "denied"
        : (choice ?? text ?? "");
    update(entry, (r) => {
      r.questions = r.questions.filter((q) => q.id !== id);
      r.conversation.push({ role: "user", text: `${question.title}: ${answer}` });
      if (r.status === "needs_you" && !r.questions.length) {
        r.status = entry.builder ? "building" : "stopped";
        r.note = "Building";
      }
    });
    activity(entry, `Answered ${id}: ${answer}`);
    // The steps waited for this answer; they go on once nothing else is open.
    if (entry.builder && !read(entry).questions.length) runSteps(entry);
    return { answered: true };
  },
  project_questions_set({ project: name, mode }) {
    if (!["ask", "decide", "default"].includes(mode))
      throw new ToolError("invalid_arguments", "mode must be ask, decide or default.");
    const entry = project(name);
    update(entry, (r) => (r.questions_mode = mode === "default" ? "ask" : mode));
    return { mode };
  },
  rebuild_stop({ project: name }) {
    const entry = project(name);
    const running = Boolean(entry.builder);
    stopBuilder(entry);
    update(entry, (r) => {
      if (["building", "needs_you"].includes(r.status) || running) {
        r.status = "stopped";
        r.note = "Stopped by request";
      }
    });
    activity(entry, "Stopped");
    return { stopping: running };
  },
  rebuild_activity_show({ project: name, limit = 100 }) {
    const entry = project(name);
    let lines = [];
    try {
      lines = readFileSync(path.join(entry.folder, "build-activity.log"), "utf8")
        .split("\n")
        .filter(Boolean);
    } catch {
      // No activity yet.
    }
    return { lines: lines.slice(-Math.max(1, Number(limit) || 100)) };
  },
};

const toolList = Object.keys(tools)
  .filter((name) => !(script.hideTools ?? []).includes(name))
  .map((name) => ({
    name,
    description: `Fake ${name}`,
    inputSchema: { type: "object" },
  }));

// --- JSON-RPC ------------------------------------------------------------------

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function toolResult(payload, isError) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError,
  };
}

function callTool(id, { name, arguments: args = {} } = {}) {
  send({
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { progressToken: id, progress: 0, message: `Calling ${name}` },
  });
  if (!tools[name] || (script.hideTools ?? []).includes(name))
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: `Unknown tool ${name}` },
    };
  try {
    const result = tools[name](args);
    return {
      jsonrpc: "2.0",
      id,
      result: toolResult(
        { result: (script.emptyTools ?? []).includes(name) ? {} : result },
        false,
      ),
    };
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    const payload = { error: { code: error.code, message: error.message } };
    return { jsonrpc: "2.0", id, result: toolResult(payload, true) };
  }
}

function handle(message) {
  const { id, method, params } = message;
  if (id === undefined || id === null) return; // Notifications need no answer.
  if (method === "initialize" && script.silentInit) return;
  if (method === "initialize")
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-craft-anything", version: "0.5.0" },
      },
    });
  if (method === "tools/list")
    return send({ jsonrpc: "2.0", id, result: { tools: toolList } });
  if (method === "tools/call") {
    const delay = script.slowTools?.[params?.name];
    if (delay) return setTimeout(() => send(callTool(id, params)), delay);
    return send(callTool(id, params));
  }
  send({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Unknown method ${method}` },
  });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: String(error) } });
    }
  }
});
// Like the real server: stdin closing ends it at once, builders are left running.
if (!script.ignoreStdinClose) {
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
}
