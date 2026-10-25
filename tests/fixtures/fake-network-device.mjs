#!/usr/bin/env node
// A console-only network device for tests of interactive shell mode: it stands in
// for `ssh -tt` (prompt, echo, pager, ANSI colours, backspace redraws) and refuses
// a remote command like such devices do. Flags:
//   --exec CMD       behave like `ssh host CMD`: close with exit 255
//   --fail           an SSH error before any prompt (exit 255)
//   --quiet-login    print the banner but a prompt the heuristics do not know
//   --login-pager    ask "Press any key to continue" before the first prompt
//   --no-logout      ignore exit (the runner must hang up itself)
//   --cr-only        a raw-mode CLI like a TP-Link JetStream switch: only CR is Enter
//                    (LF is ignored), typed characters are echoed as they arrive,
//                    Enter is echoed as a lone CR and a command without output
//                    redraws the prompt on the same line ("Core-Switch>")
// Without --cr-only the device reads lines like a Unix pseudo-terminal (ICRNL):
// CR, LF and CRLF each end one line.
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const write = (text) => process.stdout.write(text);
const crOnly = flag("--cr-only");
const host = crOnly ? "Core-Switch" : "Switch";

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
let question = false;
let waitingForKey = flag("--login-pager");
let lastWasCr = false;
const prompt = () =>
  write(flag("--quiet-login") ? "login ok:" : `${host}${mode === "user" ? ">" : "#"}`);

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
  const command = line.trim();
  if (crOnly) {
    // The characters were echoed as typed; Enter is echoed as a lone CR.
    write("\r");
    if (command === "enable" || !command) {
      if (command) mode = "enable";
      return prompt();
    }
    write("\n");
  }
  // A pseudo-terminal echoes what is typed.
  else write(`${line}\r\n`);
  if (question) {
    question = false;
    write(`answered: ${command}\r\n`);
  } else if (command === "reload") {
    question = true;
    return write("Proceed with reload? [confirm]");
  } else if (command === "copy") {
    question = true;
    return write("Destination filename [startup-config]? ");
  } else if (command === "status") {
    // A status line that looks like a "]" prompt, then a pause before the prompt.
    write("Saving configuration\r\n[OK]");
    return setTimeout(() => {
      write("\r\n");
      prompt();
    }, 300);
  } else if (command === "enable") mode = "enable";
  else if (command === "show version")
    write("\x1b[1mFakeSwitch\x1b[0m OS 1.0\r\nUptime: 3 days\x1b[K\r\n");
  else if (command === "show system-info")
    write(
      " System Description - JetStream 48-Port Gigabit L2+ Managed Switch\r\n" +
        " Device Name        - Core-Switch\r\n\r\n",
    );
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
      } else if (crOnly ? character === "\r" : character === "\r" || character === "\n") {
        // A Unix pseudo-terminal reads CR, LF or CRLF as one line end.
        if (character === "\n" && lastWasCr) lastWasCr = false;
        else {
          lastWasCr = character === "\r";
          run(input);
          input = "";
        }
      } else if (crOnly && character === "\n") continue;
      else {
        lastWasCr = false;
        input += character;
        if (crOnly) write(character);
      }
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
