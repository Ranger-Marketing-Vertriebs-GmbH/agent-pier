import test from "node:test";
import assert from "node:assert/strict";
import {
  areaResult,
  eventArea,
  firstLine,
} from "../../server/features/assistants/agent-event-area.js";
import { fromSince } from "../../server/features/users/owner-privacy.js";

const routineMsg = {
  id: "routine",
  role: "assistant",
  text: "Lentil soup",
  scheduled: { name: "Meal plan" },
};
const checkinMsg = {
  id: "checkin",
  role: "assistant",
  text: "All quiet",
  scheduled: { name: "", kind: "heartbeat" },
};
const hookMsg = {
  id: "hook",
  role: "assistant",
  text: "Disk full",
  scheduled: { name: "Zabbix", kind: "hook" },
};
const reminderMsg = {
  id: "reminder",
  role: "assistant",
  text: "Call mum",
  scheduled: { name: "Call", kind: "reminder" },
};
const failedRoutine = { id: "failed", role: "event", event: "routine-failed" };
const failedReminder = {
  id: "failed-reminder",
  role: "event",
  event: "routine-failed",
  kind: "reminder",
};
const userMsg = { id: "user", role: "user", text: "Thanks" };

test("routine, check-in and hook results leave the transcript, reminders stay", () => {
  const messages = [
    routineMsg,
    checkinMsg,
    hookMsg,
    reminderMsg,
    failedRoutine,
    failedReminder,
    userMsg,
  ];
  assert.deepEqual(
    messages.filter((m) => !areaResult(m)).map((m) => m.id),
    ["reminder", "failed-reminder", "user"],
  );
});

test("a hook run's prompt never stays in the transcript as a user message", () => {
  const prompt = {
    id: "p",
    role: "user",
    text: 'This is the AgentPier hook "Zabbix" from "z", not a message from the owner.\n<<<AGENTPIER_HOOK_EVENT>>>\n<b>x</b>\n<<<END_AGENTPIER_HOOK_EVENT>>>',
  };
  assert.equal(areaResult(prompt), true);
  // An envelope OpenClaw might put before it (a time stamp, a cron header) changes nothing.
  assert.equal(
    areaResult({
      ...prompt,
      text: `[cron:job-1 Hook Zabbix] Sat 2026-10-24 10:00\n${prompt.text}`,
    }),
    true,
  );
  // Without the closing marker it is no hook prompt.
  assert.equal(
    areaResult({
      ...prompt,
      text: prompt.text.replace("<<<END_AGENTPIER_HOOK_EVENT>>>", ""),
    }),
    false,
  );
  // The owner quoting the opening words is still the owner's message.
  assert.equal(
    areaResult({ id: "q", role: "user", text: "This is the AgentPier hook text?" }),
    false,
  );
  assert.equal(areaResult({ ...prompt, role: "assistant" }), false);
});

test("the first line is the reply's first non-empty line, at most 160 characters", () => {
  assert.equal(firstLine("\n  \n  Disk full on db1.  \nSecond"), "Disk full on db1.");
  assert.equal(firstLine(null), "");
  const long = firstLine(`${"é".repeat(200)}\nnext`);
  assert.equal(Array.from(long).length, 160);
  assert.ok(long.endsWith("…"));
  assert.equal(firstLine("x".repeat(160)), "x".repeat(160));
});

test("the first line drops simple Markdown markers and stays plain text", () => {
  assert.equal(
    firstLine("## **Disk** on `nas` is __95%__ full"),
    "Disk on nas is 95% full",
  );
  assert.equal(firstLine("\n- first item\n- second"), "first item");
  assert.equal(firstLine("* starred item"), "starred item");
  assert.equal(firstLine("> quoted"), "quoted");
  // A line of markers alone gives way to the next line with text.
  assert.equal(firstLine("---\n**\nReal text"), "Real text");
  assert.equal(firstLine("a - b # c"), "a - b # c");
});

test("the event area merges results and hook events newest first, at most 50", () => {
  const conversation = { id: "c", assistantId: "a", channel: "agentpier", main: true };
  const results = [
    { id: "r1", name: "Meal plan", at: 10, status: "ok", text: "Soup\nmore" },
    { id: "r2", kind: "heartbeat", name: "", at: 2000, status: "error", notes: ["n"] },
    { id: "r3", kind: "reminder", name: "Call", at: 40, status: "ok", text: "x" },
    { id: "r4", kind: "hook", name: "Zabbix", at: 50, status: "ok", text: "y" },
  ];
  const events = Array.from({ length: 50 }, (_, i) => ({
    id: `e${i}`,
    hookId: "h",
    receivedAt: 1000 - i,
    status: "throttled",
    duplicates: 0,
  }));
  events[0] = { ...events[0], status: "done", silent: true };
  const service = {
    store: { listConversations: () => [conversation] },
    routines: {
      results: { forConversation: () => results },
      hooks: {
        events: { forAssistant: (id, { limit }) => events.slice(0, limit) },
        store: { get: () => ({ name: "Zabbix", sender: "zabbix01" }) },
      },
    },
  };
  const area = eventArea(service, conversation);
  assert.equal(area.length, 50);
  assert.deepEqual(
    area.slice(0, 3).map((e) => [e.id, e.source, e.status]),
    [
      ["routine:r2", "checkin", "failed"],
      ["hook:e0", "hook", "silent"],
      ["hook:e1", "hook", "throttled"],
    ],
  );
  assert.deepEqual(area[0].notes, ["n"]);
  // Older than 49 hook events: the routine is cut with the oldest event.
  assert.equal(area.at(-1).id, "hook:e48");
  assert.ok(!area.some((e) => e.id === "routine:r1"));
  // A user's main chat has its own results, never the agent's hook events.
  const hers = eventArea(service, { ...conversation, userId: "u" });
  assert.deepEqual(
    hers.map((e) => e.id),
    ["routine:r2", "routine:r1"],
  );
  assert.deepEqual(hers[1], {
    id: "routine:r1",
    source: "routine",
    name: "Meal plan",
    at: 10,
    status: "done",
    firstLine: "Soup",
    reply: "Soup\nmore",
  });
  assert.deepEqual(eventArea(service, { ...conversation, main: false, id: "x" }), []);
});

test("the owner reading a user's chat sees only events from her opt-in on", () => {
  const since = new Date(1000).toISOString();
  const view = fromSince(
    {
      messages: [],
      requests: [],
      events: [
        { id: "new", at: 2000 },
        { id: "old", at: 500 },
      ],
    },
    since,
  );
  assert.deepEqual(
    view.events.map((e) => e.id),
    ["new"],
  );
});
