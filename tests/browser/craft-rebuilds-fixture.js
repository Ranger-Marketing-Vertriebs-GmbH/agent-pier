import { isLiveStubRequest } from "../helpers/live-stub.js";

// A mocked Rebuilds API (server/http/routes/craft-rebuilds.js) for the Rebuilds page:
// three rebuilds (one waiting for a question and an approval, one building, one
// ready), the owner's defaults, two eligible Claude accounts and Craft Anything's
// stacks. Writes change the state as the server would; the live stub reads the
// GET routes again, so the page sees each change as a push.
export const waitingId = "0b8c1f7e-3d2a-4c5b-9e6f-7a8b9c0d1e2f";
export const buildingId = "5d6e7f80-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
export const readyId = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
export const startedId = "c0ffee00-1234-4abc-8def-0123456789ab";

const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();

const rebuild = (fields) => ({
  projectId: null,
  folder: null,
  target: "-",
  stack: "Builder's choice",
  rounds: 2,
  accountId: "local-claude",
  mode: "clean-room",
  autoMode: false,
  source: "owner",
  statusLabel: null,
  note: null,
  checks: [],
  similarity: null,
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  lastReply: null,
  questions: [],
  ...fields,
});

export function craftRebuilds() {
  return [
    rebuild({
      id: waitingId,
      projectId: "shop-clone",
      folder: "/fixture/projects/shop-clone",
      name: "shop-clone",
      request: "A shop front like the target, with a cart and a checkout page.",
      target: "https://shop.example",
      createdAt: ago(42),
      updatedAt: ago(1),
      status: "needs_you",
      statusLabel: "Needs you",
      note: "Building the cart page",
      step: "build",
      checks: [{ name: "build", passed: true, at: ago(5) }],
      similarity: 0.72,
      usage: { inputTokens: 182400, outputTokens: 24310, costUsd: 1.87 },
      lastReply: "The product list and the header are done.",
      questions: [
        {
          id: "q1",
          kind: "question",
          title: "Which colour should the buttons have?",
          detail: "The target uses two shades of blue.",
          choices: ["Dark blue", "Light blue"],
          allowText: true,
          action: null,
          askedAt: ago(2),
        },
        {
          id: "q2",
          kind: "approval",
          title: "Install the dependencies?",
          detail: "",
          choices: [],
          allowText: false,
          action: "npm install",
          askedAt: ago(1),
        },
      ],
    }),
    rebuild({
      id: buildingId,
      projectId: "notes-app",
      folder: "/fixture/projects/notes-app",
      name: "notes-app",
      request: "A notes app with folders and search.",
      stack: "React + TypeScript (Vite)",
      createdAt: ago(20),
      updatedAt: ago(3),
      status: "building",
      note: "Studying the target",
      step: "study",
      source: "session",
    }),
    rebuild({
      id: readyId,
      projectId: "timer",
      folder: "/fixture/projects/timer",
      name: "timer",
      request: "A pomodoro timer.",
      createdAt: ago(300),
      updatedAt: ago(240),
      status: "ready",
      step: "ready",
      checks: [{ name: "build", passed: true }],
      similarity: 0.91,
    }),
  ];
}

/**
 * Routes `/api/**` of `page`. Options: `installed` (Craft Anything installed),
 * `rebuilds` (the list), `language`. Returns the state: `rebuilds`, `settings` and
 * `calls` (every request the app made, `{ path, method, body }`).
 */
export async function craftRebuildsFixture(
  page,
  { installed = true, rebuilds = craftRebuilds(), language = "en" } = {},
) {
  if (language)
    await page.addInitScript(
      (value) => localStorage.setItem("agentpier-language", value),
      language,
    );
  const state = {
    rebuilds,
    settings: { accountId: "local-claude", mode: "clean-room", autoMode: false },
    calls: [],
  };
  const list = () => ({
    rebuilds: state.rebuilds,
    settings: state.settings,
    accounts: [
      { id: "local-claude", name: "local-claude" },
      { id: "work-claude", name: "Work" },
    ],
    stacks: ["Builder's choice", "Plain HTML and CSS", "React + TypeScript (Vite)"],
    installed,
  });
  const find = (id) => state.rebuilds.find((item) => item.id === id);
  const change = (item, fields) =>
    Object.assign(item, fields, { updatedAt: new Date().toISOString() });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice(4);
    const method = request.method();
    const body = ["POST", "PUT"].includes(method) ? request.postDataJSON() : null;
    if (!isLiveStubRequest(request)) state.calls.push({ path, method, body });
    const json = (value, status = 200) => route.fulfill({ status, json: value });
    if (path === "/assistant-feature") return json({ enabled: false, error: null });
    if (path === "/state")
      return json({
        tools: [{ id: "claude", name: "claude", installed: true }],
        accounts: [{ id: "local-claude", tool: "claude", kind: "local", name: "Local" }],
        sessions: [],
        home: "/fixture",
        defaultCwd: "/fixture/projects",
      });
    if (path === "/craft/rebuilds" && method === "GET") return json(list());
    if (path === "/craft/rebuilds" && method === "POST") {
      const known = state.rebuilds.find((item) => item.requestId === body.requestId);
      if (known) return json(known, 201);
      const created = rebuild({
        id: startedId,
        requestId: body.requestId,
        projectId: "todo-app",
        folder: "/fixture/projects/todo-app",
        name: "todo-app",
        request: body.request,
        target: body.target,
        stack: body.stack,
        rounds: body.rounds,
        accountId: body.accountId,
        mode: body.mode,
        autoMode: body.autoMode,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "starting",
        step: "study",
      });
      state.rebuilds.push(created);
      return json(created, 201);
    }
    if (path === "/craft/settings" && method === "PUT") {
      state.settings = body;
      return json(state.settings);
    }
    const match = /^\/craft\/rebuilds\/([^/]+)(?:\/([a-z-]+))?$/.exec(path);
    const item = match && find(match[1]);
    if (match && !item) return json({ error: "Not found" }, 404);
    if (match && !match[2]) return json({ rebuild: item });
    if (match?.[2] === "activity")
      return json({
        lines: [
          "Reading the target",
          "Captured 6 pages",
          `Working on: ${item.note || item.request}`,
        ],
      });
    if (match?.[2] === "pause") return json(change(item, { status: "paused" }));
    if (match?.[2] === "continue") return json(change(item, { status: "building" }));
    if (match?.[2] === "follow-up")
      return json(change(item, { status: "building", step: "build" }));
    if (match?.[2] === "auto-mode") return json(change(item, { autoMode: body.on }));
    if (match?.[2] === "answer") {
      const questions = item.questions.filter((q) => q.id !== body.questionId);
      return json(
        change(item, {
          questions,
          status: questions.length ? item.status : "building",
        }),
      );
    }
    return json({});
  });
  return state;
}
