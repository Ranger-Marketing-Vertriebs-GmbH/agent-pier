import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  commandLines,
  runInteractiveSsh,
} from "../../server/features/ssh/ssh-interactive-run.js";
import {
  consoleText,
  consoleTrace,
  consoleTraceLimit,
  lastLine,
  pagerPattern,
  promptPattern,
  withoutEcho,
} from "../../server/features/ssh/ssh-console-text.js";
import { runSshCommand, sshOutputLimit } from "../../server/features/ssh/ssh-run.js";

const device = fileURLToPath(
  new URL("../fixtures/fake-network-device.mjs", import.meta.url),
);
// The fake device stands in for `ssh -tt`: the runner only sees a process with pipes.
const connection = (...flags) => ({
  command: process.execPath,
  args: [device, ...flags],
  interactive: true,
});
const fast = { idleMs: 400, settleMs: 60 };
const run = (command, { flags = [], ...options } = {}) =>
  runInteractiveSsh(connection(...flags), command, {
    timeoutMs: 10000,
    timing: fast,
    ...options,
  });

test("console text drops escape sequences, redraws, backspaces and pager prompts", () => {
  assert.equal(consoleText("\x1b[1mbold\x1b[0m \x1b]0;title\x07x\x1b(B"), "bold x");
  assert.equal(consoleText("a\r\nb\r\r\nc\n"), "a\nb\nc\n");
  assert.equal(consoleText("loading...\rdone      "), "done");
  assert.equal(consoleText("ab\bc"), "ac");
  // CR returns to the start and overwrites, as a terminal shows it.
  assert.equal(consoleText("% Error in line\rOK"), "OKError in line");
  assert.equal(
    consoleText("--More--\b\b\b\b\b\b\b\b        \b\b\b\b\b\b\b\bport 21"),
    "port 21",
  );
  for (const pager of [
    " --More-- ",
    "-- More --",
    "<--- More --->",
    "Press any key to go on",
  ])
    assert.equal(consoleText(`x\n${pager}`), "x\n");
  assert.equal(consoleText("bell\x07 null\x00"), "bell null");
  assert.equal(lastLine("one\r\n\x1b[32mSwitch#\x1b[0m "), "Switch# ");
});

test("prompts and pagers are recognised by the end of the last line", () => {
  for (const prompt of [
    "Switch>",
    "core#",
    "user@host:~$ ",
    "[admin@MikroTik] > ",
    "[x]",
  ])
    assert.ok(promptPattern.test(prompt), prompt);
  for (const line of [
    "Password:",
    "Uptime 3 days",
    "Switch#  ",
    "",
    "[OK]",
    "Proceed with reload? [confirm]",
    "Destination filename [startup-config]? ",
  ])
    assert.ok(!promptPattern.test(line), line);
  for (const pager of ["--More--", " -- More -- ", "<--- More --->", "Press SPACE"])
    assert.ok(pagerPattern.test(pager), pager);
  // Text that merely mentions "more" is output, not a pager.
  for (const line of [
    "more.example.test>",
    "Press any key",
    "show more-details",
    "--more-output",
  ])
    assert.equal(pagerPattern.test(line) && !/^Press/.test(line), false, line);
  assert.equal(
    consoleText("host more.example.test\n--more-output enabled\n-- More --port 2"),
    "host more.example.test\n--more-output enabled\nport 2",
  );
});

test("only the echo of the sent line is dropped", () => {
  assert.equal(withoutEcho("show version\nOS 1.0\n", "show version"), "OS 1.0\n");
  assert.equal(withoutEcho("\nSwitch#show version\nOS\n", "show version"), "\nOS\n");
  // A device that does not echo (a password) keeps its first line.
  assert.equal(withoutEcho("Password OK\n", "secret"), "Password OK\n");
  assert.equal(withoutEcho("x\n", ""), "x\n");
  assert.deepEqual(commandLines("enable\r\nshow version\n\n"), [
    "enable",
    "show version",
  ]);
  assert.deepEqual(commandLines(""), []);
});

test("a multi-line command is typed line by line after each prompt", async () => {
  const result = await run("enable\nshow version");
  assert.equal(result.interactive, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.started, true);
  assert.equal(
    result.stdout,
    "Welcome to FakeSwitch\n\nSwitch>\nSwitch#\nFakeSwitch OS 1.0\nUptime: 3 days\nSwitch#\nSwitch>\n",
  );
  // No echo, no escape sequences, no carriage returns.
  assert.ok(!/show version|enable|\x1b|\r/.test(result.stdout));
});

test("a recognised prompt continues without waiting for the idle time", async () => {
  const started = Date.now();
  const result = await run("enable\nshow version\nexit", {
    timing: { idleMs: 5000, settleMs: 60 },
  });
  assert.match(result.stdout, /Uptime: 3 days/);
  assert.ok(Date.now() - started < 4000, "prompts, not the idle time, paced the run");
});

test("an unknown prompt falls back to the idle time", async () => {
  const result = await run("show version", { flags: ["--quiet-login"] });
  assert.equal(result.started, true);
  assert.match(result.stdout, /^Welcome to FakeSwitch\n\nlogin ok:\nFakeSwitch OS 1.0/);
});

test("pagers are answered with a space and leave no prompt behind", async () => {
  const result = await run("show long", { flags: ["--login-pager"] });
  const ports = result.stdout.split("\n").filter((line) => /^port \d+ up$/.test(line));
  assert.equal(ports.length, 45);
  assert.ok(!/More|Press any key|\x08/.test(result.stdout));
  assert.match(result.stdout, /port 45 up\nSwitch>/);
});

test("redraws and backspaces show what a terminal would", async () => {
  const result = await run("redraw");
  assert.match(result.stdout, /Switch>\ndone\nac\nSwitch>/);
});

test("a device that ignores exit is hung up on", async () => {
  const result = await run("show version", { flags: ["--no-logout"] });
  assert.equal(result.signal, null);
  assert.equal(result.exitCode, null);
  assert.match(result.stdout, /Uptime: 3 days/);
});

test("the timeout stops a command that never returns", async () => {
  const result = await run("hang", {
    timeoutMs: 600,
    timing: { idleMs: 5000, settleMs: 60 },
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.exitCode, null);
});

test("output beyond the limit is cut and stops the session", async () => {
  const result = await run("flood");
  assert.equal(result.truncated, true);
  assert.ok(
    Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= sshOutputLimit,
  );
});

test("a revoked access stops the session", async () => {
  const result = await run("hang", {
    timing: { idleMs: 5000, settleMs: 60 },
    intervalMs: 20,
    stillAuthorized: () => false,
  });
  assert.equal(result.revoked, true);
});

test("a connection that fails before a prompt keeps its status and sends nothing", async () => {
  const result = await run("show version", { flags: ["--fail"] });
  assert.equal(result.started, false);
  assert.equal(result.exitCode, 255);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Permission denied/);
  assert.match(result.stderr, /no command was sent/);
});

test("runSshCommand hands interactive connections to the console runner", async () => {
  const result = await runSshCommand(connection(), "show version", {
    timeoutMs: 10000,
    timing: fast,
  });
  assert.equal(result.interactive, true);
  assert.match(result.stdout, /FakeSwitch OS 1.0/);
  // Without the mode the same device refuses the remote command like a real switch.
  const refused = await runSshCommand(
    { command: process.execPath, args: [device, "--exec"] },
    "show version",
    { timeoutMs: 10000 },
  );
  assert.equal(refused.exitCode, 255);
  assert.equal(refused.interactive, undefined);
  assert.match(refused.stderr, /Connection closed by remote host/);
});

test("exit is typed only at a prompt, never as the answer to a question", async () => {
  for (const command of ["reload", "copy"]) {
    const result = await run(command);
    assert.equal(result.signal, null, command);
    assert.ok(!/answered/.test(result.stdout), command);
    assert.match(result.stdout, /\[confirm\]|\[startup-config\]\?/, command);
  }
});

test("a status line in brackets is not taken for a prompt", async () => {
  const result = await run("status\nshow version", {
    timing: { idleMs: 1000, settleMs: 60 },
  });
  assert.match(result.stdout, /\[OK\]\nSwitch>\nFakeSwitch OS 1.0/);
});

// A raw-mode CLI like a TP-Link JetStream switch: only CR is Enter, a lone CR echo.
test("a CR-only console runs show commands and enable after Enter as CR", async () => {
  const shown = await run("show system-info", { flags: ["--cr-only"] });
  assert.equal(
    shown.stdout,
    "Welcome to FakeSwitch\n\nCore-Switch>\n" +
      " System Description - JetStream 48-Port Gigabit L2+ Managed Switch\n" +
      " Device Name        - Core-Switch\n\nCore-Switch>\nConnection closed.\n",
  );
  assert.equal(shown.signal, null);
  assert.equal(shown.consoleTrace, undefined);
  const enabled = await run("enable\nshow system-info\nexit", { flags: ["--cr-only"] });
  assert.match(
    enabled.stdout,
    /^Welcome to FakeSwitch\n\nCore-Switch>\nCore-Switch#\n System Description - JetStream.*\n Device Name {8}- Core-Switch\n\nCore-Switch#\nCore-Switch>\nConnection closed\.\n$/,
  );
  assert.ok(!/show system-info|enable|\r/.test(enabled.stdout));
});

test("the prompt redrawn after a lone CR paces the run, not the idle time", async () => {
  const started = Date.now();
  const result = await run("enable\nshow system-info", {
    flags: ["--cr-only"],
    timing: { idleMs: 5000, settleMs: 60 },
  });
  assert.match(result.stdout, /Core-Switch#\n System Description/);
  assert.ok(Date.now() - started < 4000, "prompts, not the idle time, paced the run");
});

test("a run that shows only prompts carries the escaped raw console", async () => {
  const result = await run("enable", { flags: ["--cr-only"] });
  assert.equal(
    result.stdout,
    "Welcome to FakeSwitch\n\nCore-Switch>\nCore-Switch#\nCore-Switch>\n",
  );
  assert.equal(
    result.consoleTrace,
    "\\r\\n\nWelcome to \\x1b[32mFakeSwitch\\x1b[0m\\r\\n\n\\r\\n\nCore-Switch>\n" +
      '[typed "enable\\r"]\nenable\\rCore-Switch#\n' +
      '[typed "exit\\r"]\nexit\\r\\n\nCore-Switch>',
  );
  // Output other than prompts needs no trace; neither does the sign-in test ("").
  assert.equal((await run("enable\nshow version")).consoleTrace, undefined);
  assert.equal((await run("")).consoleTrace, undefined);
});

test("a console trace is bounded and cut at character boundaries", () => {
  const trace = consoleTrace(["€".repeat(3000), "ä\x1b".repeat(2000)], () => "x", "\r");
  assert.ok(Buffer.byteLength(trace) <= consoleTraceLimit);
  assert.ok(!trace.includes("\uFFFD"));
  assert.match(trace, /^€+\n\[… trace shortened …\]\n(?:ä\\x1b)+$/);
  assert.equal(
    consoleTrace(["a\\b\t\b\x00\x7f"], () => "", "\r"),
    "a\\\\b\\t\\b\\x00\\x7f",
  );
});
