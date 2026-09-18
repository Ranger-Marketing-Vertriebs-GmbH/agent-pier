import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ArtifactService } from "../../server/features/artifacts/artifact-service.js";
export async function artifactFixture(t, limits) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-artifact-")),
  );
  const workspace = path.join(root, "workspace"),
    dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  const sessions = new Set(["session-one", "session-two"]);
  const options = { dataDir, limits, sessionExists: (id) => sessions.has(id), pollMs: 0 };
  let service = new ArtifactService(options);
  await service.ready;
  t.after(async () => {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    workspace,
    dataDir,
    sessions,
    context: { sessionId: "session-one", projectId: "project-one", cwd: workspace },
    get service() {
      return service;
    },
    async restart() {
      await service.close();
      service = new ArtifactService(options);
      await service.ready;
    },
  };
}
