import path from "node:path";
import { fileProblem } from "./file-errors.js";
import {
  ownedHandle,
  inodeIdentity,
  inspect,
  openParent,
  parentMatches,
} from "./file-stage.js";
import { treeConflict } from "./file-tree.js";

function assertPrivate(stat) {
  if (
    stat.type !== "directory" ||
    Number(stat.uid) !== process.getuid() ||
    Number(stat.mode) & 0o077
  )
    throw fileProblem("FILE_ACCESS_DENIED", 403);
}
async function childDirectory(native, parent, name) {
  const existing = await inspect(native, parent.handle, name);
  const opened = ownedHandle(
    native,
    await native.run(
      existing ? "openLookup" : "createDirectory",
      existing
        ? { directory: parent.handle, path: name }
        : { directory: parent.handle, name },
    ),
  );
  try {
    const stat = await opened.stat();
    assertPrivate(stat);
    if (existing && inodeIdentity(stat) !== inodeIdentity(existing)) throw treeConflict();
    return opened;
  } catch (error) {
    await opened.close();
    throw error;
  }
}
export async function privateTrashStage(store, native, record, save) {
  const storage = ownedHandle(
    native,
    await native.run("openRoot", { path: store.storageRoot }),
  );
  let root, parent;
  try {
    assertPrivate(await storage.stat());
    root = await childDirectory(native, storage, "trash");
    const rootIdentity = inodeIdentity(await root.stat());
    if (record.trashRootIdentity && record.trashRootIdentity !== rootIdentity)
      throw treeConflict();
    record.trashRootIdentity = rootIdentity;
    await save(record);
    const existing = await inspect(native, root.handle, record.id);
    if (existing && inodeIdentity(existing) !== record.centralLocation?.parentIdentity)
      throw treeConflict();
    parent = await childDirectory(native, root, record.id);
    record.location = {
      file: path.join(store.storageRoot, "trash", record.id, "payload"),
      parentIdentity: inodeIdentity(await parent.stat()),
      identity: null,
    };
    record.centralLocation = { ...record.location };
    await save(record);
    await parent.sync();
    await root.sync();
    await storage.sync();
    const stage = {
      id: record.id,
      jobId: record.jobId,
      name: "payload",
      file: record.location.file,
      type: record.type,
      parentHandle: parent,
      targetParentHandle: root,
      handle: null,
      async populate() {
        if (record.type === "symlink") return;
        stage.handle = ownedHandle(
          native,
          await native.run(record.type === "file" ? "createFile" : "createDirectory", {
            directory: parent.handle,
            name: "payload",
          }),
        );
        record.location.identity = inodeIdentity(await stage.handle.stat());
        await save(record);
      },
      async createLink(text) {
        if (record.type !== "symlink" || record.location.identity) throw treeConflict();
        const stat = await native.run("createLink", {
          directory: parent.handle,
          name: "payload",
          text,
        });
        record.location.identity = inodeIdentity(stat);
        await save(record);
        await parent.sync();
      },
      async close() {
        const results = await Promise.allSettled(
          [stage.handle, parent, root].filter(Boolean).map((handle) => handle.close()),
        );
        const failed = results.find((result) => result.status === "rejected");
        if (failed) throw failed.reason;
      },
    };
    return stage;
  } catch (error) {
    await parent?.close();
    await root?.close();
    throw error;
  } finally {
    await storage.close();
  }
}
export async function openTrashPayload(native, record) {
  if (!record.location?.identity) throw treeConflict();
  const { file, parentIdentity, identity } = record.location;
  const parent = await openParent(native, file);
  try {
    if (
      inodeIdentity(await parent.stat()) !== parentIdentity ||
      inodeIdentity(await inspect(native, parent.handle, path.basename(file))) !==
        identity
    )
      throw treeConflict();
    return {
      parent,
      name: path.basename(file),
      assertAuthority: async () => {
        if (!(await parentMatches(native, file, parentIdentity))) throw treeConflict();
      },
    };
  } catch (error) {
    await parent.close();
    throw error;
  }
}

const adoptionSources = new WeakMap();
export async function trashAdoptionSource(store, native, record) {
  const saved = store.getTrash(record.id);
  if (
    !saved ||
    saved.phase !== "restore_pending" ||
    JSON.stringify(saved.location) !== JSON.stringify(record.location)
  )
    throw treeConflict();
  const opened = await openTrashPayload(native, saved);
  const source = Object.freeze({
    parentHandle: opened.parent,
    name: opened.name,
    identity: saved.location.identity,
    type: saved.type,
  });
  adoptionSources.set(source, async () => {
    await opened.assertAuthority();
    const current = store.getTrash(record.id);
    if (
      !current ||
      current.phase !== "restore_pending" ||
      JSON.stringify(current.location) !== JSON.stringify(saved.location)
    )
      throw treeConflict();
  });
  return source;
}
export async function assertAdoptionSource(source, native) {
  const assertAuthority = adoptionSources.get(source);
  if (!assertAuthority || source.parentHandle.native !== native) throw treeConflict();
  await assertAuthority();
}
