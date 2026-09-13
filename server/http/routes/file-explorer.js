import { Router } from "express";
import { fileProblem } from "../../features/files/file-errors.js";
import { filesCopy } from "../../lib/i18n/de/files.js";

function issueArgs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) =>
      ["string", "number", "boolean"].includes(typeof item),
    ),
  );
}

function fileHandler(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const stable = /^FILE_[A-Z0-9_]+$/.test(error.code || "");
      const status =
        stable &&
        Number.isInteger(error.status) &&
        error.status >= 400 &&
        error.status <= 599
          ? error.status
          : 500;
      res.status(status).json({
        error: filesCopy.explorerFailed,
        code: stable ? error.code : "FILE_IO_ERROR",
        args: stable ? issueArgs(error.args) : {},
      });
    }
  };
}

function pageValue(value) {
  if (value === undefined) return 1;
  if (
    typeof value !== "string" ||
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw fileProblem("FILE_INVALID_PAGE", 400);
  return Number(value);
}

function hiddenValue(value) {
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw fileProblem("FILE_INVALID_SORT", 400);
}

function registerReadRoutes(router, prefix, files) {
  const scope = (req) => files.context(req.params.id || null);

  router.get(
    `${prefix}/context`,
    fileHandler(async (req, res) => {
      const current = await scope(req);
      res.json({
        scopeId: current.id,
        kind: current.kind,
        root: current.root,
        home: current.home,
        readOnly: current.readOnly,
        limits: files.limits,
      });
    }),
  );
  router.get(
    `${prefix}/entries`,
    fileHandler(async (req, res) => {
      const current = await scope(req);
      res.json(
        await files.listings.list(current, {
          path: req.query.path ?? "",
          page: pageValue(req.query.page),
          sort: req.query.sort ?? "name",
          direction: req.query.direction ?? "asc",
          hidden: hiddenValue(req.query.hidden),
          snapshot: req.query.snapshot ?? null,
        }),
      );
    }),
  );
  router.get(
    `${prefix}/metadata`,
    fileHandler(async (req, res) => {
      res.json(await files.reading.metadata(await scope(req), req.query.path ?? ""));
    }),
  );
  router.get(
    `${prefix}/preview`,
    fileHandler(async (req, res) => {
      res.json(
        await files.reading.preview(await scope(req), req.query.path ?? "", {
          limits: files.limits,
        }),
      );
    }),
  );
}

export function fileExplorerRoutes({ files }) {
  const router = Router();
  registerReadRoutes(router, "/files", files);
  registerReadRoutes(router, "/sessions/:id/files/explorer", files);
  return router;
}
