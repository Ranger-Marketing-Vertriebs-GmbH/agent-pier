import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import { Router } from "express";
import { pipeline } from "node:stream/promises";
import { problem } from "../../lib/storage.js";
import { releaseVersion } from "../../features/operations/release-archive.js";
function fields(body, names) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((name) => !names.includes(name))
  )
    throw problem(serverMessages.operations.invalidOptions);
  return body;
}
export function operationsRoutes({ operations, releaseMigration }) {
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
      throw problem(serverMessages.backups.invalidHistoryPage);
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
  // Archives of any size stream from disk; nothing is held in memory.
  router.get(`${root}/backups/:id/download`, async (req, res) => {
    let fd;
    try {
      fd = fs.openSync(
        operations.backup.file(req.params.id),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (error.code === "ENOENT") throw problem(serverMessages.backups.notFound, 404);
      throw error;
    }
    const stream = fs.createReadStream(null, { fd });
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) {
      stream.destroy();
      throw problem(serverMessages.operations.invalidFile, 409);
    }
    res
      .attachment(`agentpier-${req.params.id}.apbackup`)
      .type("application/octet-stream")
      .set("Content-Length", String(stat.size));
    await pipeline(stream, res);
  });
  router.delete(`${root}/backups/:id`, (req, res) => {
    operations.backup.remove(req.params.id);
    res.sendStatus(204);
  });
  // The archive streams to disk; its size is only bounded by free space.
  router.post(`${root}/restore/upload`, async (req, res) => {
    if (!req.is("application/octet-stream"))
      throw problem(serverMessages.backups.uploadType);
    const length = Number(req.get("Content-Length") || 0);
    res.status(201).json(
      await operations.restore.upload(req, {
        expectedBytes: Number.isSafeInteger(length) && length > 0 ? length : 0,
      }),
    );
  });
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
  router.put(`${root}/releases/channel`, (req, res) =>
    res.json(
      operations.releases.setUpdateChannel(
        fields(req.body, ["updateChannel"]).updateChannel,
      ),
    ),
  );
  router.get(`${root}/releases/notes`, async (req, res) => {
    const { from, to } = req.query;
    // Repeated query parameters arrive as arrays; only single version strings are valid.
    if (typeof from !== "string" || typeof to !== "string")
      throw problem(serverMessages.operations.invalidOptions);
    res.json(
      await operations.releases.notesRange(releaseVersion(from), releaseVersion(to)),
    );
  });
  router.get(`${root}/releases/notes/:version`, async (req, res) =>
    res.json(await operations.releases.notes(req.params.version)),
  );
  router.get(`${root}/releases/cleanup`, (_req, res) =>
    res.json(operations.releases.cleanupStatus()),
  );
  router.post(`${root}/releases/cleanup`, (req, res) =>
    res
      .status(202)
      .json({ job: operations.cleanupReleases(fields(req.body, ["versions"])) }),
  );
  router.get(`${root}/releases/cleanup/:version/sessions`, async (req, res) =>
    res.json(await releaseMigration.plan(releaseVersion(req.params.version))),
  );
  router.post(`${root}/releases/cleanup/:version/migrate`, (req, res) =>
    res.status(202).json({
      job: releaseMigration.migrate(
        releaseVersion(req.params.version),
        fields(req.body, ["interrupt"]),
      ),
    }),
  );
  router.delete(`${root}/releases/cleanup/:version/migrate`, (req, res) => {
    releaseMigration.cancel(releaseVersion(req.params.version));
    res.status(204).end();
  });
  router.post(`${root}/releases/check`, async (_req, res) =>
    res.json({ plan: await operations.releases.check() }),
  );
  router.post(`${root}/releases/stage`, (req, res) =>
    res.status(202).json({ job: operations.stage(fields(req.body, ["version"])) }),
  );
  router.post(`${root}/releases/activate`, (req, res) =>
    res.status(202).json({
      job: operations.activate(fields(req.body, ["stagedId", "reloadSessions"])),
    }),
  );
  router.post(`${root}/releases/rollback`, (req, res) =>
    res.status(202).json({ job: operations.activate(fields(req.body, ["version"])) }),
  );
  return router;
}
