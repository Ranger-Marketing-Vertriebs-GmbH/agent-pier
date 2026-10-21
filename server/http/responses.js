import { messageIdentity } from "../lib/i18n/message-identity.js";
import { serverMessages } from "../lib/i18n/de.js";
import express from "express";
import path from "node:path";
import { projectDir } from "../lib/config.js";
import { appDocumentPath } from "./security.js";
import { cacheControlFor } from "./cache-policy.js";
/** The body of an unknown /api route; refusals that must not reveal a route reuse it. */
export const notFoundBody = () => ({
  error: serverMessages.http.notFound,
  ...messageIdentity(serverMessages.http.notFound),
});
export function registerResponses(app) {
  const notFound = notFoundBody();
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
      error.code === "CLI_UPDATE_REQUIRED" ||
      /^(?:(?:SSH|ARTIFACT|PIPELINE|MCP_CLI|MCP_PACKAGE|MCP_DIRECTORY|USER)_[A-Z_]+|CHAT_(?:ARCHIVED|MAIN|BUSY|COMMAND|COMMAND_QUEUED|CONFIRM|COMPACT_NOTHING|COMPACT_FAILED)|LOGIN_(?:USERNAME|PASSWORD)_INVALID)$/.test(
        error.code || "",
      )
        ? { code: error.code }
        : {}),
      // Which CLI is too old, its version and the minimum (cli-version.js).
      ...(error.code === "CLI_UPDATE_REQUIRED" && error.updateRequired
        ? { updateRequired: error.updateRequired }
        : {}),
      error: message,
      ...messageIdentity(message),
    });
  });
}
