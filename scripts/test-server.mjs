import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApplication } from "../server/app.js";

// Browser tests get a disposable app; they never share the user's workspace data.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-browser-server-"));
const home = path.join(directory, "home");
await fs.mkdir(home, { mode: 0o700 });
const port = Number(process.env.AGENTPIER_TEST_PORT || 4389);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid browser test port");
const application = await createApplication({
  dataDir: path.join(directory, "data"),
  home,
  port,
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await application.close();
  await fs.rm(directory, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => stop().then(() => process.exit(0)));
application.server.listen(port, "127.0.0.1", () =>
  console.log(`Isolated test server: http://127.0.0.1:${port}`),
);
