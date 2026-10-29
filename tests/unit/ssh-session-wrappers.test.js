import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  renderWrapper,
  resolveOpenSshBinaries,
} from "../../server/features/ssh/ssh-session-config.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier ssh session wrappers "));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

const tempFolder = (name) => fs.mkdtempSync(path.join(root, `${name} `));
const dash = ["/bin/dash", "/usr/bin/dash"].find((file) => fs.existsSync(file));
const shells = [null, ...(dash ? [dash] : [])];

// A wrapper around a recording "real" binary that writes its argv, NUL-separated.
function recorder(tool, aliases = ["proxmox-2", "db", "host-22"]) {
  const folder = tempFolder(`wrapper ${tool}`);
  const out = path.join(folder, "argv");
  const realPath = path.join(folder, `real ${tool}`);
  fs.writeFileSync(
    realPath,
    `#!/bin/sh\nprintf '%s\\0' "$#" "$@" > ${JSON.stringify(out)}\n`,
    { mode: 0o700 },
  );
  const configPath = path.join(folder, 'it\'s $(id) "config"');
  const wrapper = path.join(folder, tool);
  fs.writeFileSync(wrapper, renderWrapper({ tool, realPath, configPath, aliases }), {
    mode: 0o700,
  });
  const run = (args) => {
    let argv;
    for (const shell of shells) {
      if (shell) execFileSync(shell, [wrapper, ...args], { cwd: folder });
      else execFileSync(wrapper, args, { cwd: folder });
      const [count, ...rest] = fs.readFileSync(out, "utf8").slice(0, -1).split("\0");
      assert.equal(rest.length, Number(count));
      if (argv) assert.deepEqual(rest, argv, `${shell} differs`);
      argv = rest;
    }
    return argv;
  };
  const flagged = (args) => {
    const argv = run(args);
    if (argv.length === args.length) {
      assert.deepEqual(argv, args);
      return false;
    }
    assert.deepEqual(argv, ["-F", configPath, ...args]);
    return true;
  };
  return { run, flagged, configPath, folder };
}

test("ssh adds -F only when the destination or a jump host is an alias", () => {
  const { flagged } = recorder("ssh");
  for (const args of [
    ["proxmox-2"],
    ["proxmox-2", "uptime"],
    ["-p", "22", "proxmox-2", "git-upload-pack 'r.git'"],
    ["-vp22", "deploy@proxmox-2"],
    ["-l", "web", "db"],
    ["-o", "BatchMode=yes", "ssh://proxmox-2"],
    ["ssh://deploy@proxmox-2:2222"],
    ["ssh://db/"],
    ["host-22", "-p", "22"],
    ["--", "db", "ls"],
    ["-J", "db", "github.com"],
    ["-Jdeploy@db:2222", "github.com"],
    ["-J", "jump.example.com,ssh://db", "github.com"],
  ])
    assert.equal(flagged(args), true, args.join(" "));
  for (const args of [
    ["github.com", "ls", "db"],
    ["-l", "web", "github.com"],
    ["-l", "db", "github.com"],
    ["-p", "22", "x"],
    ["-o", "db", "github.com"],
    ["-i", "db", "github.com"],
    ["-vi", "db", "github.com"],
    ["github.com", "-l", "db"],
    ["github.com", "--", "db"],
    ["--", "github.com", "-J", "db"],
    ["-J", "jump.example.com", "github.com"],
    ["github.com", "proxmox-2x"],
    ["proxmox-2.example.com"],
    ["ssh://proxmox-2.example.com/r.git"],
    ["db:22"],
    ["xdb"],
    ["db@other"],
    ["-"],
    [],
  ])
    assert.equal(flagged(args), false, args.join(" "));
});

test("a caller's own -F is never overridden", () => {
  const { flagged } = recorder("ssh");
  assert.equal(flagged(["-F", "/home/u/.ssh/other", "db"]), false);
  assert.equal(flagged(["-F/home/u/.ssh/other", "db"]), false);
  assert.equal(flagged(["-vF", "/x", "-J", "db", "github.com"]), false);
  assert.equal(flagged(["db", "-F", "/x"]), false);
  assert.equal(recorder("scp").flagged(["-F", "/x", "a", "db:/tmp/"]), false);
  assert.equal(recorder("sftp").flagged(["-F", "/x", "db"]), false);
});

test("scp checks every operand for remote paths and scp URIs", () => {
  const { flagged } = recorder("scp");
  for (const args of [
    ["file", "db:/tmp/"],
    ["deploy@proxmox-2:/tmp/x", "."],
    ["-P", "2222", "a", "b", "db:"],
    ["-r", "dir", "scp://db/srv"],
    ["scp://deploy@proxmox-2:2222/x", "."],
    ["scp://db", "."],
    ["-J", "db", "a", "github.com:/x"],
    ["-o", "BatchMode=yes", "--", "a", "db:/x"],
  ])
    assert.equal(flagged(args), true, args.join(" "));
  for (const args of [
    ["db", "x"],
    ["-i", "db:/x", "a", "github.com:/x"],
    ["file", "github.com:/x/db:y"],
    ["ssh://db/x", "."],
    ["sftp://db/x", "."],
    ["proxmox-2x:/a", "."],
  ])
    assert.equal(flagged(args), false, args.join(" "));
});

test("sftp checks the destination, including sftp URIs", () => {
  const { flagged } = recorder("sftp");
  for (const args of [
    ["db"],
    ["deploy@proxmox-2"],
    ["db:/srv"],
    ["-P", "2222", "deploy@db:/srv"],
    ["sftp://db"],
    ["sftp://deploy@proxmox-2:2222/srv"],
    ["-J", "db", "github.com"],
  ])
    assert.equal(flagged(args), true, args.join(" "));
  for (const args of [
    ["github.com", "db"],
    ["-b", "db", "github.com"],
    ["-s", "db", "github.com"],
    ["scp://db"],
    ["ssh://db"],
  ])
    assert.equal(flagged(args), false, args.join(" "));
});

test("wrappers pass hostile arguments through untouched", () => {
  const { run, flagged, configPath, folder } = recorder("ssh");
  const hostile = [
    "-oProxyCommand=touch pwned-a",
    "--",
    "with space",
    "it's",
    '"double"',
    "$(touch pwned-b)",
    "`touch pwned-c`",
    "a; touch pwned-d",
    "line\nbreak",
    "*",
    "",
    "-F",
  ];
  assert.deepEqual(run(hostile), hostile);
  assert.deepEqual(run(["proxmox-2", ...hostile]), [
    "-F",
    configPath,
    "proxmox-2",
    ...hostile,
  ]);
  assert.equal(flagged(["$(touch pwned-e)@db"]), true);
  assert.equal(flagged(["-J", "$(touch pwned-f),db", "x"]), true);
  assert.equal(flagged(["-e", "*", "-o", "$(touch pwned-g)", "*"]), false);
  assert.deepEqual(
    fs.readdirSync(folder).filter((name) => name.startsWith("pwned")),
    [],
  );
});

test("wrapper scripts are plain sh without eval and refuse bad input", () => {
  const input = { realPath: "/usr/bin/ssh", configPath: "/c", aliases: ["proxmox-2"] };
  for (const tool of ["ssh", "scp", "sftp"]) {
    const script = renderWrapper({ ...input, tool });
    assert.match(script, /^#!\/bin\/sh\n/);
    assert.doesNotMatch(script, /\beval\b/);
    assert.match(script, /exec "\$real" "\$@"\n$/);
    execFileSync("/bin/sh", ["-n", "-c", script]);
  }
  assert.throws(() => renderWrapper({ ...input, tool: "ssh", aliases: ["a|*"] }));
  assert.throws(() => renderWrapper({ ...input, tool: "ssh", aliases: ["22"] }));
  assert.throws(() => renderWrapper({ ...input, tool: "rsync" }));
  assert.equal(
    renderWrapper({ ...input, tool: "ssh", aliases: [] }),
    "#!/bin/sh\nreal='/usr/bin/ssh'\nconfig='/c'\nexec \"$real\" \"$@\"\n",
  );
});

function fakeBinaries(names, dir = tempFolder("path")) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of names)
    fs.writeFileSync(path.join(dir, name), "#!/bin/sh\n", { mode: 0o755 });
  return dir;
}

test("resolveOpenSshBinaries skips every session wrapper and returns what it finds", () => {
  const agents = path.join(tempFolder("data"), "ssh", "agents");
  const ownBin = fakeBinaries(["ssh", "scp", "sftp"], path.join(agents, "s1", "bin"));
  const otherBin = fakeBinaries(["ssh"], path.join(agents, "s2", "bin"));
  const linkedDir = path.join(tempFolder("link"), "bin");
  fs.symlinkSync(ownBin, linkedDir);
  const linkedFile = tempFolder("file link");
  fs.symlinkSync(path.join(otherBin, "ssh"), path.join(linkedFile, "ssh"));
  const partial = fakeBinaries(["ssh", "sftp"]);
  const later = fakeBinaries(["scp", "sftp"]);
  const noExec = fakeBinaries([]);
  fs.writeFileSync(path.join(noExec, "ssh"), "", { mode: 0o644 });
  fs.mkdirSync(path.join(noExec, "scp"));
  const pathEnv = [
    "",
    ".",
    "relative/bin",
    linkedDir,
    ownBin,
    otherBin,
    linkedFile,
    noExec,
    later,
    partial,
  ].join(":");
  assert.deepEqual(resolveOpenSshBinaries(pathEnv, [agents]), {
    ssh: path.join(partial, "ssh"),
    scp: path.join(later, "scp"),
    sftp: path.join(partial, "sftp"),
  });
  assert.deepEqual(resolveOpenSshBinaries(partial), {
    ssh: path.join(partial, "ssh"),
    sftp: path.join(partial, "sftp"),
  });
  assert.equal(resolveOpenSshBinaries(later), null);
  assert.equal(
    resolveOpenSshBinaries([ownBin, linkedDir, linkedFile].join(":"), [agents]),
    null,
  );
  assert.equal(resolveOpenSshBinaries(""), null);
  assert.equal(resolveOpenSshBinaries(undefined), null);
});
