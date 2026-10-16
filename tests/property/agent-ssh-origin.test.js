import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  permits,
  sshModes,
  sshOrigin,
} from "../../server/features/assistants/agent-ssh-origin.js";

const kinds = fc.constantFrom(
  "owner",
  "telegram",
  "lead-request",
  "team-member",
  "ssh-result",
  "member-result",
  "reminder",
  "heartbeat",
  "other",
);
const context = fc.option(
  fc.record({ kind: kinds, forwarded: fc.boolean() }, { requiredKeys: ["kind"] }),
  { nil: null },
);

test("routines only ever run on routines hosts and refused turns never act", () => {
  fc.assert(
    fc.property(
      context,
      fc.boolean(),
      fc.boolean(),
      fc.constantFrom("owner", "delegated", "routine", "refused", null),
      fc.constantFrom(...sshModes, "always", ""),
      (ctx, routine, permanentMember, inherited, mode) => {
        const c = sshOrigin({ context: ctx, routine, permanentMember, inherited }).class;
        const verdict = permits(mode, c);
        if (c === "routine") {
          assert.notEqual(verdict, "card");
          assert.equal(verdict === "run", mode === "routines");
        }
        if (c === "refused") assert.equal(verdict, "refuse");
        if (!sshModes.includes(mode)) assert.equal(verdict, "refuse");
        if (!routine && ctx?.forwarded && ["owner", "telegram"].includes(ctx.kind))
          assert.equal(c, "refused");
      },
    ),
    { seed: Number(process.env.FC_SEED || 86016), numRuns: 500 },
  );
});
