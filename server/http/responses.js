import { serverMessages } from "../lib/i18n/de.js";
import express from "express";
import path from "node:path";
import { projectDir } from "../lib/config.js";
import { appDocumentPath } from "./security.js";
export function registerResponses(app) {
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: serverMessages.http.notFound }),
  );
  app.use(
    express.static(path.join(projectDir, "dist"), {
      dotfiles: "deny",
      index: "index.html",
    }),
  );
  app.use((req, res, next) => {
    if (
      req.method !== "GET" ||
      !req.headers.accept?.includes("text/html") ||
      /^\/(?:assets|web|\.data)(?:\/|$)/.test(req.path) ||
      /\.[^/]+$/.test(req.path)
    )
      return next();
    const known = appDocumentPath.test(req.path);
    res
      .status(known ? 200 : 404)
      .sendFile(
        "index.html",
        { root: path.join(projectDir, "dist"), dotfiles: "deny" },
        (error) => {
          if (error) next(error);
        },
      );
  });
  app.use((_req, res) =>
    res.status(404).json({
      error: serverMessages.http.buildRequiredForPage,
    }),
  );
  app.use((error, _req, res, _next) => {
    let status = error.status || error.statusCode || 400;
    if (!Number.isInteger(status) || status < 400 || status > 599) status = 500;
    res.status(status).json({
      error:
        status === 500
          ? serverMessages.http.internalError
          : error.type === "entity.parse.failed"
            ? serverMessages.http.invalidJson
            : error.message || serverMessages.http.requestFailed,
    });
  });
}
