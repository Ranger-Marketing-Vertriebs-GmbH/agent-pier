import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prepareAccountTransfer } from "../../server/application/session-account-transfer.js";
import { ProviderHistory } from "../../server/features/chat/provider-history.js";

// Only synthetic homes are used. No turn/start or real provider request is sent.
// Keep the production history client's read-only method allowlist unchanged.
async function resumeFixture(client, threadId) {
  await client.ready;
  const id = ++client.sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.pending.delete(id);
      reject(new Error("Native fixture resume timed out"));
    }, 15000);
    client.pending.set(id, { resolve, reject, timer });
    client.child.stdin.write(
      JSON.stringify({
        id,
        method: "thread/resume",
        params: {
          threadId,
          excludeTurns: true,
          model: "fixture",
          modelProvider: "fixture",
          config: {
            "model_providers.fixture": {
              name: "Fixture",
              base_url: "http://127.0.0.1:1/v1",
              wire_api: "responses",
              requires_openai_auth: false,
            },
          },
        },
      }) + "\n",
    );
  });
}

test(
  "installed Codex resumes a transferred paginated rollout with identical history in an empty profile",
  { skip: !process.env.AGENTPIER_TEST_CODEX_BIN, timeout: 45000 },
  async (t) => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "codex-transfer-native-")),
    );
    const id = randomUUID();
    const accounts = {
      get: (accountId) => ({ id: accountId, tool: "codex" }),
      environment: (accountId) => ({
        HOME: root,
        CODEX_HOME: path.join(root, accountId),
        PATH: process.env.PATH,
      }),
    };
    const histories = [];
    t.after(async () => {
      await Promise.all(histories.map((history) => history.close()));
      await fs.rm(root, { recursive: true, force: true });
    });
    const makeHistory = () => {
      const history = new ProviderHistory({ accounts, home: root });
      history.executable = () => process.env.AGENTPIER_TEST_CODEX_BIN;
      histories.push(history);
      return history;
    };
    for (const accountId of ["source", "target"]) {
      await fs.mkdir(path.join(root, accountId));
      await fs.writeFile(
        path.join(root, accountId, "auth.json"),
        JSON.stringify({ OPENAI_API_KEY: `${accountId}-fixture-only` }),
      );
    }
    const relative = `sessions/2026/09/09/rollout-2026-09-09T14-00-00-${id}.jsonl`;
    const sourceFile = path.join(root, "source", relative);
    const targetFile = path.join(root, "target", relative);
    const records = [
      {
        type: "session_meta",
        payload: {
          id,
          timestamp: "2026-09-09T14:00:00.000Z",
          cwd: root,
          originator: "codex_cli_rs",
          cli_version: "0.153.4",
          source: "cli",
          model_provider: "openai",
          history_mode: "paginated",
        },
      },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Keep the paginated conversation" }],
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          thread_id: id,
          turn_id: "turn-1",
          item: {
            type: "UserMessage",
            id: "user-1",
            content: [
              {
                type: "text",
                text: "Keep the paginated conversation",
                text_elements: [],
              },
            ],
          },
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "fixture_tool",
          arguments: "{}",
          call_id: "call-1",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-1",
          output: "Preserved tool result",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Preserved answer" }],
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          thread_id: id,
          turn_id: "turn-1",
          item: {
            type: "AgentMessage",
            id: "agent-1",
            content: [{ type: "Text", text: "Preserved answer" }],
            phase: "final_answer",
          },
        },
      },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    ];
    await fs.mkdir(path.dirname(sourceFile), { recursive: true });
    await fs.writeFile(
      sourceFile,
      records
        .map((record, ordinal) =>
          JSON.stringify({ timestamp: "2026-09-09T14:00:00.000Z", ordinal, ...record }),
        )
        .join("\n") + "\n",
    );
    const session = { id: "fixture", tool: "codex", accountId: "source", cwd: root };
    const sourceHistory = makeHistory();
    await resumeFixture(sourceHistory.codex(session), id);
    const params = { threadId: id, limit: 100, itemsView: "full", sortDirection: "asc" };
    const original = await sourceHistory
      .codex(session)
      .request("thread/turns/list", params);
    assert.equal(original.data.length, 1);
    assert.match(JSON.stringify(original.data), /Keep the paginated conversation/);
    assert.match(JSON.stringify(original.data), /Preserved answer/);
    const transfer = await prepareAccountTransfer(
      { accounts, history: sourceHistory },
      session,
      { id: "target", tool: "codex" },
      id,
    );
    await sourceHistory.close();
    await transfer.commit();
    assert.deepEqual(await fs.readFile(targetFile), await fs.readFile(sourceFile));
    assert.deepEqual((await fs.readdir(path.join(root, "target"))).sort(), [
      "auth.json",
      "sessions",
    ]);
    const targetHistory = makeHistory();
    const targetSession = { ...session, accountId: "target" };
    const { thread } = await resumeFixture(targetHistory.codex(targetSession), id);
    assert.equal(thread.id, id);
    assert.equal(thread.historyMode, "paginated");
    const restored = await targetHistory
      .codex(targetSession)
      .request("thread/turns/list", params);
    assert.deepEqual(restored.data, original.data);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(root, "target", "auth.json"), "utf8"))
        .OPENAI_API_KEY,
      "target-fixture-only",
    );

    // Return to the first account, whose SQLite projection still has only turn 1.
    await targetHistory.close();
    const targetRecords = (await fs.readFile(targetFile, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    const nextOrdinal = targetRecords.at(-1).ordinal + 1;
    const continuation = JSON.parse(
      JSON.stringify(records.slice(1))
        .replaceAll("turn-1", "turn-2")
        .replaceAll("user-1", "user-2")
        .replaceAll("agent-1", "agent-2")
        .replaceAll("call-1", "call-2")
        .replaceAll(
          "Keep the paginated conversation",
          "Continue after switching accounts",
        ),
    );
    await fs.appendFile(
      targetFile,
      continuation
        .map((record, index) =>
          JSON.stringify({
            timestamp: "2026-09-09T14:01:00.000Z",
            ordinal: nextOrdinal + index,
            ...record,
          }),
        )
        .join("\n") + "\n",
    );
    const returnHistory = makeHistory();
    const back = await prepareAccountTransfer(
      { accounts, history: returnHistory },
      targetSession,
      { id: "source", tool: "codex" },
      id,
    );
    await returnHistory.close();
    await back.commit();
    assert.deepEqual(await fs.readFile(sourceFile), await fs.readFile(targetFile));
    const resumedHistory = makeHistory();
    await resumeFixture(resumedHistory.codex(session), id);
    const afterReturn = await resumedHistory
      .codex(session)
      .request("thread/turns/list", params);
    assert.equal(afterReturn.data.length, 2);
    assert.deepEqual(afterReturn.data[0], original.data[0]);
    assert.equal(afterReturn.data[1].id, "turn-2");
    assert.match(
      JSON.stringify(afterReturn.data[1]),
      /Continue after switching accounts/,
    );
    assert.equal(
      JSON.parse(await fs.readFile(path.join(root, "source", "auth.json"), "utf8"))
        .OPENAI_API_KEY,
      "source-fixture-only",
    );
  },
);
