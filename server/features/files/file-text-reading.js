import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import {
  resolveFile,
  entryRevision,
  assertFileMutationTarget,
  isWithin,
} from "./file-paths.js";
import {
  openParent,
  ownedHandle,
  closeHandles,
  inodeIdentity,
  publicationSnapshot,
} from "./file-stage.js";
import { readMetadata } from "./file-metadata.js";
import { fileProblem, fileSystemProblem } from "./file-errors.js";

export const textConflict = () => fileProblem("FILE_CONFLICT_CHANGED", 409);
export const publicResolvedPath = (scope, absolute) =>
  scope.kind === "project" ? path.relative(scope.root, absolute) : absolute;

export function decodeText(bytes) {
  const bom =
    bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191;
  let text;
  try {
    // Strip exactly one recognized BOM; a second FEFF is literal text.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bom ? bytes.subarray(3) : bytes,
    );
  } catch {
    throw fileProblem("FILE_UNSUPPORTED_TYPE", 415);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))
    throw fileProblem("FILE_UNSUPPORTED_TYPE", 415);
  const crlf = text.includes("\r\n"),
    rest = text.replaceAll("\r\n", "");
  const lineEnding =
    rest.includes("\r") || (crlf && rest.includes("\n")) ? "mixed" : crlf ? "crlf" : "lf";
  return { text, encoding: "utf-8", bom, lineEnding };
}

export async function openText(publisher, scope, input) {
  let parent, handle;
  try {
    const selected = await resolveFile(scope, input, { followLeaf: true });
    if (!selected.stat.isFile()) throw fileProblem("FILE_UNSUPPORTED_TYPE", 415);
    parent = await openParent(publisher.native, selected.absolute);
    handle = ownedHandle(
      publisher.native,
      await publisher.native.run("openFile", {
        directory: parent.handle,
        path: path.basename(selected.absolute),
      }),
    );
    const revalidate = async () => {
      const stat = await handle.stat();
      const current = await resolveFile(scope, input, { followLeaf: true });
      if (
        current.absolute !== selected.absolute ||
        current.linkIdentity !== selected.linkIdentity ||
        inodeIdentity(stat) !== inodeIdentity(selected.stat) ||
        entryRevision(stat) !== entryRevision(current.stat)
      )
        throw textConflict();
      return {
        current,
        stat,
        metadataRevision: entryRevision(stat, current.linkIdentity),
      };
    };
    await revalidate();
    return {
      selected,
      parent,
      handle,
      revalidate,
      close: () => closeHandles(handle, parent),
    };
  } catch (error) {
    await closeHandles(handle, parent);
    throw fileSystemProblem(error);
  }
}

export async function writableText(publisher, scope, opened, { metadata = true } = {}) {
  const { current, stat } = await opened.revalidate();
  assertFileMutationTarget(scope, current);
  if (
    publisher.store.storageRoot &&
    isWithin(current.absolute, publisher.store.storageRoot)
  )
    throw fileProblem("FILE_PROTECTED_PATH", 403);
  if (stat.nlink > 1n) throw fileProblem("FILE_READ_ONLY", 403);
  try {
    await fs.access(current.absolute, constants.W_OK);
    await fs.access(path.dirname(current.absolute), constants.W_OK | constants.X_OK);
  } catch (error) {
    throw fileSystemProblem(error);
  }
  if (metadata && (await readMetadata(opened.handle)).completeness?.complete !== true)
    throw fileProblem("FILE_METADATA_UNSUPPORTED", 409);
  await opened.revalidate();
}

export async function readTextDocument(publisher, scope, input, limits) {
  const opened = await openText(publisher, scope, input);
  try {
    const chunks = [];
    const observation = await publicationSnapshot(
      opened.handle,
      opened.selected.linkIdentity,
      {
        maxBytes: limits.textBytes,
        onChunk: (chunk) => chunks.push(Buffer.from(chunk)),
      },
    );
    let readOnly = false;
    try {
      await writableText(publisher, scope, opened);
    } catch (error) {
      if (
        ["FILE_CONFLICT_CHANGED", "FILE_PATH_CHANGED", "FILE_NOT_FOUND"].includes(
          error.code,
        )
      )
        throw error;
      readOnly = true;
    }
    const final = await opened.revalidate();
    if (final.metadataRevision !== observation.metadataRevision) throw textConflict();
    return {
      ...decodeText(Buffer.concat(chunks)),
      path: opened.selected.path,
      resolvedPath: publicResolvedPath(scope, opened.selected.absolute),
      revision: observation.revision,
      metadataRevision: observation.metadataRevision,
      readOnly,
    };
  } finally {
    await opened.close();
  }
}

export async function documentMetadata(publisher, scope, input) {
  const opened = await openText(publisher, scope, input);
  try {
    const observed = await opened.revalidate();
    return {
      path: opened.selected.path,
      resolvedPath: publicResolvedPath(scope, opened.selected.absolute),
      metadataRevision: observed.metadataRevision,
    };
  } finally {
    await opened.close();
  }
}
