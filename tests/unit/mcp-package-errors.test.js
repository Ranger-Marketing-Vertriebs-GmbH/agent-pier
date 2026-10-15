import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  packageCodes,
  packageProblem,
} from "../../server/features/mcp-packages/package-errors.js";
import { registerResponses } from "../../server/http/responses.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

test("every package code has a German message and keeps its code and status", () => {
  assert.equal(packageCodes.length, 18);
  for (const code of packageCodes) {
    const error = packageProblem(code, 409);
    assert.equal(error.code, code);
    assert.equal(error.status, 409);
    assert.equal(typeof error.message, "string");
    assert.ok(error.message.length > 10, code);
  }
  assert.ok(serverMessages.mcpPackages.toolchainUnavailable.includes("Toolchain"));
});

test("a cancelled install has its own code and message", () => {
  const error = packageProblem("MCP_PACKAGE_CANCELLED", 409);
  assert.equal(error.code, "MCP_PACKAGE_CANCELLED");
  assert.equal(error.message, serverMessages.mcpPackages.cancelled);
});

test("a preview failure has its own wording without a log", () => {
  const error = packageProblem("MCP_PACKAGE_INSTALL_FAILED", 502, "previewFailed");
  assert.equal(error.code, "MCP_PACKAGE_INSTALL_FAILED");
  assert.doesNotMatch(error.message, /Protokoll/);
  assert.equal(packageProblem("MCP_PACKAGE_UNSATISFIABLE", 400).status, 400);
  const python = packageProblem("MCP_PACKAGE_UNSATISFIABLE", 400, "pythonUnsupported");
  assert.equal(python.code, "MCP_PACKAGE_UNSATISFIABLE");
  assert.notEqual(python.message, serverMessages.mcpPackages.unsatisfiable);
});

test("an unknown code is a defect, not a silent generic message", () => {
  assert.throws(() => packageProblem("MCP_PACKAGE_NOPE"), /Unknown package code/);
  assert.throws(
    () => packageProblem("MCP_PACKAGE_BUSY", 409, "nope"),
    /Unknown package message/,
  );
});

test("the response layer passes a package code through to the client", async () => {
  const app = express();
  app.get("/fail", (_req, _res, next) =>
    next(packageProblem("MCP_PACKAGE_NEEDS_SCRIPTS", 409)),
  );
  registerResponses(app);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/fail`);
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.code, "MCP_PACKAGE_NEEDS_SCRIPTS");
    assert.equal(body.error, serverMessages.mcpPackages.needsScripts);
  } finally {
    server.close();
  }
});
