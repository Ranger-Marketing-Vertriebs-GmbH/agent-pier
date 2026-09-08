import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import https from "node:https";

import { RepositoryStore } from "../../server/features/repositories/repository-store.js";
export const helper = fileURLToPath(
  new URL("../../server/git-credential.mjs", import.meta.url),
);
export function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-repositories-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(
    typeof RepositoryStore,
    "function",
    "RepositoryStore implements the repository backend",
  );
  return {
    dir,
    store: new RepositoryStore({
      dataDir: path.join(dir, "data"),
      home: dir,
      ...options,
    }),
  };
}

export function command(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  assert.equal(result.status, 0, `${command} fixture setup: ${result.stderr}`);
  return result.stdout.trim();
}

// events.once(socket, "close") rejects on error before the caller can await
// shutdown. Retain every error for explicit assertions, but await actual close.
export function observeSocketClose(socket) {
  const errors = [];
  const onError = (error) => errors.push(error);
  socket.on("error", onError);
  return new Promise((resolve) => {
    socket.once("close", () => {
      socket.off("error", onError);
      resolve(errors);
    });
  });
}

export async function gitFixture(t, dir) {
  const fixture = path.join(dir, "fixture");
  fs.mkdirSync(fixture);
  const config = path.join(fixture, "openssl.cnf");
  fs.writeFileSync(
    config,
    "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n",
  );
  command(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "key.pem",
      "-out",
      "cert.pem",
      "-days",
      "1",
      "-config",
      config,
    ],
    fixture,
  );
  command("git", ["init", "--initial-branch=main", "source"], fixture);
  const source = path.join(fixture, "source");
  fs.writeFileSync(path.join(source, "README.md"), "Authentic HTTPS fixture content\n");
  fs.writeFileSync(
    path.join(source, ".gitmodules"),
    '[submodule "disabled"]\npath = child\nurl = https://unreachable.invalid/sub.git\n',
  );
  command("git", ["add", "."], source);
  command(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
    source,
  );
  const commit = command("git", ["rev-parse", "HEAD"], source);
  command(
    "git",
    ["update-index", "--add", "--cacheinfo", `160000,${commit},child`],
    source,
  );
  command(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "add submodule gitlink",
    ],
    source,
  );
  command("git", ["clone", "--bare", source, "repo.git"], fixture);
  command("git", ["update-server-info"], path.join(fixture, "repo.git"));
  const requests = [];
  let resolveFirstRequest;
  const firstRequest = new Promise((resolve) => {
    resolveFirstRequest = resolve;
  });
  const server = https.createServer(
    {
      key: fs.readFileSync(path.join(fixture, "key.pem")),
      cert: fs.readFileSync(path.join(fixture, "cert.pem")),
    },
    (req, res) => {
      resolveFirstRequest(req);
      requests.push({ url: req.url, auth: req.headers.authorization });
      if (req.url.startsWith("/hang.git")) return;
      if (req.url.startsWith("/redirect.git")) {
        res.writeHead(302, { Location: "/unexpected.git/info/refs" });
        res.end();
        return;
      }
      if (req.url.startsWith("/failure.git")) {
        res.writeHead(500);
        res.end("private-fixture-token");
        return;
      }
      if (
        req.headers.authorization !==
        `Basic ${Buffer.from("x-access-token:private-fixture-token").toString("base64")}`
      ) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' });
        res.end("Authentication required");
        return;
      }
      const requestPath = new URL(req.url, "https://localhost").pathname.replace(
        /^\/owner\/repo(?=\/|$)/,
        "/repo.git",
      );
      const file = path.resolve(fixture, `.${requestPath}`);
      if (
        !file.startsWith(`${fixture}${path.sep}`) ||
        !fs.existsSync(file) ||
        !fs.statSync(file).isFile()
      ) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return {
    origin: `https://127.0.0.1:${server.address().port}`,
    ca: path.join(fixture, "cert.pem"),
    requests,
    firstRequest,
  };
}

export function environment(t, values) {
  const prior = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(values))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  t.after(() => {
    for (const [key, value] of Object.entries(prior))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
}

export function githubRepo(id, owner, name, type = "Organization") {
  return {
    id,
    name,
    full_name: `${owner}/${name}`,
    owner: { login: owner, type },
    private: true,
    clone_url: `https://github.com/${owner}/${name}.git`,
  };
}
