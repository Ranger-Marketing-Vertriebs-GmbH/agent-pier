import { makeFileScope } from "../features/files/file-scope.js";
import { fileProblem, fileSystemProblem } from "../features/files/file-errors.js";
import { readFileLimits } from "../features/files/file-limits.js";
import { FileListingStore } from "../features/files/file-listing.js";
import { metadata, preview } from "../features/files/file-reading.js";

export function createFileServices({ config, sessions, mutationBarrier }) {
  if (!mutationBarrier) throw new TypeError("File services require a mutation barrier.");
  const limits = Object.freeze(readFileLimits(config.files?.limits));
  const listings = new FileListingStore({ limits });
  const reading = Object.freeze({ metadata, preview });

  async function context(sessionId = null) {
    try {
      if (sessionId === null) return await makeFileScope({ home: config.home });
      if (typeof sessionId !== "string" || !sessionId)
        throw fileProblem("FILE_INVALID_SCOPE", 400);
      const session = await sessions.get(sessionId);
      return await makeFileScope({ home: config.home, session });
    } catch (error) {
      if (!error.code && error.status === 404)
        throw fileProblem("FILE_INVALID_SCOPE", 404);
      throw fileSystemProblem(error);
    }
  }

  return {
    context,
    listings,
    reading,
    limits,
    close() {
      listings.snapshots.clear();
    },
  };
}
