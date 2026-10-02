import { messageIdentity } from "../lib/i18n/message-identity.js";
import { serverMessages } from "../lib/i18n/de.js";
import express from "express";
import path from "node:path";
import { projectDir } from "../lib/config.js";
import { appDocumentPath } from "./security.js";
import { cacheControlFor } from "./cache-policy.js";
export function registerResponses(app) {
  const notFound = {
    error: serverMessages.http.notFound,
    ...messageIdentity(serverMessages.http.notFound),
  };
  app.use("/api", (_req, res) => res.status(404).json(notFound));
  const dist = path.join(projectDir, "dist");
  app.use(
    express.static(dist, {
      dotfiles: "deny",
      index: "index.html",
      setHeaders: (res, file) =>
        res.setHeader("Cache-Control", cacheControlFor(path.relative(dist, file))),
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
      .sendFile("index.html", { root: dist, dotfiles: "deny" }, (error) => {
        if (error) next(error);
      });
  });
  app.use((_req, res) => res.set("Cache-Control", "no-store").status(404).json(notFound));
  app.use((error, _req, res, _next) => {
    res.setHeader("Cache-Control", "no-store");
    let status = error.status || error.statusCode || 400;
    if (!Number.isInteger(status) || status < 400 || status > 599) status = 500;
    const message =
      status === 500
        ? serverMessages.http.internalError
        : error.type === "entity.parse.failed"
          ? serverMessages.http.invalidJson
          : error.message || serverMessages.http.requestFailed;
    res.status(status).json({
      ...(error.code === "MEMORY_DISCOVERY_CONFIG" ||
      /^(?:SSH|ARTIFACT)_[A-Z_]+$/.test(error.code || "")
        ? { code: error.code }
        : {}),
      error: message,
      ...messageIdentity(message),
    });
  });
}
