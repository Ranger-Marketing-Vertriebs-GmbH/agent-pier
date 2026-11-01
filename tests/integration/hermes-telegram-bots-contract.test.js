import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { fakeBotApi, fakeDeepgram } from "../helpers/assistant-telegram-fakes.js";
import { eventually } from "../helpers/hermes-fake-runtime.js";
import { hermesSkip, strayAfterStop } from "../helpers/hermes-native.js";
import { deleteAgent, hermesApp, json } from "../helpers/hermes-app.js";
import { TelegramClient } from "../../server/features/assistant-channels/telegram-client.js";

// An agent's own Telegram bot for other people on the pinned Hermes
// (AGENTPIER_HERMES_CONTRACT_RUNTIME), end to end through AgentPier's routes: the bot
// runs on Hermes's own Telegram adapter in the agent's gateway against a loopback
// Bot API (`platforms.telegram.extra.base_url`), voice notes go to AgentPier's
// Deepgram plugin against a loopback `/listen` (`stt.agentpier-deepgram.base_url`).
// Both are TelegramSenders' test seams. Nothing leaves the host.
const options = { skip: hermesSkip, timeout: contractTimeout(1200000) };
const token = "888:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const speechKey = "dg-contract-key-5e";
const alice = { id: 5001, name: "Alice" };
const stranger = { id: 6001, name: "Mallory" };
const said = (model, text) =>
  model.requests.some((r) => JSON.stringify(r.body).includes(text));
const replied = (api, person, text) =>
  api.sent(token, person.id).some((c) => String(c.params.text).includes(text));

test(
  "Hermes contract: an agent's own bot answers allowed people, transcribes voice with Deepgram and stays shut to others",
  options,
  async (t) => {
    const app = await hermesApp(t);
    const { f, agent, runtime, model } = app;
    const api = await fakeBotApi({ [token]: { id: 888, username: "pier_people_bot" } });
    t.after(() => api.close());
    const deepgram = await fakeDeepgram("ich komme morgen um neun");
    t.after(() => deepgram.close());
    const senders = f.application.assistantTelegramSenders;
    assert.ok(senders, "the TelegramSenders service");
    Object.assign(senders, {
      apiRoot: api.url,
      deepgram: deepgram.url,
      clientFactory: (secret) => new TelegramClient({ token: secret, apiRoot: api.url }),
    });
    senders.speech.save({
      apiKey: speechKey,
      model: "nova-3",
      language: "de",
      revision: senders.speech.get().revision,
    });
    const listed = (await json(await f.request("/api/assistants"))).assistants.find(
      (a) => a.id === agent.id,
    );
    assert.equal(listed.runtimeInfo.capabilities.channelBots.available, true);

    const base = `/api/assistant-telegram-senders/${agent.id}`;
    const saved = await json(
      await f.request(base, {
        method: "PUT",
        body: {
          token,
          people: [{ id: String(alice.id), name: alice.name }],
          revision: null,
        },
      }),
    );
    assert.equal(saved.bot.username, "pier_people_bot");
    assert.equal(JSON.stringify(saved).includes(token), false);
    await eventually(
      async () => (await json(await f.request(base))).status?.state === "running",
      240000,
      "the agent's bot to poll",
    );
    const home = app.fleet.sets.get(agent.runtimeAgentId).supervisor.agentPaths();
    const mode = (file) => fs.statSync(path.join(home.hermesHome, file)).mode & 0o777;
    assert.equal(mode(".env"), 0o600);
    assert.doesNotMatch(
      fs.readFileSync(path.join(home.hermesHome, "config.yaml"), "utf8"),
      new RegExp(`${token}|${speechKey}`),
    );

    // An allowed person writes; the agent answers in the same chat.
    api.text(token, alice, "hello hermes bot");
    await eventually(
      () => replied(api, alice, "ECHO:") && said(model, "hello hermes bot"),
      120000,
      "the answer to Alice",
    );

    // A voice note is transcribed by Deepgram with the speech settings and AgentPier's key.
    api.voice(token, alice, "voice-1", Buffer.from("OggS fake voice note"));
    await eventually(
      () => deepgram.requests.length > 0 && said(model, "ich komme morgen um neun"),
      120000,
      "the transcribed voice note",
    ).catch((error) => {
      // What Hermes did with the note, so a failure names its step.
      const log = fs.readFileSync(path.join(home.logs, "gateway.log"), "utf8");
      error.message += ` (deepgram ${deepgram.requests.length}; calls ${JSON.stringify(
        api.calls
          .filter((c) => c.method !== "getUpdates")
          .map((c) => [c.method, c.params?.path || c.params?.file_id]),
      )}; log ${log
        .split("\n")
        .filter((l) => /stt|transcri|voice|deepgram|plugin/i.test(l))
        .slice(-15)
        .join(" | ")})`;
      throw error;
    });
    const upload = deepgram.requests[0];
    assert.equal(upload.authorization, `Token ${speechKey}`);
    const query = new URL(upload.url, "http://x").searchParams;
    assert.equal(query.get("model"), "nova-3");
    assert.equal(query.get("language"), "de");
    assert.ok(upload.size > 0);

    // A stranger, a group chat and a command never reach the model and get no answer.
    api.text(token, stranger, "let me in please");
    api.group(token, alice, -100777, "group hello there");
    api.text(token, alice, "/model gpt-other");
    // Commands are admin-only, and nobody is an admin: Hermes refuses it.
    await eventually(
      () => replied(api, alice, "/model is admin"),
      60000,
      "the command refusal",
    );
    // A later message from Alice, sent once the command was refused, proves the
    // earlier ones were handled.
    api.text(token, alice, "still there");
    await eventually(() => said(model, "still there"), 120000, "the later message").catch(
      (error) => {
        const last = model.requests
          .slice(-2)
          .map((r) => JSON.stringify(r.body.messages?.at(-1)));
        const log = fs.readFileSync(path.join(home.logs, "gateway.log"), "utf8");
        error.message += ` (model ${last.join(" ; ")}; to Alice ${JSON.stringify(
          api.sent(token, alice.id).map((c) => String(c.params.text).slice(0, 120)),
        )}; log ${log.split("\n").slice(-25).join(" | ")})`;
        throw error;
      },
    );
    assert.equal(said(model, "let me in please"), false);
    assert.equal(api.sent(token, stranger.id).length, 0);
    assert.equal(said(model, "group hello there"), false);
    assert.equal(api.sent(token, -100777).length, 0);
    assert.equal(said(model, "gpt-other"), false);

    // The owner's own chat with the agent keeps working beside the bot.
    const { key } = await runtime.sessions.create({
      agentId: agent.runtimeAgentId,
      label: "owner",
      idempotencyKey: "owner-1",
    });
    await runtime.sessions.send({
      key,
      turn: { message: "owner side" },
      idempotencyKey: "owner-run-1",
    });
    await eventually(() => said(model, "owner side"), 120000, "the owner's turn");

    // Neither the token nor the Deepgram key reaches the gateway's logs.
    for (const name of fs.readdirSync(home.logs)) {
      const text = fs.readFileSync(path.join(home.logs, name), "utf8");
      assert.equal(text.includes(token) || text.includes(speechKey), false, name);
      // The fixed fallback list keeps Hermes from asking DNS-over-HTTPS resolvers.
      assert.doesNotMatch(text, /Discovering Telegram API fallback IPs/, name);
    }

    // Disconnecting the bot stops Hermes polling it.
    const current = await json(await f.request(base));
    await json(
      await f.request(base, {
        method: "DELETE",
        body: { revision: current.bot.revision },
      }),
    );
    await eventually(
      () =>
        !/TELEGRAM_BOT_TOKEN/.test(
          fs.readFileSync(path.join(home.hermesHome, ".env"), "utf8"),
        ) && runtime.host.ready(),
      240000,
      "the bot to be removed",
    );
    const polls = api.polls(token);
    await new Promise((resolve) => setTimeout(resolve, 8000));
    assert.ok(api.polls(token) - polls <= 1, "no poller after the removal");

    await deleteAgent(app);
    await eventually(
      () => runtime.host.status().availability === "disabled",
      60000,
      "the agent's set to stop",
    );
    assert.deepEqual(await strayAfterStop({ root: home.hermesHome }), []);
    assert.deepEqual(await strayAfterStop({ root: f.dataDir }), []);
  },
);
