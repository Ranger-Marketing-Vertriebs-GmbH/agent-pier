import { Router } from "express";
import { fileHandler } from "../file-response.js";
import {
  listProjectFiles,
  previewProjectFile,
  createProjectDirectory,
} from "../../features/files/project-files.js";

export function filesRoutes({ sessions, files }) {
  const router = Router();
  router.get("/sessions/:id/files", async (req, res) => {
    const session = await sessions.get(req.params.id);
    res.json(await listProjectFiles(session.cwd, req.query.path, req.query.page));
  });
  router.get("/sessions/:id/files/content", async (req, res) => {
    const session = await sessions.get(req.params.id);
    res.json(await previewProjectFile(session.cwd, req.query.path));
  });
  router.post(
    "/sessions/:id/files",
    fileHandler(async (req, res) => {
      res
        .status(201)
        .json(
          await createProjectDirectory(
            files,
            req.params.id,
            req.body?.path,
            req.body?.name,
          ),
        );
    }),
  );
  return router;
}
