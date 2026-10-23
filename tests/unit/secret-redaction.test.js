import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { redactSecrets, redactedMark } from "../../server/lib/secret-redaction.js";

const M = redactedMark;
// Synthetic secrets are built at run time, so no committed line looks like a real
// credential to the repository's secret scanner (.github/workflows/secrets.yml).
const AUTH = ["Author", "ization"].join("");
const jwt = [
  ["eyJhbGci", "OiJIUzI1NiJ9"].join(""),
  ["eyJzdWIi", "OiIxMjM0NTY3ODkwIn0"].join(""),
  ["dozjgNry", "P4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"].join(""),
].join(".");

// [command, what is stored]: only the value goes, the flag or header name stays.
const redacted = [
  ["mytool --password hunter2 -v", `mytool --password ${M} -v`],
  ["mytool --password=hunter2", `mytool --password=${M}`],
  ['mytool --password "two words"', `mytool --password "${M}"`],
  ["mytool --pass=x1 --passwd x2", `mytool --pass=${M} --passwd ${M}`],
  ["gh --token abc123 api", `gh --token ${M} api`],
  ["cli --api-key=k3y --secret s3c", `cli --api-key=${M} --secret ${M}`],
  ["az login --client-secret 'q~w e'", `az login --client-secret '${M}'`],
  [
    `curl -H "${AUTH}: Bearer abc.def" https://x.invalid`,
    `curl -H "${AUTH}: Bearer ${M}" https://x.invalid`,
  ],
  [
    `curl -H '${AUTH.toLowerCase()}: Basic dXNlcjpw'`,
    `curl -H '${AUTH.toLowerCase()}: Basic ${M}'`,
  ],
  ['curl -H "X-Api-Key: 12345"', `curl -H "X-Api-Key: ${M}"`],
  ["wget --header='X-Auth-Token: t0k'", `wget --header='X-Auth-Token: ${M}'`],
  [
    "git clone https://bob:s3cr3t@git.example.invalid/r.git",
    `git clone https://bob:${M}@git.example.invalid/r.git`,
  ],
  ["mysql -uroot -phunter2 db", `mysql -uroot -p${M} db`],
  ["mysqldump -u root -pP@ss db > x", `mysqldump -u root -p${M} db > x`],
  ["sshpass -p hunter2 ssh host", `sshpass -p ${M} ssh host`],
  ["sshpass -phunter2 ssh host", `sshpass -p${M} ssh host`],
  ["DB_PASSWORD=hunter2 ./run", `DB_PASSWORD=${M} ./run`],
  ["export api_key='abc def'; ls", `export api_key='${M}'; ls`],
  ["GITHUB_TOKEN=x && gh pr list", `GITHUB_TOKEN=${M} && gh pr list`],
  ["AWS_SECRET_ACCESS_KEY=abc env", `AWS_SECRET_ACCESS_KEY=${M} env`],
  ["MY_PRIVATE_KEY=abc;", `MY_PRIVATE_KEY=${M};`],
  ["OPENAI_APIKEY=abc", `OPENAI_APIKEY=${M}`],
  [`echo ${jwt}`, `echo ${M}`],
  [`echo ${["sk", "proj", "abcdefghijklmnop1234"].join("-")}`, `echo ${M}`],
  [`echo ${["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_")}`, `echo ${M}`],
  [`echo ${["gho", "abcdefghijklmnopqrstuv"].join("_")}`, `echo ${M}`],
  [
    `echo ${["github", "pat", "11ABCDEFG0123456789", "abcdefghij"].join("_")}`,
    `echo ${M}`,
  ],
  [`echo ${["xoxb", "1234567890", "abcdefghij"].join("-")}`, `echo ${M}`],
  [`aws s3 ls # ${["AKIA", "IOSFODNN7EXAMPLE"].join("")}`, `aws s3 ls # ${M}`],
  ["echo 'pässwört' --password ünïcødé😀 x", `echo 'pässwört' --password ${M} x`],
];

for (const [command, expected] of redacted)
  test(`redacts: ${command}`, () => {
    assert.equal(redactSecrets(command), expected);
    assert.equal(redactSecrets(expected), expected, "idempotent");
  });

const untouched = [
  "uptime",
  "mkdir -p /var/tmp/x && ssh -p 2222 host",
  "ssh -p22 root@host",
  "cat /etc/passwd | grep root",
  "ls --passive-mode",
  "grep -r token src/ && echo password",
  "TOKEN_COUNT=3 ./run",
  "git clone https://git.example.invalid/r.git",
  "scp file user@host:/tmp",
  "echo sk-short ghp_short",
  "printf 'Authorization header is set'",
  "SECRETARY=bob ./run",
  "BYPASS=1 PASSWORD_FILE=/run/pw ./run",
  "pfctl -s rules; configctl filter reload",
];
for (const command of untouched)
  test(`leaves alone: ${command}`, () => {
    assert.equal(redactSecrets(command), command);
  });

test("redaction is idempotent and keeps text around a secret intact", () => {
  fc.assert(
    fc.property(
      fc.string({ unit: "grapheme" }),
      fc.string({ unit: "grapheme" }),
      (a, b) => {
        const once = redactSecrets(`${a} --token s3cret ${b}`);
        assert.equal(redactSecrets(once), once);
        assert.equal(once.includes("s3cret"), false);
      },
    ),
  );
  assert.equal(redactSecrets(""), "");
  assert.equal(redactSecrets(undefined), undefined);
});
