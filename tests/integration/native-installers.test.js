import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolInstaller } from "../../server/features/tools/tool-installer.js";
import {
  detectTools,
  detectUtilities,
} from "../../server/features/accounts/account-store.js";

for (const tool of ["codex", "claude", "opencode"])
  test(`${tool} prefers the official native installer in the server home without npm`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-native-install-"));
    const home = path.join(root, "home");
    await fs.mkdir(home);
    const target = path.join(
      home,
      tool === "opencode" ? ".opencode/bin" : ".local/bin",
      tool,
    );
    const urls = [];
    const script = `#!/bin/bash\nset -eu\nmkdir -p "$(dirname '${target}')"\nprintf '#!/bin/sh\\nprintf "9.8.7 fixture\\\\n"\\n' > '${target}'\nchmod 700 '${target}'\n`;
    const installer = new ToolInstaller({
      dataDir: root,
      home,
      npmCli: null,
      detect: () => detectTools({ HOME: home, PATH: "" }, false),
      nativeFetch: async (url) => {
        urls.push(String(url));
        return new Response(script);
      },
    });
    t.after(async () => {
      await installer.close();
      await fs.rm(root, { recursive: true, force: true });
    });
    assert.equal(
      installer.list().installations.find((x) => x.tool === tool).installer,
      "native-script",
    );
    assert.equal(installer.start(tool).status, "running");
    await installer.active.done;
    const result = installer.list().installations.find((x) => x.tool === tool);
    assert.equal(result.status, "succeeded", result.message);
    assert.match(result.version, /9\.8\.7/);
    assert.equal(result.destination, path.dirname(target));
    assert.equal(
      urls[0],
      {
        codex: "https://chatgpt.com/codex/install.sh",
        claude: "https://claude.ai/install.sh",
        opencode: "https://opencode.ai/install",
      }[tool],
    );
  });

test("nono installs through its official script, pinned to the server home", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-native-nono-"));
  const home = path.join(root, "home");
  await fs.mkdir(home);
  const target = path.join(home, ".local/bin", "nono");
  const urls = [];
  // The real script installs into NONO_INSTALL_DIR when it is set, and falls
  // back to /usr/local/bin — and to sudo — when it is not. This stand-in fails
  // unless the variable arrived, which is what keeps an unattended install off
  // the sudo path.
  const script = [
    "#!/bin/sh",
    "set -eu",
    'test -n "${NONO_INSTALL_DIR:-}" || { echo "NONO_INSTALL_DIR unset" >&2; exit 1; }',
    'mkdir -p "$NONO_INSTALL_DIR"',
    `printf '#!/bin/sh\\nprintf "nono 0.64.1\\\\n"\\n' > "$NONO_INSTALL_DIR/nono"`,
    'chmod 700 "$NONO_INSTALL_DIR/nono"',
    "",
  ].join("\n");
  const installer = new ToolInstaller({
    dataDir: root,
    home,
    npmCli: null,
    detect: () => detectUtilities({ HOME: home, PATH: "" }, false),
    nativeFetch: async (url) => {
      urls.push(String(url));
      return new Response(script);
    },
  });
  t.after(async () => {
    await installer.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const offered = installer.list().installations.find((x) => x.tool === "nono");
  assert.equal(offered.installer, "native-script");
  assert.equal(offered.utility, true);
  assert.equal(offered.destination, path.dirname(target));
  // npm never publishes nono, so only the native method is accepted.
  assert.throws(() => installer.start("nono", "npm"));
  assert.equal(installer.start("nono").status, "running");
  await installer.active.done;
  const result = installer.list().installations.find((x) => x.tool === "nono");
  assert.equal(result.status, "succeeded", result.message);
  assert.match(result.version, /0\.64\.1/);
  assert.equal(urls[0], "https://nono.sh/install.sh");
  assert.equal((await fs.stat(target)).isFile(), true);
});

test("native script download follows only the documented vendor bootstrap redirect", async () => {
  const { downloadNativeScript } =
    await import("../../server/features/tools/native-installer.js");
  const urls = [];
  const script = await downloadNativeScript(
    "claude",
    async (url) => {
      urls.push(String(url));
      return urls.length === 1
        ? new Response(null, {
            status: 302,
            headers: {
              location: "https://downloads.claude.ai/claude-code-releases/bootstrap.sh",
            },
          })
        : new Response("#!/bin/bash\nexit 0\n");
    },
    new AbortController().signal,
  );
  assert.ok(script.toString().startsWith("#!/bin/bash"));
  assert.equal(urls.length, 2);
  await assert.rejects(
    downloadNativeScript(
      "claude",
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        }),
      new AbortController().signal,
    ),
    /redirect/,
  );
});

for (const [name, response] of [
  ["oversized script", () => new Response("#!" + "x".repeat(2 * 1024 * 1024))],
  ["HTML error page", () => new Response("<html>error</html>")],
  ["HTTP error", () => new Response("no", { status: 503 })],
])
  test(`native download rejects ${name} before execution`, async () => {
    const { downloadNativeScript } =
      await import("../../server/features/tools/native-installer.js");
    await assert.rejects(
      downloadNativeScript("codex", async () => response(), new AbortController().signal),
    );
  });

test("native install refuses to overwrite an existing destination even if detection misses it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-native-existing-"));
  await fs.mkdir(path.join(root, "data"));
  const destination = path.join(root, ".local/bin");
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, "claude"), "keep");
  const installer = new ToolInstaller({
    dataDir: path.join(root, "data"),
    home: root,
    detect: () => [],
  });
  t.after(async () => {
    await installer.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  assert.throws(
    () => installer.start("claude"),
    (error) => error.status === 409,
  );
  assert.equal(await fs.readFile(path.join(destination, "claude"), "utf8"), "keep");
});
