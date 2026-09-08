import test from "node:test";
import assert from "node:assert/strict";

import { setup, githubRepo } from "../helpers/repositories.js";
test("discovery searches accessible repositories across pages and exposes safe metadata", async (t) => {
  const calls = [];
  const { store } = setup(t, {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      const page = Number(new URL(url).searchParams.get("page"));
      return new Response(
        JSON.stringify(
          page === 1
            ? Array.from({ length: 100 }, (_, i) => githubRepo(i, "Acme", `repo-${i}`))
            : [githubRepo(101, "Other", "needle")],
        ),
        { status: 200 },
      );
    },
  });
  const credential = store.createCredential({
    name: "Work",
    host: "github.com",
    token: "private-discovery-token",
  });
  const result = await store.discover({ credentialId: credential.id, query: "NEEDLE" });
  assert.deepEqual(result.repositories, [
    {
      id: "101",
      name: "needle",
      fullName: "Other/needle",
      owner: "Other",
      private: true,
      url: "https://github.com/Other/needle.git",
    },
  ]);
  assert.deepEqual(result.organizations, [{ login: "Acme" }, { login: "Other" }]);
  assert.equal(result.total, 1);
  assert.equal(JSON.stringify(result).includes("private-discovery-token"), false);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, "https://api.github.com");
    assert.equal(new URL(call.url).pathname, "/user/repos");
    assert.equal(call.options.headers.Authorization, "Bearer private-discovery-token");
    assert.equal(call.options.redirect, "error");
  }
  const filtered = await store.discover({
    credentialId: credential.id,
    organization: "Acme",
    page: 2,
  });
  assert.equal(filtered.repositories.length, 50);
  assert.equal(
    filtered.repositories.every((repo) => repo.owner === "Acme"),
    true,
  );
  assert.equal(calls.length, 2, "typing and filtering reuse the bounded discovery cache");
});

test("Enterprise discovery uses exact configured origin and never trusts remote clone URLs", async (t) => {
  const calls = [];
  const { store } = setup(t, {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(
        JSON.stringify([
          {
            ...githubRepo(1, "Team", "project"),
            clone_url: "https://attacker.invalid/leak",
          },
          githubRepo(2, "../escape", "bad"),
        ]),
        { status: 200 },
      );
    },
  });
  const credential = store.createCredential({
    name: "Enterprise",
    host: "https://git.example.org:8443",
    token: "private-discovery-token",
  });
  const result = await store.discover({ credentialId: credential.id });
  assert.equal(
    calls[0].url.startsWith("https://git.example.org:8443/api/v3/user/repos?"),
    true,
  );
  assert.deepEqual(
    result.repositories.map((repo) => repo.url),
    ["https://git.example.org:8443/Team/project.git"],
  );
  for (const options of [
    { credentialId: credential.id, query: "x".repeat(201) },
    { credentialId: credential.id, page: "0" },
    { credentialId: credential.id, page: "2x" },
    { credentialId: credential.id, organization: "../bad" },
  ])
    await assert.rejects(store.discover(options), { status: 400 });
});

test("discovery bounds pagination, sanitizes upstream failures, and invalidates tokens", async (t) => {
  let mode = "many";
  let calls = 0;
  const { store } = setup(t, {
    fetchImpl: async () => {
      calls++;
      if (mode === "many")
        return new Response(
          JSON.stringify(
            Array.from({ length: 100 }, (_, i) =>
              githubRepo(calls * 100 + i, "Acme", `repo-${calls}-${i}`),
            ),
          ),
          {
            status: 200,
            headers: { Link: '<https://attacker.invalid/token>; rel="next"' },
          },
        );
      if (mode === "network") throw new Error("private-discovery-token redirected");
      return new Response("private-discovery-token", { status: Number(mode) });
    },
  });
  const credential = store.createCredential({
    name: "Work",
    host: "github.com",
    token: "private-discovery-token",
  });
  const result = await store.discover({ credentialId: credential.id });
  assert.equal(calls, 10);
  assert.equal(result.truncated, true);
  assert.equal(result.repositories.length, 50);
  assert.equal(result.total, 1000);
  assert.equal(result.hasMore, true);
  for (const failure of ["401", "403", "429", "302", "network"]) {
    mode = failure;
    store.updateCredential(credential.id, { name: "Work", token: "replacement-token" });
    await assert.rejects(
      store.discover({ credentialId: credential.id }),
      (error) =>
        error.status >= 400 && !error.message.includes("private-discovery-token"),
    );
  }
  store.removeCredential(credential.id);
  await assert.rejects(store.discover({ credentialId: credential.id }), { status: 404 });
});

test("shutdown cancels repository discovery and rejects new searches", async (t) => {
  let started;
  const requested = new Promise((resolve) => {
    started = resolve;
  });
  const { store } = setup(t, {
    fetchImpl: (url, { signal }) =>
      new Promise((resolve, reject) => {
        started();
        signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
      }),
  });
  const credential = store.createCredential({
    name: "Work",
    host: "github.com",
    token: "fixture-token",
  });
  const pending = store.discover({ credentialId: credential.id });
  const rejected = assert.rejects(pending, { status: 504 });
  await requested;
  await store.close();
  await rejected;
  await assert.rejects(store.discover({ credentialId: credential.id }), { status: 503 });
});
