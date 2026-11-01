import test from "node:test";
import assert from "node:assert/strict";

const unavailable = (error) => error.code === "UNAVAILABLE" && error.status === 503;
const profile = { profile: "agentpier-ap-1" };

/**
 * The skills, browser and models sub-ports of the runtime port contract
 * (runtime-port-contract.js): skill status with the refusal for an agent the runtime
 * does not know, a browser started, read and stopped through its control API, a
 * model account signed in through the login wizard, probed and signed out, views
 * bound to a replaced connection, and all of it while the runtime is unreachable.
 */
export function toolsContract(name, make) {
  test(`${name}: skills report their status; an unknown agent is told apart`, async () => {
    const { skills } = await make({});
    const { skills: listed } = await skills.status();
    assert.ok(Array.isArray(listed));
    assert.ok(listed.every((skill) => typeof skill.name === "string"));
    const refused = await skills.status({ agentId: "nobody" }).then(
      () => assert.fail("an unknown agent is refused"),
      (error) => error,
    );
    assert.equal(skills.unknownAgent(refused), true);
    assert.equal(skills.unknownAgent(new Error("other")), false);
    assert.equal(skills.unknownAgent(undefined), false);
  });

  test(`${name}: the browser starts, lists its tabs and stops`, async () => {
    const { browser } = await make({});
    const status = () => browser.request({ method: "GET", path: "/", query: profile });
    assert.equal((await status()).running, false);
    await browser.request({
      method: "POST",
      path: "/start",
      query: profile,
      timeoutMs: 30000,
    });
    assert.equal((await status()).running, true);
    const { tabs } = await browser.request({
      method: "GET",
      path: "/tabs",
      query: profile,
    });
    assert.ok(Array.isArray(tabs));
    await browser.request({ method: "POST", path: "/stop", query: profile });
    assert.equal((await status()).running, false);
  });

  test(`${name}: openStream opens a live-view socket on the runtime's own origin`, async () => {
    const { browser } = await make({});
    assert.ok(browser.openStream({ path: "/browser/screencast/t1" }));
    // Synchronous refusals: a path that would leave the runtime's origin.
    for (const path of ["//evil.example/x", "https://evil.example/x"])
      assert.throws(() => browser.openStream({ path }), path);
  });

  test(`${name}: a model account signs in, is probed and signs out`, async () => {
    const { models } = await make({});
    const profiles = async () =>
      (await models.status({ timeoutMs: 60000 })).providers.flatMap((p) => p.profiles);
    assert.deepEqual(await profiles(), []);
    await models.login({
      sessionId: "s1",
      authChoice: "openai/openai-device-code",
      timeoutMs: 60000,
    });
    const step = await models.loginStep({ sessionId: "s1", timeoutMs: 60000 });
    assert.deepEqual([step.done, step.status], [true, "done"]);
    const [signedIn] = await profiles();
    assert.equal(typeof signedIn.profileId, "string");
    const probe = await models.probe({
      provider: "openai",
      profileId: signedIn.profileId,
      probeTimeoutMs: 15000,
      timeoutMs: 20000,
    });
    assert.equal(probe.status, "ok");
    const { models: listed } = await models.catalog({
      provider: "openai",
      refresh: true,
      timeoutMs: 1000,
    });
    assert.ok(Array.isArray(listed));
    await models.logout({
      provider: "openai",
      profileIds: [signedIn.profileId],
      timeoutMs: 60000,
    });
    assert.deepEqual(await profiles(), []);
    // A cancelled sign-in takes no further step.
    await models.login({ sessionId: "s2", authChoice: "x", timeoutMs: 60000 });
    await models.cancelLogin({ sessionId: "s2", timeoutMs: 2000 });
    await assert.rejects(models.loginStep({ sessionId: "s2", timeoutMs: 1000 }));
  });

  test(`${name}: skills, browser and models views bound to a replaced connection reach nothing`, async () => {
    const runtime = await make({});
    const connection = runtime.host.connection();
    const [skills, browser, models] = ["skills", "browser", "models"].map((port) =>
      runtime[port].on(connection),
    );
    await runtime.host.restart();
    for (const pending of [
      skills.status(),
      browser.request({ method: "POST", path: "/start", query: profile }),
      models.status({ timeoutMs: 1000 }),
      models.login({ sessionId: "s1", authChoice: "x", timeoutMs: 1000 }),
      models.loginStep({ sessionId: "s1", timeoutMs: 1000 }),
      models.cancelLogin({ sessionId: "s1", timeoutMs: 1000 }),
      models.catalog({ provider: "openai", timeoutMs: 1000 }),
    ])
      await assert.rejects(pending, unavailable);
    assert.equal(skills.unknownAgent(new Error("x")), false);
    // The new connection received none of it.
    const status = await runtime.browser.request({
      method: "GET",
      path: "/",
      query: profile,
    });
    assert.equal(status.running, false);
    await assert.rejects(runtime.models.loginStep({ sessionId: "s1", timeoutMs: 1000 }));
  });

  test(`${name}: skills, browser and models reject while unreachable`, async () => {
    const { skills, browser, models } = await make({ unreachable: true });
    const calls = {
      "skills.status": () => skills.status(),
      "browser.request": () =>
        browser.request({ method: "GET", path: "/", query: profile }),
      "models.catalog": () => models.catalog({ provider: "openai", timeoutMs: 1 }),
      "models.status": () => models.status({ timeoutMs: 1 }),
      "models.probe": () =>
        models.probe({ provider: "openai", profileId: "p", timeoutMs: 1 }),
      "models.logout": () =>
        models.logout({ provider: "openai", profileIds: [], timeoutMs: 1 }),
      "models.login": () =>
        models.login({ sessionId: "s", authChoice: "x", timeoutMs: 1 }),
      "models.loginStep": () => models.loginStep({ sessionId: "s", timeoutMs: 1 }),
      "models.cancelLogin": () => models.cancelLogin({ sessionId: "s", timeoutMs: 1 }),
    };
    for (const [method, call] of Object.entries(calls)) {
      // A rejection, never a synchronous throw: callers await it inside try/catch.
      const pending = call();
      assert.ok(pending instanceof Promise, method);
      await assert.rejects(pending, method);
    }
  });
}

/**
 * Skills, a browser and model accounts held in memory for the fake runtime. Every
 * async call goes through `reach`, which rejects while the runtime is unreachable; a
 * view bound to a replaced connection rejects as closed. Accounts outlive restarts,
 * the browser and running sign-ins do not.
 */
export function fakeToolPorts({ reach, connection }) {
  const answered = (code, remoteMessage = code) =>
    Object.assign(new Error(code), { code, answered: true, remoteMessage });
  let running = false;
  let current = connection();
  const profiles = [];
  const wizards = new Set();
  // A restart ends the browser and every sign-in under way.
  const fresh = () => {
    if (connection() === current) return;
    current = connection();
    running = false;
    wizards.clear();
  };
  const at = (answer) => reach(() => (fresh(), answer()));
  const methods = {
    skills: {
      status: ({ agentId } = {}) =>
        at(() => {
          if (agentId) throw answered("INVALID_REQUEST", `unknown agent id "${agentId}"`);
          return { skills: [{ name: "weather", source: "bundled", eligible: true }] };
        }),
      unknownAgent: (error) =>
        error?.code === "INVALID_REQUEST" && /unknown agent/.test(error.remoteMessage),
    },
    browser: {
      request: ({ method, path }) =>
        at(() => {
          if (method === "POST" && path === "/start") running = true;
          if (method === "POST" && path === "/stop") running = false;
          if (path === "/tabs") return { tabs: [] };
          return { running };
        }),
      openStream: ({ path }) => {
        if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//"))
          throw answered("RPC_FAILED");
        return { path };
      },
    },
    models: {
      catalog: ({ provider }) => at(() => ({ models: [{ id: "gpt-fake", provider }] })),
      status: () =>
        at(() => ({ providers: [{ provider: "openai", profiles: [...profiles] }] })),
      probe: ({ profileId }) =>
        at(() => ({
          status: profiles.some((p) => p.profileId === profileId) ? "ok" : "auth",
        })),
      logout: ({ profileIds }) =>
        at(() => {
          const kept = profiles.filter((p) => !profileIds.includes(p.profileId));
          profiles.splice(0, profiles.length, ...kept);
          return { ok: true };
        }),
      login: ({ sessionId }) => at(() => (wizards.add(sessionId), {})),
      loginStep: ({ sessionId }) =>
        at(() => {
          if (!wizards.delete(sessionId)) throw answered("INVALID_REQUEST");
          profiles.push({ profileId: "openai:fake", type: "oauth", status: "ok" });
          return { done: true, status: "done" };
        }),
      cancelLogin: ({ sessionId }) => at(() => (wizards.delete(sessionId), { ok: true })),
    },
  };
  const sync = ["unknownAgent", "openStream"];
  const closed = () =>
    Promise.reject(
      Object.assign(new Error("closed"), { code: "UNAVAILABLE", status: 503 }),
    );
  const on = (port) => (bound) =>
    Object.freeze(
      Object.fromEntries(
        Object.entries(port).map(([name, method]) => [
          name,
          sync.includes(name)
            ? method
            : (...args) => (bound && bound === connection() ? method(...args) : closed()),
        ]),
      ),
    );
  return Object.fromEntries(
    Object.entries(methods).map(([name, port]) => [name, { ...port, on: on(port) }]),
  );
}
