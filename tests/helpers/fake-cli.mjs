// Fake CLI: records env and argv, optionally calls the adapter, then exits.
import fs from "node:fs";
const [out, mode = "call"] = process.argv.slice(2);
const record = { env: process.env, args: process.argv.slice(2), calls: [] };
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
const save = () => fs.writeFileSync(out, JSON.stringify(record));
if (mode === "call") await call();
if (mode === "wait-sigint") {
  process.on("SIGINT", async () => {
    await call();
    save();
    process.exit(0);
  });
  setInterval(() => {}, 1000);
  save();
  fs.writeFileSync(`${out}.ready`, "");
} else if (mode === "wait") {
  setInterval(() => {}, 1000);
  save(); // tests read the substituted URL from here
  fs.writeFileSync(`${out}.ready`, "");
} else {
  save();
  console.log("FAKE-CLI-STDOUT");
  process.exit(Number(process.env.FAKE_CLI_EXIT || 0));
}
