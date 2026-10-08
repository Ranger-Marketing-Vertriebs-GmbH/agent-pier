// Fake CLI: records env and argv, optionally calls the adapter, then exits.
// Modes: call (default), wait, call-wait, wait-sigint. Waiting modes exit 7 on SIGUSR2
// (a CLI ending on its own while the adapter keeps running). FAKE_CLI_IGNORE_HUP=1 ignores
// SIGHUP, so the launcher stops the adapter only after its 1 s SIGKILL grace.
import fs from "node:fs";
const [out, mode = "call"] = process.argv.slice(2);
const record = {
  pid: process.pid,
  env: process.env,
  args: process.argv.slice(2),
  calls: [],
};
const base = process.env.ANTHROPIC_BASE_URL;
const token = process.env.ANTHROPIC_AUTH_TOKEN;
async function call() {
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: process.env.FAKE_CLI_BODY,
  });
  record.calls.push({ status: res.status, text: await res.text() });
}
if (process.env.FAKE_CLI_IGNORE_HUP === "1") process.on("SIGHUP", () => {});
const save = () => fs.writeFileSync(out, JSON.stringify(record));
const ready = () => {
  setInterval(() => {}, 1000);
  process.on("SIGUSR2", () => process.exit(7));
  save(); // tests read the substituted URL from here
  fs.writeFileSync(`${out}.ready`, "");
};
if (mode === "call" || mode === "call-wait") await call();
if (mode === "wait-sigint") {
  process.on("SIGINT", async () => {
    await call();
    save();
    process.exit(0);
  });
  ready();
} else if (mode === "wait" || mode === "call-wait") {
  if (mode === "call-wait") console.log("FAKE-CLI-STDOUT");
  ready();
} else {
  save();
  console.log("FAKE-CLI-STDOUT");
  process.exit(Number(process.env.FAKE_CLI_EXIT || 0));
}
