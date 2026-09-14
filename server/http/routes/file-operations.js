import { ownsMutationLeases } from "../../application/mutation-barrier.js";
import { Router } from "express";
import { fileHandler, openedScope } from "../file-response.js";

function register(router, prefix, files) {
  const scope = (req) => files.context(req.params.id || null);
  router.post(
    `${prefix}/operations`,
    fileHandler(async (req, res) => {
      const current = await scope(req);
      openedScope(req, current);
      res
        .status(202)
        .json(await files.jobs.start(current, req.body, { publicOnly: true }));
    }),
  );
  router.get(
    `${prefix}/jobs`,
    fileHandler(async (req, res) => {
      res.json(files.jobs.list(await scope(req), req.query.cursor));
    }),
  );
  router.get(
    `${prefix}/jobs/:jobId`,
    fileHandler(async (req, res) => {
      res.json(files.jobs.get(await scope(req), req.params.jobId));
    }),
  );
  router.get(
    `${prefix}/jobs/:jobId/entries`,
    fileHandler(async (req, res) => {
      res.json(files.jobs.entries(await scope(req), req.params.jobId, req.query.cursor));
    }),
  );
  router.get(
    `${prefix}/jobs/:jobId/retry`,
    fileHandler(async (req, res) => {
      res.json(
        await files.retries.preview(await scope(req), req.params.jobId, req.query.cursor),
      );
    }),
  );
  router.post(
    `${prefix}/jobs/:jobId/retry`,
    fileHandler(async (req, res) => {
      const current = await scope(req);
      openedScope(req, current);
      res
        .status(202)
        .json(await files.retries.start(current, req.params.jobId, req.body));
    }),
  );
  router.get(
    `${prefix}/trash`,
    fileHandler(async (req, res) => {
      res.json(await files.trash.list(await scope(req), req.query.cursor));
    }),
  );
  router.get(
    `${prefix}/jobs/:jobId/upload-children`,
    fileHandler(async (req, res) => {
      res.json(
        files.jobs.uploadChildren(await scope(req), req.params.jobId, req.query.cursor),
      );
    }),
  );
  for (const action of ["cancel", "resolve"])
    router.post(
      `${prefix}/jobs/:jobId/${action}`,
      ownsMutationLeases(
        fileHandler(async (req, res) => {
          const current = await scope(req);
          openedScope(req, current);
          res.json(await files.jobs[action](current, req.params.jobId, req.body));
        }),
      ),
    );
}
export function fileOperationsRoutes({ files }) {
  const router = Router();
  register(router, "/files", files);
  register(router, "/sessions/:id/files/explorer", files);
  return router;
}
