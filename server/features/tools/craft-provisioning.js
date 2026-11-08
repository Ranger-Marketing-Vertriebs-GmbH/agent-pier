import fs from "node:fs";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { craftHome } from "./craft-config.js";

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function readSettings(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    return isObject(saved) ? saved : {};
  } catch {
    return {};
  }
}

/**
 * Installer step for `--with-craft-anything` (setup.sh, release-install.mjs): leaves
 * the request that CraftTool.start() applies at the next server start. Nothing is
 * downloaded here; the server installs the pinned release, and Ghidra with it unless
 * `ghidra` is false. An installed Craft Anything (its server row is recorded in the
 * settings file) and an existing request are left alone. A link in place of
 * <data>/craft-anything is refused, so nothing lands elsewhere.
 */
export async function provisionCraftAnything({ dataDir, enable = false, ghidra = true }) {
  const directory = craftHome(dataDir);
  const file = path.join(directory, "settings.json");
  const saved = readSettings(file);
  const installed = typeof saved.serverId === "string" && saved.serverId !== "";
  const pending = isObject(saved.requested);
  if (!enable || installed) return { requested: pending, installed };
  if (pending) return { requested: true, installed };
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory())
      throw Error(serverMessages.tools.installationDirectoryInvalid);
    const body = {
      ...saved,
      requested: {
        components: { ghidra: ghidra === true },
        settings: { mode: "clean-room" },
      },
    };
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    return { requested: true, installed: false };
  } catch (error) {
    return { requested: false, installed: false, message: error.message };
  }
}
