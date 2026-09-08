import test from "node:test";
import assert from "node:assert/strict";

const history = await import("../../server/features/chat/history-parsers.js");
const { normalizeClaude, normalizeCodex, normalizeOpenCode } = history;
const assistant = (id, content) => ({
  type: "assistant",
  uuid: id,
  message: { id, role: "assistant", content },
});
const result = (id, content, is_error = false) => ({
  type: "user",
  uuid: `result-${id}`,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content, is_error }],
  },
});
const call = (id, name, input) =>
  assistant(`message-${id}`, [{ type: "tool_use", id, name, input }]);

test("provider normalizers are available", () => {
  for (const name of ["normalizeClaude", "normalizeCodex", "normalizeOpenCode"])
    assert.equal(typeof history[name], "function");
});

test("Claude preserves code and TUI-like user text, hides internal records and reasoning", () => {
  const code = '```js\n  const x = "• Working…";\n\n  run(x);\n```';
  const records = [
    { type: "system", message: { content: "internal" } },
    { type: "progress", data: { message: "internal progress" } },
    { type: "summary", summary: "internal summary" },
    {
      type: "user",
      uuid: "u",
      timestamp: "2026-09-06T10:00:00Z",
      message: { role: "user", content: "❯ Working…\nPress enter to continue" },
    },
    assistant("a", [
      { type: "thinking", thinking: "secret" },
      { type: "text", text: code },
    ]),
  ];
  assert.deepEqual(normalizeClaude(records), {
    messages: [
      {
        id: "u",
        role: "user",
        text: "❯ Working…\nPress enter to continue",
        timestamp: "2026-09-06T10:00:00Z",
      },
      { id: "a:1", role: "assistant", text: code },
    ],
    tasks: [],
  });
});

test("Claude folds tool results into calls and replaces duplicate assistant snapshots", () => {
  const records = [
    assistant("a", [{ type: "text", text: "Checking" }]),
    assistant("a", [
      { type: "text", text: "Checking now" },
      { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "pwd" } },
    ]),
    {
      type: "user",
      uuid: "r",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "bash-1", content: "  /tmp\n" },
          { type: "text", text: "Injected wrapper" },
        ],
      },
    },
  ];
  const normalized = normalizeClaude(records);
  assert.equal(normalized.messages.length, 2);
  assert.deepEqual(normalized.messages[0], {
    id: "a:0",
    role: "assistant",
    text: "Checking now",
  });
  assert.equal(normalized.messages[1].id, "bash-1");
  assert.equal(normalized.messages[1].role, "tool");
  assert.equal(normalized.messages[1].toolName, "Bash");
  assert.equal(normalized.messages[1].status, "completed");
  assert.ok(normalized.messages[1].text.endsWith("  /tmp\n"));
  assert.equal(normalizeClaude(records.slice(0, 2)).messages[1].status, "running");
});

test("Claude task lists use tool state, preserve IDs through transitions, and replace deleted todos", () => {
  const records = [
    call("t1", "TodoWrite", {
      todos: [
        { content: "Build", status: "in_progress" },
        { content: "Test", status: "pending" },
      ],
    }),
    call("t2", "TodoWrite", { todos: [{ content: "Build", status: "completed" }] }),
  ];
  const before = normalizeClaude(records.slice(0, 1)).tasks;
  const after = normalizeClaude(records).tasks;
  assert.deepEqual(after, [{ id: before[0].id, text: "Build", status: "completed" }]);
  assert.deepEqual(
    normalizeClaude([...records, call("t3", "TodoWrite", { todos: [] })]).tasks,
    [],
  );
});

test("Claude TaskCreate uses result IDs; TaskUpdate renames, transitions and deletes exact tasks", () => {
  const records = [
    call("create1", "TaskCreate", { subject: "Build", description: "Build it" }),
    result("create1", "Task #41 created successfully: Build"),
    call("create2", "TaskCreate", { subject: "Test" }),
    result("create2", [
      { type: "text", text: '{"task":{"id":"42","subject":"Test","status":"pending"}}' },
    ]),
    call("update1", "TaskUpdate", {
      taskId: "41",
      subject: "Build app",
      status: "completed",
    }),
    result("update1", "Updated task #41"),
    call("delete1", "TaskUpdate", { taskId: "42", status: "deleted" }),
    result("delete1", "Deleted task #42"),
    call("badcreate", "TaskCreate", { subject: "Never created" }),
    result("badcreate", "Permission denied", true),
    call("badupdate", "TaskUpdate", { taskId: "41", status: "pending" }),
    result("badupdate", "Permission denied", true),
  ];
  assert.deepEqual(normalizeClaude(records).tasks, [
    { id: "41", text: "Build app", status: "completed" },
  ]);
  assert.deepEqual(
    normalizeClaude([call("unconfirmed", "TaskCreate", { subject: "No actual ID" })])
      .tasks,
    [],
  );
});

test("Codex maps only supported visible items and preserves tool output and code spacing", () => {
  const thread = {
    id: "thread",
    turns: [
      {
        id: "turn",
        status: "completed",
        items: [
          {
            id: "u",
            type: "userMessage",
            content: [{ type: "text", text: "❯ Running…\n  literal" }],
          },
          { id: "r", type: "reasoning", summary: ["private"], content: ["private"] },
          { id: "a", type: "agentMessage", text: "```\n  code\n```" },
          {
            id: "cmd",
            type: "commandExecution",
            command: "pwd",
            aggregatedOutput: "  /tmp\n",
            status: "completed",
            exitCode: 0,
          },
          {
            id: "files",
            type: "fileChange",
            changes: [
              { path: "x.js", diff: "  unchanged\n+ new", kind: { type: "update" } },
            ],
            status: "failed",
          },
          { id: "plan", type: "plan", text: "- [ ] A prose plan" },
          { id: "hook", type: "hookPrompt", text: "internal" },
          { id: "sys", type: "contextCompaction" },
        ],
      },
    ],
  };
  const { messages, tasks } = normalizeCodex(thread);
  assert.deepEqual(
    messages.map((m) => [m.id, m.role]),
    [
      ["u", "user"],
      ["a", "assistant"],
      ["cmd", "tool"],
      ["files", "tool"],
      ["plan", "assistant"],
    ],
  );
  assert.equal(messages[0].text, "❯ Running…\n  literal");
  assert.equal(messages[1].text, "```\n  code\n```");
  assert.ok(messages[2].text.endsWith("  /tmp\n"));
  assert.equal(messages[3].status, "failed");
  assert.deepEqual(tasks, []);
});

test("Codex structured update_plan and enriched turn plans carry task state without deriving prose checklists", () => {
  const turns = [
    {
      id: "t1",
      status: "completed",
      items: [
        {
          id: "p1",
          type: "dynamicToolCall",
          tool: "update_plan",
          arguments: {
            plan: [
              { step: "Build", status: "in_progress" },
              { step: "Test", status: "pending" },
            ],
          },
          status: "completed",
        },
      ],
    },
    {
      id: "t2",
      status: "completed",
      items: [
        {
          id: "p2",
          type: "mcpToolCall",
          server: "functions",
          tool: "update_plan",
          arguments: JSON.stringify({
            plan: [
              { step: "Build", status: "completed" },
              { step: "Test", status: "in_progress" },
            ],
          }),
          status: "completed",
          result: { content: [{ type: "text", text: "Plan updated" }] },
        },
      ],
    },
  ];
  const first = normalizeCodex({ turns: turns.slice(0, 1) }).tasks;
  const next = normalizeCodex({ turns }).tasks;
  assert.equal(next[0].id, first[0].id);
  assert.deepEqual(
    next.map(({ text, status }) => ({ text, status })),
    [
      { text: "Build", status: "completed" },
      { text: "Test", status: "in_progress" },
    ],
  );
  assert.deepEqual(
    normalizeCodex({ turns: [...turns, { items: [], plan: [] }] }).tasks,
    [],
  );
  assert.equal(
    normalizeCodex({
      turns: [{ items: [], plan: [{ step: "Current", status: "inProgress" }] }],
    }).tasks[0].status,
    "in_progress",
  );
});

test("OpenCode exports separate visible text and tools while retaining stable part IDs", () => {
  const exported = {
    info: { id: "session" },
    messages: [
      {
        info: { id: "u", role: "user", time: { created: 1000 } },
        parts: [{ id: "ut", type: "text", text: "Working…\n  literal" }],
      },
      {
        info: { id: "a", role: "assistant", time: { created: 2000 } },
        parts: [
          { id: "r", type: "reasoning", text: "private" },
          { id: "at", type: "text", text: "```\n  code\n```" },
          {
            id: "tool",
            type: "tool",
            tool: "bash",
            state: { status: "error", input: { command: "false" }, error: "  failed\n" },
          },
        ],
      },
      {
        info: { id: "system", role: "system" },
        parts: [{ type: "text", text: "private" }],
      },
    ],
  };
  const { messages, tasks } = normalizeOpenCode(exported);
  assert.deepEqual(
    messages.map((m) => [m.id, m.role]),
    [
      ["ut", "user"],
      ["at", "assistant"],
      ["tool", "tool"],
    ],
  );
  assert.equal(messages[1].text, "```\n  code\n```");
  assert.equal(messages[2].status, "failed");
  assert.ok(messages[2].text.endsWith("  failed\n"));
  assert.deepEqual(tasks, []);
});

test("OpenCode todos update, remove cancelled tasks, and obey explicit final snapshot", () => {
  const messages = [
    {
      info: { id: "a", role: "assistant" },
      parts: [
        {
          id: "todo",
          type: "tool",
          tool: "todowrite",
          state: {
            status: "completed",
            input: {
              todos: [
                { id: "1", content: "Build", status: "completed" },
                { id: "2", content: "Skip", status: "cancelled" },
              ],
            },
            output: "Todos updated",
          },
        },
      ],
    },
  ];
  assert.deepEqual(normalizeOpenCode({ messages }).tasks, [
    { id: "1", text: "Build", status: "completed" },
  ]);
  assert.deepEqual(normalizeOpenCode({ messages, todos: [] }).tasks, []);
});

test("all parsers are defensive, pure, deterministic and do not fabricate prose tasks", () => {
  for (const normalize of [normalizeClaude, normalizeCodex, normalizeOpenCode]) {
    for (const malformed of [
      undefined,
      null,
      2,
      "bad",
      {},
      [null, false, {}, { message: null }],
    ])
      assert.doesNotThrow(() => normalize(malformed));
  }
  const fixtures = [
    [
      normalizeClaude,
      [
        null,
        assistant("a", [{ type: "text", text: "- [ ] A task in prose" }]),
        { type: "user", message: { content: [null] } },
      ],
    ],
    [
      normalizeCodex,
      {
        turns: [
          null,
          {
            items: [
              null,
              { id: "a", type: "agentMessage", text: "- [ ] A task in prose" },
            ],
          },
        ],
      },
    ],
    [
      normalizeOpenCode,
      {
        messages: [
          null,
          {
            info: { role: "assistant" },
            parts: [null, { type: "text", text: "- [ ] A task in prose" }],
          },
        ],
      },
    ],
  ];
  for (const [normalize, input] of fixtures) {
    const before = structuredClone(input);
    const value = normalize(input);
    assert.deepEqual(input, before);
    assert.deepEqual(normalize(input), value);
    assert.deepEqual(value.tasks, []);
    assert.ok(
      value.messages.every((m) => ["user", "assistant", "tool"].includes(m.role)),
    );
  }
});

test("Claude retains separately persisted tool blocks sharing an assistant message ID", () => {
  const records = [
    assistant("same", [{ type: "text", text: "Checking" }]),
    assistant("same", [
      { type: "tool_use", id: "first", name: "Read", input: { file_path: "a.js" } },
    ]),
    assistant("same", [
      { type: "tool_use", id: "second", name: "Read", input: { file_path: "b.js" } },
    ]),
    result("first", "a"),
    result("second", "b"),
  ];
  assert.deepEqual(
    normalizeClaude(records).messages.map((m) => [m.id, m.role]),
    [
      ["same:0", "assistant"],
      ["first", "tool"],
      ["second", "tool"],
    ],
  );
});

test("Codex rollout parses structured plan transitions and folds call output without duplicate event messages", () => {
  assert.equal(typeof history.normalizeCodexRecords, "function");
  const records = [
    { type: "event_msg", payload: { type: "user_message", message: "Build" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Build" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "p1",
        name: "update_plan",
        arguments:
          '{"plan":[{"step":"Build","status":"in_progress"},{"step":"Test","status":"pending"}]}',
      },
    },
    {
      type: "response_item",
      payload: { type: "function_call_output", call_id: "p1", output: "Plan updated" },
    },
    {
      type: "event_msg",
      payload: { type: "agent_message", message: "```\n  hello\n```" },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "```\n  hello\n```" }],
      },
    },
    {
      type: "response_item",
      payload: { type: "reasoning", summary: [{ text: "secret" }] },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "private" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "p2",
        name: "update_plan",
        arguments: '{"plan":[{"step":"Build","status":"completed"}]}',
      },
    },
  ];
  const before = structuredClone(records);
  const value = history.normalizeCodexRecords(records);
  assert.deepEqual(
    value.messages.map((m) => m.role),
    ["user", "tool", "assistant", "tool"],
  );
  assert.equal(value.messages[2].text, "```\n  hello\n```");
  assert.equal(value.messages[1].id, "p1");
  assert.equal(value.messages[1].status, "completed");
  assert.deepEqual(
    value.tasks.map(({ text, status }) => ({ text, status })),
    [{ text: "Build", status: "completed" }],
  );
  assert.deepEqual(records, before);
  assert.deepEqual(
    history.normalizeCodexRecords([null, {}, { type: "response_item", payload: null }]),
    { messages: [], tasks: [] },
  );
});

test("Codex event-only rollout preserves intentional repeated utterances", () => {
  assert.equal(typeof history.normalizeCodexRecords, "function");
  const records = [
    { type: "event_msg", payload: { type: "user_message", message: "Continue" } },
    { type: "event_msg", payload: { type: "agent_message", message: "Done" } },
    { type: "event_msg", payload: { type: "user_message", message: "Continue" } },
  ];
  assert.deepEqual(
    history.normalizeCodexRecords(records).messages.map((m) => m.text),
    ["Continue", "Done", "Continue"],
  );
});

test("malformed task statuses cannot create tasks and failed plan updates preserve the last valid plan", () => {
  const records = [
    {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "good",
        name: "update_plan",
        arguments: '{"plan":[{"step":"Build","status":"pending"}]}',
      },
    },
    {
      type: "response_item",
      payload: { type: "function_call_output", call_id: "good", output: "Plan updated" },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "bad",
        name: "update_plan",
        arguments: '{"plan":[]}',
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "bad",
        output: "Rejected",
        is_error: true,
      },
    },
  ];
  assert.deepEqual(
    history.normalizeCodexRecords(records).tasks.map((t) => t.text),
    ["Build"],
  );
  assert.deepEqual(
    normalizeOpenCode({
      todos: [
        null,
        { content: "Invalid", status: "__proto__" },
        { content: "Invalid2", status: "constructor" },
      ],
    }).tasks,
    [],
  );
});

test("Claude structured task result objects and internal metadata are handled defensively", () => {
  const records = [
    call("create", "TaskCreate", { subject: "Build" }),
    result("create", { task: { id: "77", subject: "Build", status: "pending" } }),
    { type: "user", isMeta: true, message: { content: "internal" } },
    { type: "user", isCompactSummary: true, message: { content: "internal summary" } },
  ];
  assert.deepEqual(normalizeClaude(records).tasks, [
    { id: "77", text: "Build", status: "pending" },
  ]);
  assert.deepEqual(
    normalizeClaude(records).messages.map((m) => m.role),
    ["tool"],
  );
});
