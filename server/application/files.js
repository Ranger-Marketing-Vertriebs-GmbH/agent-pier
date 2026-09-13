import {
  searchFiles,
  measureFiles,
  validateMetadataOperation,
} from "../features/files/file-search.js";
import { FileStore } from "../features/files/file-store.js";
import { FileJobs } from "../features/files/file-jobs.js";
import { PathLocks } from "../features/files/file-locks.js";
import {
  createFileJobHandlers,
  registerFileJobHandler,
} from "../features/files/file-job-handlers.js";
import { makeFileScope } from "../features/files/file-scope.js";
import { fileProblem, fileSystemProblem } from "../features/files/file-errors.js";
import { readFileLimits } from "../features/files/file-limits.js";
import { FileListingStore } from "../features/files/file-listing.js";
import { metadata, preview } from "../features/files/file-reading.js";
import { FilePreferences } from "../features/files/file-preferences.js";

export function createFileServices({ config, sessions, mutationBarrier }) {
  if (!mutationBarrier) throw new TypeError("File services require a mutation barrier.");
  const limits = Object.freeze(readFileLimits(config.files?.limits));
  const listings = new FileListingStore({ limits });
  const reading = Object.freeze({ metadata, preview });
  const preferences = new FilePreferences({ dataDir: config.dataDir, home: config.home });

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

  const store = new FileStore({ dataDir: config.dataDir, limits });
  const locks = new PathLocks();
  const handlers = createFileJobHandlers();
  const resultStore = {
    putEntry: (jobId, entry) => mutationBarrier.run(() => store.putEntry(jobId, entry)),
  };
  for (const [kind, handler] of [
    ["search", searchFiles],
    ["size", measureFiles],
  ])
    registerFileJobHandler(
      handlers,
      kind,
      (args) => handler({ ...args, store: resultStore, limits }),
      {
        public: true,
        validate: validateMetadataOperation,
      },
    );
  const jobs = new FileJobs({
    store,
    locks,
    barrier: mutationBarrier,
    limits,
    handlers,
    context,
  });

  return {
    store,
    locks,
    handlers,
    jobs,
    context,
    listings,
    reading,
    preferences,
    limits,
    async close() {
      await jobs.close();
      listings.snapshots.clear();
    },
  };
}
