import { serverMessages } from "./lib/i18n/de.js";
import { loadConfig } from "./lib/config.js";
import { createApplication } from "./app.js";
process.umask(0o077);
const config = loadConfig();
if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535)
  throw new Error(serverMessages.scripts.invalidServerPort);
const application = await createApplication(config);
const bind = config.network.enabled ? config.network.bind : "127.0.0.1";
application.server.listen(config.port, bind, () => {
  console.log(serverMessages.scripts.serverListening(config.port));
  if (config.network.enabled)
    console.log(
      serverMessages.scripts.serverListeningNetwork(application.networkState.urls),
    );
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const timer = setTimeout(() => process.exit(1), 6000);
  timer.unref();
  await application.close();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
