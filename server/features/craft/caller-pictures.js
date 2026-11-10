import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { readShareSource } from "../assistants/agent-share-source.js";
import { realpath } from "../assistants/project-paths.js";
import { assertOutsideDirs, protectedDirs } from "../assistants/protected-dirs.js";
import { fold } from "../assistants/team-plugin/tool-guard.js";
import { pictureLimits } from "./rebuild-pictures.js";

const messages = serverMessages.craft;

/** A picture problem a session or an agent reads: a CRAFT_ code and its message. */
export const pictureProblem = (code, message, status) =>
  Object.assign(new Error(message), { code, status });

const refused = () =>
  pictureProblem("CRAFT_PICTURE_REFUSED", messages.rebuildPictureRefused, 403);

/**
 * A failed read of a caller's picture (readShareSource's keyed problems, a staging
 * refusal) as a CRAFT_PICTURE_ problem; one that already has a code passes.
 */
export function pictureFailure(error) {
  if (error?.code && /^CRAFT_/.test(error.code)) return error;
  const status = error?.status;
  if (status === 403) return refused();
  if (status === 404)
    return pictureProblem(
      "CRAFT_PICTURE_NOT_FOUND",
      messages.rebuildPictureNotFound,
      404,
    );
  if (status === 413)
    return pictureProblem("CRAFT_PICTURE_INVALID", messages.rebuildPictureTooLarge, 413);
  if (status === 429)
    return pictureProblem("CRAFT_PICTURE_INVALID", messages.rebuildPicturesBusy, 429);
  if (status === 400 || status === 409) {
    // A path readShareSource refuses as such, an empty file or one still being
    // written; the staging's own refusals keep their message.
    const message =
      error.key === "invalid"
        ? messages.rebuildPicturesInvalid
        : error.key
          ? messages.rebuildPictureType
          : error.message;
    return pictureProblem("CRAFT_PICTURE_INVALID", message, 400);
  }
  return error;
}

/**
 * Stages the pictures a caller names (`list`, at most pictureLimits.count), each read
 * by `read(entry)` (`{ body }`, a file the caller may already read) and checked by its
 * bytes. Returns the staged ids; on any failure the ones staged so far go and the
 * failure is a CRAFT_PICTURE_ problem.
 */
export async function stagePictures(pictures, list, read) {
  if (!list?.length) return [];
  if (list.length > pictureLimits.count)
    throw pictureProblem("CRAFT_PICTURE_INVALID", messages.rebuildPicturesInvalid, 400);
  const ids = [];
  try {
    for (const entry of list) {
      const { body } = await read(entry);
      ids.push((await pictures.stage(body)).id);
    }
    return ids;
  } catch (error) {
    pictures.release(ids);
    throw pictureFailure(error);
  }
}

/**
 * Reads a picture of a session's own folder (`cwd`): a path relative to it or
 * absolute inside it, never through a link, a regular file with one name, never in
 * `.git` and never in or below AgentPier's data directory (`dataDir`), also when the
 * session itself works there.
 */
export function sessionPictureReader(cwd, dataDir, maxBytes = pictureLimits.maxBytes) {
  const dirs = protectedDirs([dataDir], refused);
  return async (requested) => {
    const real = realpath(cwd);
    if (!real)
      throw pictureProblem(
        "CRAFT_PICTURE_NOT_FOUND",
        messages.rebuildPictureNotFound,
        404,
      );
    assertOutsideDirs(real, dirs, refused);
    const admit = (relative) => {
      if (relative.split(path.sep).some((part) => fold(part) === fold(".git")))
        throw refused();
    };
    return readShareSource([cwd], requested, { maxBytes, admit, refuseDirs: dirs });
  };
}
