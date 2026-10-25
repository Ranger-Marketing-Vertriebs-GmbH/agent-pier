#!/usr/bin/env node
// A console-only network device for tests of interactive shell mode: it stands in
// for `ssh -tt` (prompt, echo, pager, ANSI colours, backspace redraws) and refuses
// a remote command like such devices do. Flags:
//   --exec CMD       behave like `ssh host CMD`: close with exit 255
//   --fail           an SSH error before any prompt (exit 255)
//   --quiet-login    print the banner but a prompt the heuristics do not know
//   --login-pager    ask "Press any key to continue" before the first prompt
//   --no-logout      ignore exit (the runner must hang up itself)
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const write = (text) => process.stdout.write(text);

if (flag("--exec")) {
  process.stderr.write("Connection closed by remote host\r\n", () => process.exit(255));
}
if (flag("--fail")) {
  process.stderr.write("admin@switch: Permission denied (publickey).\r\n", () =>
    process.exit(255),
  );
}

let mode = "user";
let input = "";
let paging = null;
let waitingForKey = flag("--login-pager");
const prompt = () =>
  write(flag("--quiet-login") ? "login ok:" : mode === "user" ? "Switch>" : "Switch#");

function page() {
  const lines = paging.splice(0, 20);
  write(lines.map((line) => `${line}\r\n`).join(""));
  if (paging.length) write("--More--");
  else {
    paging = null;
    prompt();
  }
}
function run(line) {
  // A pseudo-terminal echoes what is typed.
  write(`${line}\r\n`);
  const command = line.trim();
  if (command === "enable") mode = "enable";
  else if (command === "show version")
    write("\x1b[1mFakeSwitch\x1b[0m OS 1.0\r\nUptime: 3 days\x1b[K\r\n");
  else if (command === "show long") {
    paging = Array.from({ length: 45 }, (_, i) => `port ${i + 1} up`);
    return page();
  } else if (command === "redraw") write("loading...\rdone      \r\nab\bc\r\n");
  else if (command === "hang") return;
  else if (command === "flood") write("x".repeat(80000));
  else if (command === "exit") {
    if (mode === "enable" || flag("--no-logout")) mode = "user";
    else {
      process.stdout.write("Connection closed.\r\n", () => process.exit(0));
      return;
    }
  } else if (command) write(`% Unknown command "${command}"\r\n`);
  prompt();
}

function start() {
  process.stdin.on("data", (chunk) => {
    for (const character of chunk.toString("utf8")) {
      if (waitingForKey) {
        waitingForKey = false;
        write("\r\n");
        prompt();
      } else if (paging) {
        if (character !== " ") continue;
        // Devices erase the pager prompt with backspaces before the next page.
        write("\b".repeat(8) + " ".repeat(8) + "\b".repeat(8));
        page();
      } else if (character === "\n") {
        run(input);
        input = "";
      } else input += character;
    }
  });
  process.stdin.on("end", () => process.exit(0));

  setTimeout(() => {
    write("\r\nWelcome to \x1b[32mFakeSwitch\x1b[0m\r\n\r\n");
    if (waitingForKey) write("Press any key to continue");
    else prompt();
  }, 50);
}
if (!flag("--exec") && !flag("--fail")) start();
