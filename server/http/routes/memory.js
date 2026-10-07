import { serverMessages } from "../../lib/i18n/de.js";
import { Router } from "express";
import { problem } from "../../lib/storage.js";
import { wantsRemotes } from "../../features/repositories/git-remote.js";
import { withDuplicates } from "../../features/memory/project-duplicates.js";

function pageValue(raw) {
  if (raw === undefined) return 1;
  if (
    typeof raw !== "string" ||
    !/^[1-9]\d*$/.test(raw) ||
    !Number.isSafeInteger(Number(raw))
  )
    throw problem(serverMessages.memory.invalidPage);
  return Number(raw);
}
function content(body) {
  return {
    title: body?.title,
    content: body?.content,
    expectedRevision: body?.expectedRevision,
    requestId: body?.requestId,
  };
}

export function memoryRoutes({ memory, directory, gitRemotes, projectDuplicates }) {
  const router = Router();
  router.get("/memory/projects", async (request, response) => {
    // Only the projects hub asks (?duplicates=1) which row of a shared folder is
    // current; that reads the folder's Git identity, which other readers skip.
    const listed = memory.projects().projects;
    const projects =
      request.query?.duplicates === "1" ? await withDuplicates(listed) : listed;
    response.json({
      projects:
        gitRemotes && wantsRemotes(request)
          ? await gitRemotes.annotate(projects, "cwd")
          : projects,
    });
  });
  router.get("/memory/projects/:projectId/merge", async (request, response) =>
    response.json(
      await projectDuplicates.preview(request.params.projectId, request.query.olderId),
    ),
  );
  router.post("/memory/projects/:projectId/merge", async (request, response) =>
    response.json(
      await projectDuplicates.merge(request.params.projectId, {
        olderId: request.body?.olderId,
        fingerprint: request.body?.fingerprint,
      }),
    ),
  );
  router.post("/memory/projects", async (request, response) => {
    const project = await memory.register(await directory(request.body?.cwd));
    if (!project) throw problem(serverMessages.memory.projectFolderExcluded, 422);
    response.status(201).json(project);
  });
  const base = "/memory/projects/:projectId/entries";
  router.get(base, (request, response) => {
    const { page, q, archived } = request.query;
    if (archived !== undefined && archived !== "true" && archived !== "false")
      throw problem(serverMessages.memory.invalidArchiveFilter);
    response.json(
      memory.list(request.params.projectId, {
        query: q ?? "",
        page: pageValue(page),
        archived: archived === "true",
      }),
    );
  });
  router.post(base, (request, response) =>
    response
      .status(201)
      .json(
        memory.write(request.params.projectId, content(request.body), { kind: "user" }),
      ),
  );
  router.get(base + "/:id", (request, response) =>
    response.json(
      memory.read(
        request.params.projectId,
        request.params.id,
        request.query.revision === undefined
          ? {}
          : { revision: pageValue(request.query.revision) },
      ),
    ),
  );
  router.patch(base + "/:id", (request, response) =>
    response.json(
      memory.write(
        request.params.projectId,
        { ...content(request.body), id: request.params.id },
        { kind: "user" },
      ),
    ),
  );
  router.get(base + "/:id/revisions", (request, response) =>
    response.json(
      memory.revisions(request.params.projectId, request.params.id, {
        page: pageValue(request.query.page),
      }),
    ),
  );
  router.post(base + "/:id/archive", (request, response) =>
    response.json(
      memory.archive(
        request.params.projectId,
        request.params.id,
        {
          expectedRevision: request.body?.expectedRevision,
          archived: request.body?.archived,
        },
        { kind: "user" },
      ),
    ),
  );
  return router;
}
