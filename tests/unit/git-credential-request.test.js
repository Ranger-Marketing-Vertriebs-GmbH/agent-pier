import test from "node:test";
import assert from "node:assert/strict";
import { parseCredentialRequest } from "../../server/features/repositories/git-credential-request.js";
import { gitCredential } from "../../server/features/repositories/github-credentials.js";
import { credentialSession } from "../helpers/git-credential-session.js";

const fields = (input) => {
  const parsed = parseCredentialRequest(input);
  return parsed && Object.fromEntries(parsed);
};

test("credential requests skip repeated multi-valued attributes of git 2.46+", () => {
  assert.deepEqual(
    fields(
      "capability[]=authtype\ncapability[]=state\nprotocol=https\nhost=github.com\n" +
        'wwwauth[]=Basic realm="GitHub"\nwwwauth[]=Bearer realm="GitHub"\n\n',
    ),
    { protocol: "https", host: "github.com" },
  );
});

test("credential requests reject repeated singular keys and malformed lines", () => {
  for (const input of [
    "protocol=https\nhost=github.com\nhost=evil.test\n\n",
    "protocol=https\nprotocol=http\nhost=github.com\n\n",
    "protocol=https\nhost=github.com\npath=a\npath=b\n\n",
    "protocol=https\nhost github.com\n\n",
    "protocol=https\n=github.com\n\n",
    "protocol=https\nhost=git\0hub.com\n\n",
    "x".repeat(65537),
  ])
    assert.equal(parseCredentialRequest(input), null, JSON.stringify(input));
});

test("credential requests end at the blank line, accept CRLF and keep unknown keys", () => {
  assert.deepEqual(fields("protocol=https\r\nhost=github.com\r\n\r\nhost=evil.test\n"), {
    protocol: "https",
    host: "github.com",
  });
  assert.deepEqual(fields("protocol=https\nhost=github.com"), {
    protocol: "https",
    host: "github.com",
  });
  assert.deepEqual(fields("protocol=https\nhost=github.com\nfuture=1\nurl=a=b\n\n"), {
    protocol: "https",
    host: "github.com",
    future: "1",
    url: "a=b",
  });
});

test("the session helper answers git 2.46+ requests and never echoes capabilities", (t) => {
  const { env, token } = credentialSession(t);
  const input =
    "capability[]=authtype\ncapability[]=state\nprotocol=https\nhost=github.com\n" +
    'wwwauth[]=Basic realm="GitHub"\n\n';
  const output = gitCredential(input, env);
  assert.equal(output, `username=x-access-token\npassword=${token}\n\n`);
  assert.doesNotMatch(output, /capability/);
  assert.equal(gitCredential(input.replace(/\n/g, "\r\n"), env), output);
  for (const operation of ["store", "erase"])
    assert.equal(gitCredential(input, env, operation), "");
  assert.equal(
    gitCredential(
      "capability[]=authtype\nprotocol=https\nhost=github.com\nhost=github.com\n\n",
      env,
    ),
    "",
  );
});
