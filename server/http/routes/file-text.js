import { Router } from "express";
import { fileProblem } from "../../features/files/file-errors.js";
import { fileHandler, openedScope } from "../file-response.js";

function oneHeader(req, name) {
  const count = req.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === name,
  ).length;
  if (count > 1) throw fileProblem("FILE_TEXT_PRECONDITION", 400);
  return req.get(name);
}
export function textPrecondition(req) {
  const match = oneHeader(req, "if-match"),
    absent = oneHeader(req, "if-none-match");
  if (match !== undefined && absent !== undefined)
    throw fileProblem("FILE_TEXT_PRECONDITION", 400);
  if (absent === "*") return null;
  if (
    absent !== undefined ||
    typeof match !== "string" ||
    !/^"d1:[a-f0-9]{64}"$/.test(match)
  )
    throw fileProblem("FILE_TEXT_PRECONDITION", 400);
  return match.slice(1, -1);
}
async function rawText(req, limit) {
  if (
    !/^text\/plain(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(
      req.get("Content-Type") || "",
    ) ||
    req.get("Content-Encoding")
  )
    throw fileProblem("FILE_TEXT_MEDIA", 415);
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
    chunks.push(chunk);
  }
  if (!req.complete) throw fileProblem("FILE_INVALID_REQUEST", 400);
  return Buffer.concat(chunks, length);
}
export function fileTextRoutes({ files }) {
  const router = Router();
  for (const prefix of ["/files", "/sessions/:id/files/explorer"]) {
    router.get(
      `${prefix}/text`,
      fileHandler(async (req, res) => {
        res.json(
          await files.text.read(
            await files.context(req.params.id || null),
            req.query.path ?? "",
          ),
        );
      }),
    );
    router.put(
      `${prefix}/text`,
      fileHandler(async (req, res) => {
        const scope = await files.context(req.params.id || null);
        openedScope(req, scope);
        if (scope.readOnly) throw fileProblem("FILE_READ_ONLY", 403);
        const revision = textPrecondition(req),
          requestId = oneHeader(req, "x-file-request");
        if (
          !/^\d{1,16}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            requestId || "",
          )
        )
          throw fileProblem("FILE_INVALID_REQUEST", 400);
        const bytes = await rawText(req, files.limits.textBytes);
        const result = await files.text.save(scope, req.query.path ?? "", bytes, {
          revision,
          requestId,
        });
        if (!res.destroyed) res.json(result);
      }),
    );
  }
  return router;
}
