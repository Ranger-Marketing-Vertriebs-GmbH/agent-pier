import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  npmPublisher,
  plainText,
  pypiPublisher,
  webLink,
} from "../../server/features/mcp-packages/publisher-info.js";

test("plain text drops control and bidi characters and caps the length", () => {
  assert.equal(plainText("  Jane‮ Doe\u0007 "), "Jane Doe");
  assert.equal(plainText(""), null);
  assert.equal(plainText(42), null);
  assert.equal(plainText("x".repeat(300)).length, 200);
  assert.ok(plainText("x".repeat(300)).endsWith("…"));
});

test("links are http(s) only, without credentials, and git forms become https", () => {
  assert.equal(webLink("git+https://github.com/o/r.git"), "https://github.com/o/r");
  assert.equal(webLink("git@github.com:o/r.git"), "https://github.com/o/r");
  assert.equal(webLink("github:o/r"), "https://github.com/o/r");
  assert.equal(webLink("git://github.com/o/r.git"), "https://github.com/o/r");
  assert.equal(webLink("https://user:pw@example.test/x"), null);
  assert.equal(webLink("javascript:alert(1)"), null);
  assert.equal(webLink("ftp://example.test"), null);
  assert.equal(webLink(`https://example.test/${"a".repeat(2100)}`), null);
});

test("npm: author and maintainers of the latest version, repository normalised", () => {
  const packument = {
    "dist-tags": { latest: "1.1.0" },
    versions: {
      "1.1.0": {
        author: { name: "Jane Doe", email: "jane@example.test" },
        maintainers: [{ name: "jdoe" }, { name: "ops" }],
        repository: { type: "git", url: "git+https://github.com/jdoe/server-x.git" },
      },
    },
  };
  assert.deepEqual(npmPublisher(packument), {
    publisher: "Jane Doe, jdoe, ops",
    repositoryUrl: "https://github.com/jdoe/server-x",
  });
  assert.deepEqual(npmPublisher({ author: "Max <max@example.test> (https://x)" }), {
    publisher: "Max",
    repositoryUrl: null,
  });
  assert.deepEqual(npmPublisher({}), { publisher: null, repositoryUrl: null });
});

test("PyPI: author or maintainer, Source before Repository before Homepage", () => {
  const project = {
    info: {
      author: "",
      maintainer: "Ops Team",
      project_urls: {
        Homepage: "https://example.test",
        Repository: "https://github.com/o/r",
        Source: "https://git.example.test/o/r",
      },
    },
  };
  assert.deepEqual(pypiPublisher(project), {
    publisher: "Ops Team",
    repositoryUrl: "https://git.example.test/o/r",
  });
  assert.deepEqual(pypiPublisher({ info: { home_page: "http://example.test/p" } }), {
    publisher: null,
    repositoryUrl: "http://example.test/p",
  });
});

test("publisher fields never throw and never carry control characters", () => {
  fc.assert(
    fc.property(fc.anything(), fc.anything(), (author, repository) => {
      const { publisher, repositoryUrl } = npmPublisher({ author, repository });
      for (const value of [publisher, repositoryUrl])
        assert.ok(value === null || !/[\u0000-\u001f‪-‮]/.test(value));
    }),
  );
});
