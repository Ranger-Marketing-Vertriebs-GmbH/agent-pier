import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { hermesCompiler } from "../../server/features/assistants/runtimes/hermes/hermes-compiler.js";
import { hermesExecutables } from "../../server/features/assistants/runtimes/hermes/hermes-paths.js";
import {
  desiredAgent,
  desiredState,
} from "../../server/features/assistants/agent-desired-state.js";
import { readHermesConfig } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";
import { RunSteps } from "../../server/features/assistants/run-steps.js";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import {
  collectEvents,
  contractAgent,
  endsRun,
  hermesSandbox,
  hermesSkip,
  startHermes,
  strayAfterStop,
} from "../helpers/hermes-native.js";

// Mixture of Agents against the pinned Hermes (ADR 0007, step 7a;
// docs/hermes-runtime.md, Mixture of Agents). Hermes repairs a preset it reads: a
// broken slot falls back to its built-in openai-codex and OpenRouter models, an
// unknown provider is called bare. So the home AgentPier writes must normalise, with
// Hermes's own loader and normaliser, to exactly AgentPier's slots, each resolving to
// the advisor's own endpoint and key; a preset with a slot Hermes would repair is
// never written. A turn then runs the advisors once and the agent's own model acts,
// and the advisors' answers reach AgentPier's run events as steps. Every process
// gets a private HOME, HERMES_HOME and TMPDIR and a cleared environment; the models
// are the in-repo fake on loopback ports.
const runtime = process.env.AGENTPIER_HERMES_CONTRACT_RUNTIME;
const options = { skip: hermesSkip, timeout: contractTimeout(600000) };
const run = promisify(execFile);
const bin = (name) => hermesExecutables(runtime || "")[name];

// What Hermes makes of the home: the normalised MoA config, and per slot the endpoint
// and whether the key it resolves is the one under the slot's own key name (keys are
// compared inside the probe, never printed).
const probe = `
import json, os
from hermes_cli.env_loader import load_hermes_dotenv
load_hermes_dotenv(hermes_home=os.environ["HERMES_HOME"])
from hermes_cli.config import load_config
from hermes_cli.moa_config import normalize_moa_config, resolve_moa_preset
from hermes_cli.runtime_provider import resolve_runtime_provider
from agent.auxiliary_client import _resolve_moa_aggregator
from tools.environments.local_env_policy import _is_hermes_internal_secret
config = load_config()
raw = config.get("moa") or {}
moa = normalize_moa_config(raw)
out = {"model": config.get("model"), "default": moa["default_preset"],
       "names": sorted(moa["presets"]), "slots": [], "hidden": {}}
out["preset"] = resolve_moa_preset(raw, moa["default_preset"])
providers = config.get("providers") or {}
for slot in out["preset"]["reference_models"] + [out["preset"]["aggregator"]]:
    name = slot["provider"].split(":", 1)[-1]
    key_env = (providers.get(name) or {}).get("key_env") or ""
    try:
        rt = resolve_runtime_provider(requested=slot["provider"], target_model=slot["model"])
        out["slots"].append({"provider": slot["provider"], "base_url": rt.get("base_url"),
            "own_key": bool(key_env) and rt.get("api_key") == os.environ.get(key_env)})
    except Exception as error:
        out["slots"].append({"provider": slot["provider"], "error": type(error).__name__})
    if key_env:
        out["hidden"][key_env] = _is_hermes_internal_secret(key_env)
out["aux"] = list(_resolve_moa_aggregator(None))
print(json.dumps(out))
`;

async function hermesHome(t, name, prepare) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `hermes-mixture-${name}-`)),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = Object.fromEntries(
    ["home", "hermes", "tmp", "work"].map((d) => [d, path.join(root, d)]),
  );
  for (const d of ["home", "hermes", "tmp", "work"]) fs.mkdirSync(dirs[d]);
  prepare(dirs);
  const env = {
    HOME: dirs.home,
    HERMES_HOME: dirs.hermes,
    TMPDIR: dirs.tmp,
    PATH: `${path.dirname(bin("python"))}:/usr/bin:/bin`,
    LANG: "C.UTF-8",
  };
  const exec = (file, args) =>
    run(file, args, { cwd: dirs.work, env, timeout: 120000, maxBuffer: 8 << 20 });
  const check = await exec(bin("hermes"), ["config", "check"]);
  const { stdout } = await exec(bin("python"), ["-c", probe]);
  return {
    check: check.stdout,
    seen: JSON.parse(stdout.trim().split("\n").at(-1)),
    yaml: fs.readFileSync(path.join(dirs.hermes, "config.yaml"), "utf8"),
  };
}

const endpoint = (baseUrl, apiKey, id) => ({
  baseUrl,
  api: "openai-completions",
  ...(apiKey && { apiKey }),
  models: [{ id, name: id, contextWindow: 128000 }],
});
const resolved = (connectionId, modelId, provider) => ({
  connectionId,
  modelId,
  ref: `ap-${connectionId}/${modelId}`,
  providerId: `ap-${connectionId}`,
  provider,
  display: { connection: connectionId, model: modelId },
});
const profile = (advisors) => ({
  id: "a1",
  name: "Agent a1",
  runtimeAgentId: "ap-a1",
  runtime: "hermes",
  revision: 1,
  shell: "approval",
  capabilities: { memory: true },
  model: { connectionId: "c-main", modelId: "main-model" },
  runtimeOptions: { hermes: { mixture: { advisors } } },
});
const advisors = [
  { connectionId: "c-or", modelId: "openai/gpt-x" },
  { connectionId: "c-lab", modelId: "lab-model" },
];
// The compiled home of an agent with `connections` resolved for its advisors.
function compiled(dirs, connections) {
  const agent = profile(advisors);
  const input = {
    desired: desiredState({ profiles: [agent] }),
    agents: [
      desiredAgent(agent, {
        model: {
          ref: "ap-c-main/main-model",
          providerId: "ap-c-main",
          provider: endpoint("https://main.example.test/v1", "sk-main", "main-model"),
        },
        optionConnections: connections,
      }),
    ],
    workspaces: { "ap-a1": dirs.work },
  };
  const home = hermesCompiler.compile(input).homes["ap-a1"];
  hermesCompiler.write(dirs.hermes, home);
  return home;
}

test(
  "Hermes reads AgentPier's preset as exactly its slots, each with its own key",
  options,
  async (t) => {
    const { seen, check, yaml } = await hermesHome(t, "two", (dirs) =>
      compiled(dirs, [
        resolved(
          "c-or",
          "openai/gpt-x",
          endpoint("https://openrouter.ai/api/v1", "sk-or-advisor", "openai/gpt-x"),
        ),
        resolved(
          "c-lab",
          "lab-model",
          endpoint("http://127.0.0.1:9/v1", "", "lab-model"),
        ),
      ]),
    );
    t.diagnostic(JSON.stringify({ ...seen, preset: undefined }));
    assert.doesNotMatch(check, /✗|⚠/, check);
    assert.equal(seen.model.provider, "moa");
    assert.equal(seen.model.default, "agentpier");
    assert.deepEqual(seen.names, ["agentpier"], "no built-in preset beside it");
    assert.equal(seen.default, "agentpier");
    assert.deepEqual(seen.preset.reference_models, [
      { provider: "custom:agentpier-advisor-1", model: "openai/gpt-x", enabled: true },
      { provider: "custom:agentpier-advisor-2", model: "lab-model", enabled: true },
    ]);
    assert.deepEqual(seen.preset.aggregator, {
      provider: "custom:agentpier-model",
      model: "main-model",
    });
    assert.equal(seen.preset.fanout, "user_turn");
    assert.equal(seen.preset.degraded_reference_policy, "loud");
    assert.equal(seen.preset.reference_timeout, 120);
    assert.deepEqual(seen.slots, [
      {
        provider: "custom:agentpier-advisor-1",
        base_url: "https://openrouter.ai/api/v1",
        own_key: true,
      },
      // A keyless local endpoint gets no key at all.
      {
        provider: "custom:agentpier-advisor-2",
        base_url: "http://127.0.0.1:9/v1",
        own_key: false,
      },
      {
        provider: "custom:agentpier-model",
        base_url: "https://main.example.test/v1",
        own_key: true,
      },
    ]);
    // Auxiliary tasks (titles, compression) run on the aggregator, the agent's model.
    assert.deepEqual(seen.aux, ["custom:agentpier-model", "main-model"]);
    // Every key name is one Hermes strips from the agent's own commands.
    assert.deepEqual(seen.hidden, {
      AUXILIARY_AGENTPIER_ADVISOR_1_API_KEY: true,
      AUXILIARY_AGENTPIER_API_KEY: true,
    });
    assert.doesNotMatch(yaml, /sk-/);
    assert.match(yaml, /save_traces: false/);
  },
);

test(
  "a preset Hermes would repair is never written; Hermes shows why",
  options,
  async (t) => {
    // An advisor whose connection cannot be a named provider (a ChatGPT login): the
    // only advisor left out, so no preset at all, and the model is today's.
    const { seen } = await hermesHome(t, "none", (dirs) =>
      compiled(dirs, [
        { connectionId: "c-or", modelId: "openai/gpt-x", unavailable: "provider" },
        { ...resolved("c-lab", "lab-model", undefined), chatgpt: { profileId: "p" } },
      ]),
    );
    assert.equal(seen.model.provider, "custom");
    assert.deepEqual(seen.names, ["agentpier"], "Hermes's own default never appears");
    // What Hermes would make of a written preset with one unknown provider and one
    // slot without a model: the slot without a model is dropped and the empty list
    // filled with Hermes's built-in providers; the unknown one does not resolve, so
    // Hermes would call it bare. AgentPier never writes either (hermes-mixture.test.js
    // checkedPreset).
    const repaired = await hermesHome(t, "repair", (dirs) => {
      fs.writeFileSync(
        path.join(dirs.hermes, "config.yaml"),
        [
          "model: { provider: moa, default: broken }",
          "moa:",
          "  default_preset: broken",
          "  presets:",
          "    broken:",
          "      reference_models: [{ provider: custom:agentpier-advisor-1, model: '' }]",
          "      aggregator: { provider: custom:nope, model: x }",
          "",
        ].join("\n"),
      );
    });
    assert.deepEqual(
      repaired.seen.preset.reference_models.map((slot) => slot.provider),
      ["openai-codex", "openrouter"],
    );
    assert.deepEqual(repaired.seen.slots.at(-1), {
      provider: "custom:nope",
      error: "AuthError",
    });
  },
);

test(
  "a turn asks the advisors once, the agent's model acts, and the steps arrive",
  options,
  async (t) => {
    const main = await startFakeModel();
    const advisor = await startFakeModel();
    t.after(() => main.close());
    t.after(() => advisor.close());
    // An endpoint that refuses the advisor's key, as a revoked key would.
    const refusing = http.createServer((req, res) => {
      req.resume();
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid api key" } }));
    });
    await new Promise((resolve) => refusing.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => refusing.close(resolve)));
    const refusingUrl = `http://127.0.0.1:${refusing.address().port}/v1`;
    const dirs = hermesSandbox(t);
    const agentId = "hermes-mixture";
    const stored = [
      { connectionId: "c-adv", modelId: "fake-advisor" },
      // Refused: this advisor fails and the turn goes on.
      { connectionId: "c-refused", modelId: "fake-refused" },
      // Nothing listens here: Hermes's auxiliary client retries a connection failure
      // on the main agent's model (agent/auxiliary_client.py
      // `_try_main_agent_model_fallback`), which under MoA is the aggregator.
      { connectionId: "c-down", modelId: "fake-down" },
    ];
    const { sessions, events, stop, agent } = await startHermes(t, dirs, {
      agentId,
      model: { baseUrl: main.baseUrl },
      extra: {
        runtime: "hermes",
        runtimeOptions: { hermes: { mixture: { advisors: stored } } },
      },
      inputs: {
        optionConnections: [
          resolved(
            "c-adv",
            "fake-advisor",
            endpoint(advisor.baseUrl, "advisor-key", "fake-advisor"),
          ),
          resolved(
            "c-refused",
            "fake-refused",
            endpoint(refusingUrl, "refused-key", "fake-refused"),
          ),
          resolved(
            "c-down",
            "fake-down",
            endpoint("http://127.0.0.1:9/v1", "", "fake-down"),
          ),
        ],
      },
    });
    const configFile = path.join(agent.hermesHome, "config.yaml");
    const sections = () => {
      const { moa, providers, model } = readHermesConfig(
        fs.readFileSync(configFile, "utf8"),
      );
      return { moa, providers, model };
    };
    const written = sections();
    assert.equal(written.model.provider, "moa");
    const { key } = await sessions.create({
      agentId,
      label: "moa",
      idempotencyKey: "k1",
    });
    const seen = collectEvents(events);
    await sessions.send({
      key,
      turn: { message: "hello advisors" },
      idempotencyKey: "run-moa",
    });
    const end = await seen.until(endsRun("run-moa"));
    assert.equal(end.kind, "finished", JSON.stringify(end.payload));
    // The advisor saw the conversation's text once, without tools; only its own key.
    const asked = advisor.requests.filter((r) => r.url.endsWith("/chat/completions"));
    assert.equal(asked.length, 1);
    assert.equal(asked[0].body.model, "fake-advisor");
    assert.equal(asked[0].body.tools, undefined);
    assert.match(JSON.stringify(asked[0].body.messages), /hello advisors/);
    assert.equal(asked[0].headers.authorization, "Bearer advisor-key");
    // The agent's own model acted, with its own key, never the advisor's.
    const acted = main.requests.filter((r) => r.url.endsWith("/chat/completions"));
    assert.ok(acted.length >= 1);
    assert.ok(acted.some((r) => r.body.model === "fake-1"));
    for (const { headers } of acted)
      assert.doesNotMatch(String(headers.authorization), /advisor-key/);
    // The unreachable advisor's request went to the agent's own model and endpoint,
    // never to a provider the owner did not choose; the refused one went nowhere else.
    const fallback = acted.filter((r) => r.body.model !== "fake-1");
    assert.deepEqual(
      fallback.map((r) => r.body.model),
      [],
      "Hermes names the aggregator's model on its fallback",
    );
    assert.ok(
      acted.filter((r) => r.body.tools === undefined).length >= 1,
      "an advisor-shaped request (no tools) reached the agent's own model",
    );
    // One advisor step per advisor of the turn, as the chat receives them
    // (run-steps.js): the refused one failed with its status alone; the unreachable
    // one carries the agent's own model's answer under the advisor's label, which the
    // chat's fixed line on every advisor step discloses.
    const live = new RunSteps();
    for (const event of seen.seen) live.observe(event);
    const steps = live.view("run-moa").steps.filter((step) => step.kind === "advisor");
    t.diagnostic(JSON.stringify(steps));
    assert.deepEqual(
      steps.map(({ id, advisor: n, model, state, failure }) => ({
        id,
        n,
        model,
        state,
        failure,
      })),
      [
        {
          id: "advisor:1:1",
          n: 1,
          model: "fake-advisor",
          state: "done",
          failure: undefined,
        },
        {
          id: "advisor:1:2",
          n: 2,
          model: "fake-refused",
          state: "failed",
          failure: "http-401",
        },
        {
          id: "advisor:1:3",
          n: 3,
          model: "fake-down",
          state: "done",
          failure: undefined,
        },
      ],
    );
    assert.match(steps[0].output, /ECHO: hello advisors/);
    assert.equal(steps[1].output, "");
    assert.doesNotMatch(JSON.stringify(steps), /invalid api key|127\.0\.0\.1/);
    assert.match(steps[2].output, /ECHO: hello advisors/);
    // Hermes left AgentPier's sections as written, so the next apply changes nothing.
    assert.deepEqual(sections(), written);
    seen.unsubscribe();
    await stop();
    assert.deepEqual(await strayAfterStop(dirs), []);
  },
);

// A raw turn of the stored session `stored` on `client`: its `message.complete`.
async function rawTurn(client, stored, text, submission) {
  const { session_id: sid } = await client.call("session.resume", {
    session_id: stored,
    omit_messages: true,
  });
  const done = new Promise((resolve) => {
    const off = client.subscribe((params) => {
      if (params.session_id !== sid || params.type !== "message.complete") return;
      off();
      resolve(params.payload);
    });
  });
  await client.call("prompt.submit", {
    session_id: sid,
    text,
    submission_id: submission,
  });
  return done;
}

// Hermes's own preset (hermes_cli/config_defaults.py) names these slots.
const builtInSlots = /openai-codex|openrouter|deepseek|claude-opus/;

test(
  "without advisors Hermes knows only AgentPier's closed preset",
  options,
  async (t) => {
    const { seen, check } = await hermesHome(t, "closed", (dirs) =>
      compiled(dirs, [
        { connectionId: "c-or", modelId: "openai/gpt-x", unavailable: "provider" },
        { connectionId: "c-lab", modelId: "lab-model", unavailable: "provider" },
      ]),
    );
    assert.doesNotMatch(check, /✗|⚠/, check);
    assert.equal(seen.model.provider, "custom");
    assert.deepEqual(seen.names, ["agentpier"]);
    assert.equal(seen.default, "agentpier");
    assert.equal(seen.preset.enabled, false);
    const slots = [...seen.preset.reference_models, seen.preset.aggregator];
    assert.deepEqual(
      [...new Set(slots.map((slot) => slot.provider))],
      ["custom:agentpier-closed"],
    );
    assert.doesNotMatch(JSON.stringify(seen.preset), builtInSlots);
    for (const slot of seen.slots)
      assert.deepEqual(slot, {
        provider: "custom:agentpier-closed",
        base_url: "http://127.0.0.1:9/v1",
        own_key: false,
      });
  },
);

test(
  "a chat still on Mixture of Agents after the advisors go reaches no other model",
  options,
  async (t) => {
    const main = await startFakeModel();
    const advisor = await startFakeModel();
    t.after(() => main.close());
    t.after(() => advisor.close());
    const dirs = hermesSandbox(t);
    const agentId = "hermes-closed";
    const stored = [{ connectionId: "c-adv", modelId: "fake-advisor" }];
    const extra = {
      runtime: "hermes",
      runtimeOptions: { hermes: { mixture: { advisors: stored } } },
    };
    const inputs = {
      optionConnections: [
        resolved(
          "c-adv",
          "fake-advisor",
          endpoint(advisor.baseUrl, "advisor-key", "fake-advisor"),
        ),
      ],
    };
    const model = { baseUrl: main.baseUrl };
    const { runtime, supervisor, agent, stop } = await startHermes(t, dirs, {
      agentId,
      model,
      extra,
      inputs,
    });
    // A chat an older AgentPier created: Hermes froze its route, `provider: moa`.
    const created = await supervisor.client.call("session.create", {
      request_id: "frozen-moa",
      title: "Frozen",
    });
    const session = created.stored_session_id || created.session_id;
    const advised = () =>
      advisor.requests.filter((r) => r.url.endsWith("/chat/completions")).length;
    const first = await rawTurn(supervisor.client, session, "hello advisors", "r1");
    assert.equal(first.status, "complete", JSON.stringify(first));
    const once = advised();
    assert.ok(once >= 1, "the advisor ran while it was set");
    // The owner removes the advisor.
    stored.length = 0;
    await runtime.config.apply({
      desired: contractAgent(agentId, model, { shell: "approval", ...extra }, inputs),
    });
    const log = path.join(agent.hermesHome, "logs", "agent.log");
    const before = fs.readFileSync(log, "utf8").length;
    const asked = main.requests.length;
    // The turn ends only after Hermes gave up on the closed address (minutes of
    // retries): what it called first is enough.
    const second = rawTurn(supervisor.client, session, "Say OK.", "r2");
    const called = /Auxiliary moa_aggregator: using|MoA reference model/;
    const deadline = Date.now() + 120000;
    let after = "";
    while (!called.test(after) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      after = fs.readFileSync(log, "utf8").slice(before);
    }
    second.catch(() => {});
    t.diagnostic(
      after
        .split("\n")
        .filter((line) => /moa|MoA/.test(line))
        .join("\n"),
    );
    assert.match(after, called, "the stale chat ran its preset");
    // No advisor ran, and nothing of Hermes's own preset was even resolved.
    assert.equal(advised(), once);
    assert.doesNotMatch(after, builtInSlots, after);
    assert.match(after, /moa_aggregator: using custom \(none\)/);
    // Whatever answered was the agent's own model, at its own endpoint.
    for (const request of main.requests.slice(asked))
      assert.equal(request.headers.authorization, "Bearer contract-key");
    await stop();
    assert.deepEqual(await strayAfterStop(dirs), []);
  },
);
