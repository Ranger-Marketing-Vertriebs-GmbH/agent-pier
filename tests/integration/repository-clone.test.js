import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { RepositoryStore } from "../../server/features/repositories/repository-store.js";
import {
  setup,
  command,
  gitFixture,
  environment,
  observeSocketClose,
} from "../helpers/repositories.js";
test("clone validates matching origin and reserves destinations without touching existing files", async (t) => {
  const { store, dir } = setup(t);
  const credential = store.createCredential({
    name: "Work",
    host: "git.example.org:8443",
    token: "private-fixture-token",
  });
  for (const url of [
    "http://git.example.org:8443/a/b",
    "https://git.example.org/a/b",
    "https://git.example.org:8443.evil.org/a/b",
    "https://user:secret@git.example.org:8443/a/b",
    "https://git.example.org:8443/a/b?token=secret",
    "https://git.example.org:8443/a/b#secret",
    "https://git.example.org:8443\\@evil.org/a/b",
    "../outside",
  ]) {
    await assert.rejects(
      store.clone({
        credentialId: credential.id,
        url,
        parentDirectory: dir,
        folderName: "new",
      }),
      { status: 400 },
    );
    assert.equal(fs.existsSync(path.join(dir, "new")), false);
  }
  for (const folderName of ["", ".", "..", "../outside", "a/b", "a\\b"])
    await assert.rejects(
      store.clone({
        credentialId: credential.id,
        url: "owner/repo",
        parentDirectory: dir,
        folderName,
      }),
      { status: 400 },
    );
  const existing = path.join(dir, "existing");
  fs.mkdirSync(existing);
  fs.writeFileSync(path.join(existing, "keep"), "preserved");
  await assert.rejects(
    store.clone({
      credentialId: credential.id,
      url: "owner/repo",
      parentDirectory: dir,
      folderName: "existing",
    }),
    { status: 409 },
  );
  assert.equal(fs.readFileSync(path.join(existing, "keep"), "utf8"), "preserved");
  fs.symlinkSync(existing, path.join(dir, "link"));
  await assert.rejects(
    store.clone({
      credentialId: credential.id,
      url: "owner/repo",
      parentDirectory: dir,
      folderName: "link",
    }),
    { status: 409 },
  );
  assert.equal(fs.lstatSync(path.join(dir, "link")).isSymbolicLink(), true);
  assert.deepEqual(store.listProjects(), []);
});

test("actual authenticated HTTPS clone isolates inherited Git config and stores a clean remote", async (t) => {
  const { store, dir } = setup(t);
  const fixture = await gitFixture(t, dir);
  const marker = path.join(dir, "helper-ran");
  const trace = path.join(dir, "trace");
  const hookMarker = path.join(dir, "hook-ran");
  const template = path.join(dir, "template");
  fs.mkdirSync(path.join(template, "hooks"), { recursive: true });
  fs.writeFileSync(
    path.join(template, "hooks", "post-checkout"),
    `#!/bin/sh\ntouch '${hookMarker}'\n`,
    { mode: 0o755 },
  );
  const inherited = path.join(dir, "inherited.gitconfig");
  fs.writeFileSync(
    inherited,
    `[credential]\nhelper = !touch '${marker}'\n[url "file:///unreachable/"]\ninsteadOf = ${fixture.origin}/\n[http]\nextraHeader = Authorization: leaked-parent-secret\n[core]\nhooksPath = ${template}/hooks\n[init]\ntemplateDir = ${template}\n[submodule]\nrecurse = true\n`,
  );
  environment(t, {
    GIT_SSL_CAINFO: fixture.ca,
    GIT_CONFIG_GLOBAL: inherited,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: "Authorization: leaked-env-secret",
    GIT_EXEC_PATH: "/nonexistent",
    GIT_TRACE: trace,
    GIT_SSL_NO_VERIFY: "1",
    GIT_TEMPLATE_DIR: template,
  });
  const credential = store.createCredential({
    name: "Local test",
    host: fixture.origin,
    token: "private-fixture-token",
  });
  const pending = store.clone({
    credentialId: credential.id,
    url: `${fixture.origin}/repo.git`,
    parentDirectory: dir,
    folderName: "cloned",
  });
  await assert.rejects(
    store.clone({
      credentialId: credential.id,
      url: `${fixture.origin}/repo.git`,
      parentDirectory: dir,
      folderName: "cloned",
    }),
    { status: 409 },
  );
  const project = await pending;
  assert.equal(
    fs.readFileSync(path.join(project.path, "README.md"), "utf8"),
    "Authentic HTTPS fixture content\n",
  );
  assert.deepEqual(Object.keys(project).sort(), [
    "createdAt",
    "credentialId",
    "id",
    "name",
    "path",
    "url",
  ]);
  assert.equal(project.name, "cloned");
  assert.equal(project.credentialId, credential.id);
  assert.equal(project.url, `${fixture.origin}/repo.git`);
  const localConfig = fs.readFileSync(path.join(project.path, ".git/config"), "utf8");
  assert.equal(
    command("git", ["remote", "get-url", "origin"], project.path),
    `${fixture.origin}/repo.git`,
  );
  for (const sensitive of [
    "private-fixture-token",
    "credential.helper",
    "AGENTPIER_GIT_CREDENTIAL_FILE",
  ])
    assert.equal(localConfig.includes(sensitive), false);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(trace), false);
  assert.equal(fs.existsSync(hookMarker), false);
  assert.equal(fs.existsSync(path.join(project.path, "child", ".git")), false);
  assert.ok(fixture.requests.some((request) => !request.auth));
  assert.ok(
    fixture.requests.some(
      (request) =>
        request.auth ===
        `Basic ${Buffer.from("x-access-token:private-fixture-token").toString("base64")}`,
    ),
  );
  assert.equal(
    fixture.requests.some((request) => request.auth?.includes("leaked-")),
    false,
  );
  assert.deepEqual(
    new RepositoryStore({ dataDir: path.join(dir, "data"), home: dir }).listProjects(),
    [project],
  );
  assert.equal(JSON.stringify(project).includes("private-fixture-token"), false);
  assert.deepEqual(fs.readdirSync(path.join(dir, "data")).sort(), [
    "repositories.json",
    "repository-secrets",
  ]);
  const shorthand = await store.clone({
    credentialId: credential.id,
    url: "owner/repo",
    parentDirectory: "~",
    folderName: "shorthand",
  });
  assert.equal(shorthand.url, `${fixture.origin}/owner/repo`);
  assert.equal(
    fs.readFileSync(path.join(shorthand.path, "README.md"), "utf8"),
    "Authentic HTTPS fixture content\n",
  );
});

test("real Git failures are sanitized, redirects blocked and only reserved clone directories removed", async (t) => {
  const { store, dir } = setup(t, { cloneTimeoutMs: 500 });
  const fixture = await gitFixture(t, dir);
  environment(t, { GIT_SSL_CAINFO: fixture.ca });
  const credential = store.createCredential({
    name: "Test",
    host: fixture.origin,
    token: "private-fixture-token",
  });
  for (const repo of ["redirect", "failure", "missing", "hang"]) {
    await assert.rejects(
      store.clone({
        credentialId: credential.id,
        url: `${fixture.origin}/${repo}.git`,
        parentDirectory: dir,
        folderName: repo,
      }),
      (error) => {
        assert.equal(error.message.includes("private-fixture-token"), false);
        assert.equal(JSON.stringify(error).includes("private-fixture-token"), false);
        assert.equal(error.status, repo === "hang" ? 504 : 400);
        return true;
      },
    );
    assert.equal(fs.existsSync(path.join(dir, repo)), false);
  }
  assert.equal(
    fixture.requests.some((request) => request.url.startsWith("/unexpected.git")),
    false,
  );
  assert.deepEqual(store.listProjects(), []);
  assert.deepEqual(fs.readdirSync(path.join(dir, "data")).sort(), [
    "repositories.json",
    "repository-secrets",
  ]);
});

test(
  "closing the store promptly kills a pending real Git request and awaits private clone cleanup",
  { timeout: 10000 },
  async (t) => {
    const { store, dir } = setup(t, { cloneTimeoutMs: 300000 });
    assert.equal(
      typeof store.close,
      "function",
      "RepositoryStore owns active clone shutdown",
    );
    const fixture = await gitFixture(t, dir);
    environment(t, { GIT_SSL_CAINFO: fixture.ca });
    const credential = store.createCredential({
      name: "Test",
      host: fixture.origin,
      token: "private-fixture-token",
    });
    const existing = path.join(dir, "keep");
    fs.writeFileSync(existing, "preserved");
    const pending = store.clone({
      credentialId: credential.id,
      url: `${fixture.origin}/hang.git`,
      parentDirectory: dir,
      folderName: "pending",
    });
    const rejected = assert.rejects(pending, { status: 503 });
    const request = await fixture.firstRequest;
    const socketClosed = observeSocketClose(request.socket);
    const scratch = fs
      .readdirSync(path.join(dir, "data"))
      .find((name) => name.startsWith(".clone-"));
    assert.ok(scratch);
    assert.equal(fs.existsSync(path.join(dir, "data", scratch, "credential.json")), true);
    const started = Date.now();
    await store.close();
    await rejected;
    for (const error of await socketClosed) {
      assert.equal(error.code, "ECONNRESET", error.message);
    }
    assert.ok(
      Date.now() - started < 3000,
      "shutdown cancels immediately instead of waiting for the five-minute clone timeout",
    );
    assert.equal(fs.existsSync(path.join(dir, "pending")), false);
    assert.equal(fs.existsSync(path.join(dir, "data", scratch)), false);
    assert.equal(fs.readFileSync(existing, "utf8"), "preserved");
    assert.deepEqual(store.listProjects(), []);
    await assert.rejects(
      store.clone({
        credentialId: credential.id,
        url: `${fixture.origin}/repo.git`,
        parentDirectory: dir,
        folderName: "after-close",
      }),
      { status: 503 },
    );
    assert.equal(fs.existsSync(path.join(dir, "after-close")), false);
    await store.close();
  },
);

test("public github clones need no profile and isolate ambient credentials", async (t) => {
  const { store, dir } = setup(t);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const capture = path.join(dir, "invocation.json");
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!${process.execPath}\nconst fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), env: process.env, files: fs.readdirSync(process.cwd()) }));\n`,
    { mode: 0o755 },
  );
  environment(t, {
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "!ambient-helper",
    AGENTPIER_GIT_CREDENTIAL_FILE: "/ambient/secret",
  });
  const project = await store.clone({
    url: "https://github.com/octocat/Hello-World.git",
    parentDirectory: dir,
    folderName: "public",
  });
  assert.equal(project.credentialId, null);
  assert.equal(project.url, "https://github.com/octocat/Hello-World.git");
  const invoked = JSON.parse(fs.readFileSync(capture));
  assert.deepEqual(invoked.files, []);
  assert.ok(invoked.args.includes("credential.helper="));
  assert.equal(
    invoked.args.some((arg) => arg.includes("git-credential")),
    false,
  );
  assert.equal(invoked.env.GIT_CONFIG_COUNT, undefined);
  assert.equal(invoked.env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(invoked.env.GIT_TERMINAL_PROMPT, "0");
  assert.ok(invoked.args.includes("protocol.allow=never"));
  assert.ok(invoked.args.includes("http.followRedirects=false"));
  for (const url of [
    "https://enterprise.example/a/b",
    "git@github.com:a/b",
    "https://user:token@github.com/a/b",
    "https://github.com.evil/a/b",
  ]) {
    await assert.rejects(store.clone({ url, parentDirectory: dir, folderName: "bad" }), {
      status: 400,
    });
  }
});
