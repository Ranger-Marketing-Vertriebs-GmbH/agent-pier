import test from "node:test";
import assert from "node:assert/strict";
import {
  allowAlwaysByAgentPier,
  writeExecAllowlistEntry,
} from "../../server/features/assistants/exec-decisions.js";
import { notifyAction } from "../../server/features/assistants/assistant-action-notifications.js";
import { markdownToTelegramHtml } from "../../server/features/assistant-channels/telegram-format.js";
import { serverCatalogs } from "../../server/lib/i18n/catalogs.js";

const stale = () =>
  Object.assign(Error("stale"), {
    code: "INVALID_REQUEST",
    remoteMessage:
      "exec approvals changed since last load; re-run exec.approvals.get and retry",
  });

function approvals({ file = { version: 1 }, set } = {}) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      if (method === "exec.approvals.get") return { file, hash: `h${calls.length}` };
      return set(params);
    },
  };
}

test("allow-always needs AgentPier's entry exactly when OpenClaw withholds it", () => {
  assert.equal(
    allowAlwaysByAgentPier({ allowedDecisions: ["allow-once", "deny"] }),
    true,
  );
  assert.equal(
    allowAlwaysByAgentPier({ allowedDecisions: ["allow-once", "allow-always", "deny"] }),
    false,
  );
});

test("the allowlist entries keep every other entry and reuse existing ones", async () => {
  const file = {
    version: 1,
    agents: {
      home: {
        ask: "on-miss",
        allowlist: [
          { id: "a", pattern: "/bin/ls" },
          { id: "b", pattern: "/Users/me/bin/sink" },
        ],
      },
    },
  };
  const client = approvals({ file, set: (params) => params });
  const written = await writeExecAllowlistEntry(client, {
    agentId: "home",
    paths: ["/Users/me/bin/tool", "/Users/me/bin/sink"],
  });
  assert.equal(written.written, true);
  const [tool, sink] = written.entries;
  assert.deepEqual(sink, { entryId: "b", pattern: "/Users/me/bin/sink" });
  const sets = client.calls.filter((c) => c.method === "exec.approvals.set");
  assert.equal(sets.length, 1, "one write for all programs");
  const set = sets[0].params;
  assert.equal(set.baseHash, "h1");
  assert.equal(set.file.agents.home.ask, "on-miss");
  assert.deepEqual(set.file.agents.home.allowlist, [
    { id: "a", pattern: "/bin/ls" },
    { id: "b", pattern: "/Users/me/bin/sink" },
    { id: tool.entryId, pattern: "/Users/me/bin/tool" },
  ]);
  // Entries that are already there are reported, not written again.
  const again = approvals({ file: set.file, set: () => assert.fail("no write") });
  assert.deepEqual(
    await writeExecAllowlistEntry(again, {
      agentId: "home",
      paths: ["/Users/me/bin/tool"],
    }),
    { written: true, entries: [tool] },
  );
});

test("the allowlist write retries a stale hash a bounded number of times", async () => {
  let sets = 0;
  const conflicted = approvals({
    set: () => {
      sets++;
      throw stale();
    },
  });
  assert.deepEqual(
    await writeExecAllowlistEntry(conflicted, { agentId: "home", paths: ["/x/tool"] }),
    { written: false, code: "INVALID_REQUEST" },
  );
  assert.equal(sets, 3);
  // Other failures are not retried.
  sets = 0;
  const broken = approvals({
    set: () => {
      sets++;
      throw Object.assign(Error(), { code: "CLOSED" });
    },
  });
  assert.deepEqual(
    await writeExecAllowlistEntry(broken, { agentId: "home", paths: ["/x/tool"] }),
    { written: false, code: "CLOSED" },
  );
  assert.equal(sets, 1);
  // Another INVALID_REQUEST (for example a schema error) is not retried either.
  sets = 0;
  const refused = approvals({
    set: () => {
      sets++;
      throw Object.assign(Error(), { code: "INVALID_REQUEST", remoteMessage: "invalid" });
    },
  });
  assert.deepEqual(
    await writeExecAllowlistEntry(refused, { agentId: "home", paths: ["/x/tool"] }),
    { written: false, code: "INVALID_REQUEST" },
  );
  assert.equal(sets, 1);
  // Without the executable OpenClaw resolved there is nothing to allow.
  const none = approvals({ set: () => assert.fail("no write") });
  assert.deepEqual(await writeExecAllowlistEntry(none, { agentId: "home", paths: [] }), {
    written: false,
    code: "NO_RESOLVED_PATH",
  });
  assert.deepEqual(none.calls, []);
});

function notify(language, payload, extra = {}) {
  const queued = [];
  const w = {
    s: {
      assistantChannels: {
        outbox: { all: () => [], enqueue: (entry) => queued.push(entry) },
        store: { get: () => ({ language }) },
      },
    },
    a: { store: { getAssistant: () => ({ name: "Home" }) } },
  };
  const action = {
    id: "x",
    assistantId: "a",
    conversationId: "c",
    revision: 3,
    state: "awaiting_approval",
    origin: { kind: "telegram", channelId: "ch", chatId: "1", userId: "1" },
    payload: {
      action: "exec",
      approvalId: "ap",
      command: "ls -la",
      cwd: "/work",
      agentId: "home",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
      ...payload,
    },
    ...extra,
  };
  notifyAction(w, action, extra.state ? "result" : "approval");
  return queued[0];
}

for (const language of ["de", "en"]) {
  test(`the exec approval notice shows command, folder and agent (${language})`, () => {
    const m = serverCatalogs[language].assistants;
    const notice = notify(language, {});
    assert.ok(notice.text.startsWith(m.execApproval));
    assert.ok(notice.text.includes(m.execAgent("Home")));
    assert.ok(notice.text.includes("```\n/work\n```"));
    assert.ok(notice.text.includes("```\nls -la\n```"));
    assert.ok(!notice.text.includes(m.execAllowAlwaysPrograms("`/bin/ls`")));
    assert.deepEqual(
      notice.actions.map((a) => [a.decision, a.label, a.revision, a.proposalId]),
      [
        ["allow-once", m.execAllowOnce, 3, "x"],
        ["allow-always", m.execAllowAlways, 3, "x"],
        ["deny", m.execDeny, 3, "x"],
      ],
    );
    // Withheld allow-always is still offered, with exactly the stored plan.
    const withheld = { allowedDecisions: ["allow-once", "deny"] };
    const warned = notify(language, {
      ...withheld,
      allowAlwaysPlan: { kind: "paths", paths: ["/bin/ls"], writable: [] },
    });
    assert.ok(warned.text.includes(m.execAllowAlwaysPrograms("`/bin/ls`")));
    assert.ok(!warned.text.includes(m.execWritablePrograms("`/bin/ls`")));
    assert.equal(warned.actions.length, 3);
    const piped = notify(language, {
      ...withheld,
      allowAlwaysPlan: {
        kind: "paths",
        paths: ["/me/bin/a", "/bin/cat"],
        writable: ["/me/bin/a"],
      },
    });
    assert.ok(piped.text.includes(m.execAllowAlwaysPrograms("`/me/bin/a`, `/bin/cat`")));
    assert.ok(piped.text.includes(m.execWritablePrograms("`/me/bin/a`")));
    const once = notify(language, {
      ...withheld,
      allowAlwaysPlan: { kind: "once", reason: "interpreter", program: "node" },
    });
    assert.ok(
      once.text.includes(m.execAllowAlwaysOnce(m.execOnceReasons.interpreter("`node`"))),
    );
    assert.equal(once.actions.length, 3);
    // An action stored without a plan is allowed once only.
    const legacy = notify(language, withheld);
    assert.ok(
      legacy.text.includes(m.execAllowAlwaysOnce(m.execOnceCommandReasons.unresolved)),
    );
  });

  test(`exec result notices name the decision and the allowlist entry (${language})`, () => {
    const m = serverCatalogs[language].assistants;
    const written = notify(
      language,
      {},
      {
        state: "completed",
        result: {
          decision: "allow-always",
          resolvedAs: "allow-once",
          allowlist: {
            written: true,
            entries: [{ entryId: "e", pattern: "/x" }],
            writable: ["/x"],
          },
        },
      },
    );
    assert.equal(written.kind, "action-result");
    assert.ok(written.text.startsWith(m.execDecided["allow-always"]));
    assert.ok(written.text.includes(m.execAllowlistPrograms("`/x`")));
    assert.ok(written.text.includes(m.execWritablePrograms("`/x`")));
    const skipped = notify(
      language,
      {},
      {
        state: "completed",
        result: {
          decision: "allow-always",
          resolvedAs: "allow-once",
          allowlist: { written: false, skipped: "complex" },
        },
      },
    );
    assert.ok(skipped.text.startsWith(m.execDecided["allow-once"]));
    assert.ok(
      skipped.text.includes(m.execAllowlistSkipped(m.execOnceCommandReasons.complex)),
    );
    assert.deepEqual(written.actions, []);
    const denied = notify(
      language,
      {},
      { state: "declined", result: { decision: "deny" } },
    );
    assert.ok(denied.text.startsWith(m.execStates.declined));
    const expired = notify(language, {}, { state: "expired" });
    assert.ok(expired.text.startsWith(m.execStates.expired));
  });
}

test("a long or hostile command is truncated and stays literal in Telegram", () => {
  const command = `echo **bold** <b>x</b> [a](https://e.x)\n\`\`\`\n${"y".repeat(3000)}`;
  const notice = notify("en", { command, cwd: "/tmp/`x`" });
  assert.ok(notice.text.length < 2200);
  assert.ok(notice.text.includes("…"));
  const html = markdownToTelegramHtml(notice.text);
  // Markup in the command is escaped text inside the code block, never formatting.
  assert.ok(html.includes("echo **bold** &lt;b&gt;x&lt;/b&gt; [a](https://e.x)"));
  assert.ok(!html.includes("<b>bold</b>") && !html.includes("<a href"));
  assert.equal((html.match(/<pre>/g) || []).length, 2);
  assert.ok(html.includes("/tmp/`x`"));
  // Truncation never splits a surrogate pair.
  const emoji = notify("en", { command: "😀".repeat(1600) });
  assert.ok(emoji.text.includes(`${"😀".repeat(1500)}…`));
  assert.doesNotMatch(emoji.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  // A program name cannot end its code span or become a link.
  const hostile = notify("en", {
    allowedDecisions: ["allow-once", "deny"],
    allowAlwaysPlan: {
      kind: "once",
      reason: "unresolved",
      program: "x`[click](https://evil.example)`\n**b**",
    },
  });
  const rendered = markdownToTelegramHtml(hostile.text);
  assert.ok(!rendered.includes("<a href") && !rendered.includes("<b>b</b>"));
  assert.ok(
    rendered.includes("<code>x\u02cb[click](https://evil.example)\u02cb **b**</code>"),
  );
});
