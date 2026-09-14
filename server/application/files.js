import { FileText } from "../features/files/file-text.js";
import { FileArchives, registerArchiveHandlers } from "../features/files/file-zip.js";
import { FileExtracts, registerExtractHandlers } from "../features/files/file-extract.js";
import {
  FileMutations,
  registerMutationHandlers,
} from "../features/files/file-mutations.js";
import { FileTrash } from "../features/files/file-trash.js";
import { FileCopies, registerCopyHandlers } from "../features/files/file-copy.js";
import { registerTrashHandlers } from "../features/files/file-trash-handlers.js";
import { FilePublisher } from "../features/files/file-publish.js";
import { recoverPublications } from "../features/files/file-recovery.js";
import {
  searchFiles,
  measureFiles,
  validateMetadataOperation,
} from "../features/files/file-search.js";
import { FileStore } from "../features/files/file-store.js";
import { FileJobs } from "../features/files/file-jobs.js";
import { FileJobRetries } from "../features/files/file-job-retries.js";
import { FileUploads } from "../features/files/file-uploads.js";
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
      await ready;
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
  const publisher = new FilePublisher({ store, locks, barrier: mutationBarrier });
  const trash = new FileTrash({ store, publisher, limits, context });
  let uploads, archives, text;
  const ready = recoverPublications({ store, barrier: mutationBarrier })
    .then(() => trash.recover())
    .then(() => uploads.recover())
    .then(() => archives.recover())
    .then(() => extracts.recover())
    .then(() => text.recover())
    .then(() => archives.sweep())
    .then(() => uploads.sweep())
    .then(() => uploads.start());
  // Keep startup failure observable to callers without an unhandled rejection.
  ready.catch(() => {});
  const handlers = createFileJobHandlers();
  registerTrashHandlers(handlers, trash);
  const mutations = new FileMutations({ publisher, trash, locks, context });
  registerMutationHandlers(handlers, mutations);
  const copies = new FileCopies({ publisher, trash, locks, context, limits });
  registerCopyHandlers(handlers, copies);
  const extracts = new FileExtracts({ publisher, trash, locks, context, limits });
  registerExtractHandlers(handlers, extracts);
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
    beforeStoreClose: async () => {
      try {
        await ready;
      } finally {
        try {
          try {
            await text.close();
            await archives.close();
            await uploads.close();
          } finally {
            await trash.close();
          }
        } finally {
          await publisher.close();
        }
      }
    },
  });
  uploads = new FileUploads({ jobs, store, publisher, trash, limits });
  archives = new FileArchives({ jobs, store, publisher, trash, limits });
  registerArchiveHandlers(handlers, archives);
  const retries = new FileJobRetries({ jobs, store, trash });
  text = new FileText({ jobs, store, publisher, trash, limits, context, handlers });
  jobs.prepareJob = (scope, id) => retries.prepare(scope, id);

  return {
    store,
    locks,
    publisher,
    mutations,
    trash,
    ready,
    handlers,
    jobs,
    retries,
    text,
    uploads,
    archives,
    extracts,
    context,
    listings,
    reading,
    preferences,
    limits,
    async close() {
      archives.stop();
      uploads.stop();
      await jobs.close();
      listings.snapshots.clear();
    },
  };
}
