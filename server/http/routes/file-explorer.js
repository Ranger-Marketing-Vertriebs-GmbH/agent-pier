import { Router } from "express";
import { fileProblem } from "../../features/files/file-errors.js";
import { fileHandler, openedScope } from "../file-response.js";
import { FILE_WATCH_HEADER } from "../../features/files/file-watch-topic.js";

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
    `${prefix}/preferences`,
    fileHandler(async (req, res) => {
      const current = await scope(req);
      res.json(files.preferences.get(current));
    }),
  );
  router.patch(
    `${prefix}/preferences`,
    fileHandler(async (req, res) => {
      const current = await scope(req);
      openedScope(req, current);
      res.json(files.preferences.update(current, req.body));
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
      const view = req.query.view;
      if (
        (view !== undefined && view !== "entry" && view !== "document") ||
        Object.keys(req.query).some(
          (key) => key.startsWith("view[") || key.startsWith("view."),
        )
      )
        throw fileProblem("FILE_INVALID_OPERATION", 400);
      const current = await scope(req);
      const target = req.query.path ?? "";
      if (view !== "document")
        return res.json(await files.reading.metadata(current, target));
      const document = await files.text.metadata(current, target);
      // The editor follows the file on the live channel (file-watch-topic.js) by this
      // topic, issued only now that the read passed.
      const topic = await files.watches?.register(req.principal, current, target);
      if (topic) res.set(FILE_WATCH_HEADER, topic);
      res.json(document);
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
