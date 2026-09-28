import test from "node:test";
import assert from "node:assert/strict";
import {
  artifactLink,
  artifactReturnPath,
} from "../../web/features/artifacts/artifact-return-link.js";

const location = new URL("https://agentpier.example/sessions/origin/chat");

test("artifact links carry the current origin while preserving bundle URL details", () => {
  for (const href of [
    "/artifacts/view/example?existing=1#section",
    "https://agentpier.example/artifacts/view/example?existing=1#section",
  ]) {
    const result = new URL(
      artifactLink(href, "/sessions/origin/chat", location),
      location,
    );
    assert.equal(result.pathname, "/artifacts/view/example");
    assert.equal(result.searchParams.get("returnTo"), "/sessions/origin/chat");
    assert.equal(result.searchParams.get("existing"), "1");
    assert.equal(result.hash, "#section");
  }
});

test("reopening a shared artifact replaces stale return context", () => {
  const result = artifactLink(
    "/artifacts/view/example?returnTo=%2Fsessions%2Fold%2Fchat",
    "/sessions/current/terminal",
    location,
  );
  assert.equal(
    artifactReturnPath(new URL(result, location).search),
    "/sessions/current/terminal",
  );
});

test("non-artifact and foreign-origin links are not rewritten", () => {
  for (const href of [
    undefined,
    "",
    "#fragment",
    "docs/report.md",
    "/tmp/report.html",
    "/api/artifacts/example/bundle",
    "/artifacts",
    "/artifacts/view/example/extra",
    "https://other.example/artifacts/view/example",
    "http://agentpier.example/artifacts/view/example",
    "https://agentpier.example:444/artifacts/view/example",
    "https://user:password@agentpier.example/artifacts/view/example",
    "javascript:alert(1)",
  ])
    assert.equal(artifactLink(href, "/sessions/origin/chat", location), null, href);
});

test("return destinations preserve explicit modes and project filters", () => {
  for (const path of [
    "/sessions/session-one/chat",
    "/sessions/session-two/terminal",
    "/sessions/session-one/files?file=docs%2Freport.md",
    "/artifacts",
    "/artifacts/project-one",
  ])
    assert.equal(artifactReturnPath(`?${new URLSearchParams({ returnTo: path })}`), path);
  assert.equal(
    artifactReturnPath("?returnTo=%2Fsessions%2Forigin%2Freader"),
    "/sessions/origin/chat",
  );
});

test("invalid or unsafe return destinations use the artifact list fallback", () => {
  for (const path of [
    "",
    "/",
    "/sessions/origin",
    "/sessions/origin/unknown",
    "/artifacts/view/example",
    "https://outside.example",
    "//outside.example",
    "/\\outside.example",
    "javascript:alert(1)",
    "/api/state",
    "/settings",
    "/sessions/%/chat",
    "/sessions/%2F%2Foutside.example/chat",
    "/sessions/origin/chat\n",
    "/artifacts/../settings",
    "/%2f%2foutside.example",
  ])
    assert.equal(
      artifactReturnPath(`?${new URLSearchParams({ returnTo: path })}`),
      "/artifacts",
      path,
    );
  assert.equal(artifactReturnPath(""), "/artifacts");
});
