import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { logCraftFailure } from "./craft-log.js";
import {
  createProjectFolder,
  initRepository,
  projectFolderName,
} from "../projects/project-folder.js";
import { cleanStart } from "./rebuild-input.js";
import { initialFields } from "./rebuild-view.js";

// Starting a rebuild for CraftRebuilds (`r`): its folder, its record, rebuild_start
// and the folder's Git project.

const ignored = ["capture/", "checks/", "inbox/", "investigation.cany/"];
const START_TIMEOUT_MS = 60000;

/**
 * Creates the folder and the record, has Craft Anything start, then makes the folder
 * a Git project. Only the folder and project changes hold a mutation lease
 * (`barrier`, MutationBarrier#run): snapshots (backups) must see them whole. Spawning
 * a child and the rebuild_start round-trip may take up to about 90 s and change only
 * the folder's contents and the rebuild records, which the sampler writes without a
 * lease anyway, so a snapshot never waits for them.
 */
export async function beginRebuild(r, input, source, requestId) {
  const { pictures: ids, ...options } = cleanStart(input, source, r.settings());
  r.requireEligible(options.accountId);
  // Craft Anything copies them into the project's reference/ before it answers.
  const pictures = r.pictures.take(ids);
  try {
    return await startRebuild(r, options, source, requestId, pictures);
  } finally {
    r.pictures.discard(pictures);
  }
}

async function startRebuild(r, options, source, requestId, pictures) {
  const { made, record } = await r.barrier.run(async () => {
    const folder = await createProjectFolder({
      preferences: r.preferences,
      memory: r.memory,
      name: projectFolderName(options.request),
      git: false,
      unique: true,
      label: "Rebuild folder",
    });
    const stamp = r.now().toISOString();
    const created = {
      id: randomUUID(),
      projectId: folder.project.id,
      folder: folder.path,
      name: path.basename(folder.path),
      ...options,
      source,
      requestId,
      createdAt: stamp,
      updatedAt: stamp,
      craftProject: null,
      ...initialFields(),
    };
    r.records.set(created.id, created);
    r.persist();
    return { made: folder, record: created };
  });
  r.emit({ list: true });
  try {
    const started = await r.call(
      record,
      "rebuild_start",
      {
        request: record.request,
        target: record.target,
        build_with: record.stack,
        ...(record.rounds && { rounds: record.rounds }),
        ...(pictures.length && { pictures }),
        project_folder: record.folder,
      },
      { timeoutMs: START_TIMEOUT_MS, project: false },
    );
    if (typeof started?.project !== "string" || !started.project)
      throw new Error("rebuild_start named no project.");
    record.craftProject = started.project;
  } catch (error) {
    // A timeout or a malformed answer may still have started a build.
    await stopUnanswered(r, record);
    r.pauseAfterStart.delete(record.id);
    await r.barrier.run(async () => {
      r.records.delete(record.id);
      r.persist();
      await made.rollback();
    });
    r.emit({ list: true });
    throw r.failure(error);
  }
  await r.barrier.run(async () => {
    const project = await prepareFolder(r, made);
    if (project?.id) record.projectId = project.id;
    r.persist();
  });
  if (r.pauseAfterStart.delete(record.id))
    await r.serial(record.id, () => r.stop(record));
  else await r.serial(record.id, () => r.launched(record));
  return r.get(record.id);
}

/**
 * rebuild_start failed (timed out, answered without a project): Craft Anything may
 * still build in the folder that is about to go. Its project, when craft.json already names it, is stopped (best
 * effort).
 */
async function stopUnanswered(r, record) {
  try {
    const saved = JSON.parse(
      await fs.readFile(path.join(record.folder, "craft.json"), "utf8"),
    );
    if (typeof saved?.project !== "string" || !saved.project) return;
    await r.call({ ...record, craftProject: saved.project }, "rebuild_stop", {});
  } catch {
    // Nothing recorded yet, or the child is gone: nothing left to stop here.
  }
}

/**
 * Keeps Craft Anything's records out of Git and makes the folder a repository. The
 * folder is registered again then, which moves its project to the Git identity at
 * once (ProjectMemory#register): that project, or null when this failed.
 */
async function prepareFolder(r, made) {
  try {
    await fs.writeFile(path.join(made.path, ".gitignore"), `${ignored.join("\n")}\n`, {
      flag: "wx",
    });
    await initRepository(made.path);
    return await r.memory.register(made.path);
  } catch (error) {
    logCraftFailure("prepare a rebuild's project folder", error);
    return null;
  } finally {
    await made.release();
  }
}
