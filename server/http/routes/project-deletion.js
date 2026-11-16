import path from "node:path";
import { Router } from "express";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

const invalid = () => problem(serverMessages.http.requestFailed);

// An absolute folder path as text; the service resolves and judges it.
function folderPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    !path.isAbsolute(value)
  )
    throw invalid();
  return value;
}
function tokenOf(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw invalid();
  return value;
}
// The ticked processes of the blockers step: { pid, startTime } pairs. A tick
// without a start time is refused: the service ends only the process it was shown.
function processesOf(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000) throw invalid();
  return value.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      !Number.isInteger(item.pid) ||
      typeof item.startTime !== "string" ||
      item.startTime.length === 0 ||
      item.startTime.length > 256
    )
      throw invalid();
    return { pid: item.pid, startTime: item.startTime };
  });
}

/**
 * The owner's project deletion (ProjectDeletion). Not in the user routes, so the
 * deny-by-default access keeps restricted users out.
 */
export function projectDeletionRoutes({ projectDeletion }) {
  const router = Router();
  router.get("/project-deletion", async (request, response) =>
    response.json(await projectDeletion.preflight(folderPath(request.query.path))),
  );
  router.post("/project-deletion/blockers", async (request, response) => {
    const body = request.body ?? {};
    response.json(
      await projectDeletion.endBlockers(
        {
          path: folderPath(body.path),
          token: tokenOf(body.token),
          sessions: body.sessions === true,
          processes: processesOf(body.processes),
        },
        request.principal,
      ),
    );
  });
  router.post("/project-deletion", async (request, response) => {
    const body = request.body ?? {};
    if (body.name !== undefined && typeof body.name !== "string") throw invalid();
    response
      .status(202)
      .json(
        await projectDeletion.start(
          { path: folderPath(body.path), token: tokenOf(body.token), name: body.name },
          request.principal,
        ),
      );
  });
  router.post("/project-deletion/retry", async (request, response) =>
    response
      .status(202)
      .json(
        await projectDeletion.retry(folderPath(request.body?.path), request.principal),
      ),
  );
  return router;
}
