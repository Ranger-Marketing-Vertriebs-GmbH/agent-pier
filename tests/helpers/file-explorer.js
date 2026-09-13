import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeFileScope } from "../../server/features/files/file-scope.js";

export async function fileFixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-files-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    project = path.join(home, "project"),
    dataDir = path.join(root, "data");
  await fs.mkdir(home, { mode: 0o700 });
  await fs.mkdir(project, { mode: 0o700 });
  await fs.mkdir(dataDir, { mode: 0o700 });
  return {
    root,
    home,
    project,
    dataDir,
    globalScope: await makeFileScope({ home }),
    projectScope: await makeFileScope({ home, session: { id: "fixture", cwd: project } }),
  };
}
