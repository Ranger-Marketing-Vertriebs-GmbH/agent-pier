import fs from "node:fs";
import { runOwnedCommand } from "./native-owned-executor.js";
const request = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const config = request.steps[Number(process.argv[3])];
runOwnedCommand({
  command: "/bin/sh",
  args: ["-c", config.command],
  cwd: request.cwd,
  env: process.env,
});
