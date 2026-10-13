import test from "node:test";
import assert from "node:assert/strict";
import {
  crossLinkRoute,
  readRoute,
  returnRoute,
  routePath,
} from "../../web/app/routes.js";
import { artifactsRoute } from "../../web/features/artifacts/routes.js";
import {
  artifactLink,
  artifactReturnPath,
} from "../../web/features/artifacts/artifact-return-link.js";

const read = (address) => readRoute(new URL(address, "http://localhost"));
const location = new URL("https://agentpier.example/artifacts");

test("artifact routes carry the selected artifact and the Pinned tab", () => {
  assert.deepEqual(read("/artifacts"), {
    view: "artifacts",
    projectId: "",
    artifactTab: "all",
    artifact: "",
    session: "",
    q: "",
    page: 1,
  });
  assert.deepEqual(
    read(
      "/artifacts/project-one?session=s-1&q=audit+report&page=3&tab=pinned&artifact=a-1",
    ),
    {
      view: "artifacts",
      projectId: "project-one",
      artifactTab: "pinned",
      artifact: "a-1",
      session: "s-1",
      q: "audit report",
      page: 3,
    },
  );
  for (const address of [
    "/artifacts",
    "/artifacts/project-one",
    "/artifacts?artifact=a-1",
    "/artifacts?tab=pinned",
    "/artifacts/project-one?tab=pinned&artifact=a-1",
    "/artifacts?session=s-1",
    "/artifacts?q=audit+report&page=2",
    "/artifacts/p?session=s-1&q=x&page=4&tab=pinned&artifact=a-1",
  ])
    assert.equal(routePath(read(address)), address);
  // Defaults and invalid values drop out of the canonical address.
  assert.equal(routePath(read("/artifacts?tab=all&artifact=")), "/artifacts");
  assert.equal(routePath(read("/artifacts?tab=other")), "/artifacts");
  for (const artifact of ["../x", "a%2Fb", "-lead", "x".repeat(81), "a b"])
    assert.equal(read(`/artifacts?artifact=${artifact}`).artifact, "", artifact);
  for (const [query, field, value] of [
    ["q=" + "x".repeat(201), "q", ""],
    ["q=a%0Ab", "q", ""],
    ["q=%20%20", "q", ""],
    ["page=0", "page", 1],
    ["page=-2", "page", 1],
    ["page=100001", "page", 1],
    ["page=1e3", "page", 1],
    ["session=..%2Fx", "session", ""],
  ])
    assert.equal(read(`/artifacts?${query}`)[field], value, query);
  // Older route objects without the new fields still produce the plain address.
  assert.equal(routePath({ view: "artifacts", projectId: "p" }), "/artifacts/p");
});

test("the viewer returns to the selected artifact detail", () => {
  for (const origin of [
    "/artifacts?artifact=a-1",
    "/artifacts/project-one?artifact=a-1",
    "/artifacts/project-one?tab=pinned&artifact=a-1",
    "/artifacts?session=s-1",
    "/artifacts?q=audit+report&page=2",
    "/artifacts/p?session=s-1&q=x&page=4&tab=pinned&artifact=a-1",
  ]) {
    const link = artifactLink("/artifacts/view/a-1", origin, location);
    assert.equal(artifactReturnPath(new URL(link, location).search), origin);
  }
  // An invalid selection is dropped while the rest of the origin is kept.
  const link = artifactLink(
    "/artifacts/view/a-1",
    "/artifacts/project-one?artifact=..%2Fx",
    location,
  );
  assert.equal(
    artifactReturnPath(new URL(link, location).search),
    "/artifacts/project-one",
  );
  assert.equal(
    artifactReturnPath("?returnTo=%2F%2Fevil.example%2Fartifacts%3Fartifact%3Da"),
    "/artifacts",
  );
});

test("the Artifacts page returns only to the session that opened it", () => {
  const session = { view: "workspace", sessionId: "s1", mode: "reader" };
  const target = crossLinkRoute(
    artifactsRoute({ session: "s1", artifact: "a-1" }),
    session,
  );
  assert.equal(target.returnTo, "/sessions/s1/chat");
  const address = routePath(target);
  assert.equal(
    address,
    "/artifacts?session=s1&artifact=a-1&returnTo=%2Fsessions%2Fs1%2Fchat",
  );
  const reloaded = read(address);
  assert.equal(reloaded.returnTo, "/sessions/s1/chat");
  assert.deepEqual(returnRoute(reloaded), {
    view: "workspace",
    sessionId: "s1",
    mode: "reader",
  });
  // Moves inside the page keep the origin.
  assert.match(
    routePath({ ...reloaded, artifact: "" }),
    /returnTo=%2Fsessions%2Fs1%2Fchat$/,
  );
  // Other origins are not honoured here, and sessions stay no origin for Accounts.
  for (const origin of [
    "/settings/assistants",
    "/accounts",
    "//evil.example/sessions/s1",
  ])
    assert.equal(
      read(`/artifacts?returnTo=${encodeURIComponent(origin)}`).returnTo,
      undefined,
      origin,
    );
  assert.equal(
    crossLinkRoute(artifactsRoute(), { view: "artifacts" }).returnTo,
    undefined,
  );
  assert.equal(
    crossLinkRoute({ view: "accounts", section: "models" }, session).returnTo,
    undefined,
  );
  // The viewer's return path drops the nested origin (shared returnTo check).
  const link = artifactLink("/artifacts/view/a-1", address, location);
  assert.equal(
    artifactReturnPath(new URL(link, location).search),
    "/artifacts?session=s1&artifact=a-1",
  );
});
