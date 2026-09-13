import { Router } from "express";
import { ownsMutationLeases } from "../../application/mutation-barrier.js";
import { fileHandler, openedScope } from "../file-response.js";
import { fileProblem } from "../../features/files/file-errors.js";
import { downloadFile } from "../../features/files/file-downloads.js";

const prefixes = ["/files", "/sessions/:id/files/explorer"];
function requestAbort(req, res) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once("aborted", abort);
  res.once("close", abort);
  return {
    signal: controller.signal,
    close() {
      req.removeListener("aborted", abort);
      res.removeListener("close", abort);
    },
  };
}
export function fileTransferStreams({ files }) {
  const router = Router();
  for (const prefix of prefixes) {
    router.put(
      `${prefix}/uploads/:uploadId/content`,
      fileHandler(async (req, res) => {
        const abort = requestAbort(req, res);
        try {
          const scope = await files.context(req.params.id || null);
          openedScope(req, scope);
          if (!req.is("application/octet-stream") || req.get("Content-Encoding"))
            throw fileProblem("FILE_UPLOAD_MEDIA", 415);
          const header = req.get("Content-Length");
          if (header !== undefined && !/^\d+$/.test(header))
            throw fileProblem("FILE_UPLOAD_LENGTH", 400);
          const job = await files.uploads.receive(scope, req.params.uploadId, req, {
            signal: abort.signal,
            declaredBytes: header === undefined ? undefined : Number(header),
            onInputFailure: abort.close,
          });
          if (!res.destroyed) res.json(job);
        } finally {
          abort.close();
        }
      }),
    );
    router.get(
      `${prefix}/download`,
      fileHandler(async (req, res) => {
        const abort = requestAbort(req, res);
        try {
          const scope = await files.context(req.params.id || null);
          await files.jobs.runDirectTransfer(
            scope,
            ({ scope: fresh, signal }) =>
              downloadFile(fresh, req.query.path ?? "", res, {
                signal,
                limits: files.limits,
              }),
            { signal: abort.signal },
          );
        } finally {
          abort.close();
        }
      }),
    );
  }
  return router;
}
export function fileTransfersRoutes({ files }) {
  const router = Router();
  for (const prefix of prefixes) {
    for (const [suffix, method, status] of [
      ["/upload-groups", "createGroup", 201],
      ["/upload-groups/:groupId/entries", "appendGroup", 200],
      ["/upload-groups/:groupId/commit", "commitGroup", 202],
      ["/uploads", "create", 201],
    ]) {
      router.post(
        `${prefix}${suffix}`,
        ownsMutationLeases(
          fileHandler(async (req, res) => {
            const scope = await files.context(req.params.id || null);
            openedScope(req, scope);
            const result = req.params.groupId
              ? await files.uploads[method](scope, req.params.groupId, req.body)
              : await files.uploads[method](scope, req.body);
            res.status(status).json(result);
          }),
        ),
      );
    }
  }
  return router;
}
