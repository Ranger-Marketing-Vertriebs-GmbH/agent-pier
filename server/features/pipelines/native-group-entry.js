import { runOwnedCommand } from "./native-owned-executor.js";
process.once("message", (payload) => runOwnedCommand(payload));
