import express, { Router } from "express";
import { readFile } from "../../features/operations/files.js";
import { ARCHIVE_LIMIT } from "../../features/operations/archive.js";
import { problem } from "../../lib/storage.js";
function fields(body, names) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((name) => !names.includes(name))
  )
    throw problem("Invalid operation options.");
  return body;
}
export function operationsRoutes({ operations }) {
  const router = Router(),
    root = "/operations";
  router.get(`${root}/imported-history/agentbus`, (_req, res) =>
    res.json({ projects: operations.importedHistory.projects() }),
  );
  router.get(`${root}/imported-history/agentbus/:id`, (req, res) => {
    if (
      req.query.page !== undefined &&
      (typeof req.query.page !== "string" || !/^[1-9]\d*$/.test(req.query.page))
    )
      throw problem("Invalid imported history page.");
    res.json(
      operations.importedHistory.messages(req.params.id, {
        page: req.query.page === undefined ? 1 : Number(req.query.page),
      }),
    );
  });
  router.get(`${root}/jobs/:id`, (req, res) =>
    res.json({ job: operations.jobs.get(req.params.id) }),
  );
  router.get(`${root}/doctor`, (_req, res) => res.json({ report: operations.report() }));
  router.post(`${root}/doctor`, async (req, res) =>
    res.json({
      report: await operations.diagnose(fields(req.body, ["scope", "projectId", "deep"])),
    }),
  );
  router.get(`${root}/backups`, (_req, res) =>
    res.json({ backups: operations.backup.list() }),
  );
  router.post(`${root}/backups/plan`, (req, res) =>
    res.json({
      plan: operations.backup.plan(
        fields(req.body, ["includeHistory", "withCredentials"]),
      ),
    }),
  );
  router.post(`${root}/backups`, (req, res) =>
    res.status(202).json({
      job: operations.createBackup(
        fields(req.body, ["includeHistory", "withCredentials", "passphrase"]),
      ),
    }),
  );
  router.get(`${root}/backups/:id/download`, (req, res) => {
    const content = readFile(operations.backup.file(req.params.id), ARCHIVE_LIMIT);
    res
      .attachment(`agentpier-${req.params.id}.apbackup`)
      .type("application/octet-stream")
      .send(content);
  });
  router.delete(`${root}/backups/:id`, (req, res) => {
    operations.backup.remove(req.params.id);
    res.sendStatus(204);
  });
  router.post(
    `${root}/restore/upload`,
    express.raw({ type: "application/octet-stream", limit: ARCHIVE_LIMIT }),
    (req, res) => {
      if (!Buffer.isBuffer(req.body))
        throw problem("Upload an application/octet-stream backup archive.");
      res.status(201).json(operations.restore.upload(req.body));
    },
  );
  router.post(`${root}/restore/inspect`, async (req, res) =>
    res.json({
      inspection: await operations.inspect(
        fields(req.body, ["archiveId", "projectMap", "passphrase"]),
      ),
    }),
  );
  router.post(`${root}/restore`, (req, res) =>
    res.status(202).json({
      job: operations.applyRestore(
        fields(req.body, ["archiveId", "projectMap", "passphrase", "targetDataDir"]),
      ),
    }),
  );
  router.get(`${root}/releases`, (_req, res) => res.json(operations.releases.status()));
  router.get(`${root}/releases/notes/:version`, async (req, res) =>
    res.json(await operations.releases.notes(req.params.version)),
  );
  router.post(`${root}/releases/check`, async (_req, res) =>
    res.json({ plan: await operations.releases.check() }),
  );
  router.post(`${root}/releases/stage`, (req, res) =>
    res.status(202).json({ job: operations.stage(fields(req.body, ["version"])) }),
  );
  router.post(`${root}/releases/activate`, (req, res) =>
    res.status(202).json({ job: operations.activate(fields(req.body, ["stagedId"])) }),
  );
  router.post(`${root}/releases/rollback`, (req, res) =>
    res.status(202).json({ job: operations.activate(fields(req.body, ["version"])) }),
  );
  return router;
}
