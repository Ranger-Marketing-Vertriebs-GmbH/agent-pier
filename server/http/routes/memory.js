import { Router } from "express";
import { problem } from "../../lib/storage.js";

function pageValue(raw) {
  if (raw === undefined) return 1;
  if (
    typeof raw !== "string" ||
    !/^[1-9]\d*$/.test(raw) ||
    !Number.isSafeInteger(Number(raw))
  )
    throw problem("Invalid memory page.");
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

export function memoryRoutes({ memory, directory }) {
  const router = Router();
  router.get("/memory/projects", (_request, response) =>
    response.json(memory.projects()),
  );
  router.post("/memory/projects", async (request, response) =>
    response.status(201).json(await memory.register(await directory(request.body?.cwd))),
  );
  const base = "/memory/projects/:projectId/entries";
  router.get(base, (request, response) => {
    const { page, q, archived } = request.query;
    if (archived !== undefined && archived !== "true" && archived !== "false")
      throw problem("Invalid memory archive filter.");
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
