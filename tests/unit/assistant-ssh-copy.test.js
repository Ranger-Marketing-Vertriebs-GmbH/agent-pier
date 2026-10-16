import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";

test("agent SSH copy exists in both languages with the keys later tasks use", async () => {
  const { assistantSshCopy } =
    await import("../../web/lib/i18n/messages/assistant-ssh.js");
  const { assistantTeamCopy } =
    await import("../../web/lib/i18n/messages/assistant-team.js");
  const { telegramSendersCopy } =
    await import("../../web/lib/i18n/messages/telegram-senders.js");
  const { routineCopy } =
    await import("../../web/lib/i18n/messages/assistant-routines.js");
  setLanguage("en");
  assert.equal(assistantSshCopy.summary(1, 0), "1 host");
  assert.equal(assistantSshCopy.summary(3, 2), "3 hosts · 2 trusted");
  assert.deepEqual(Object.keys(assistantSshCopy.modes), [
    "approval",
    "trusted",
    "routines",
  ]);
  assert.equal(assistantSshCopy.card.states.unknown, "Outcome unknown after a restart");
  assert.equal(
    assistantTeamCopy.internalTurns["ssh-result"],
    "SSH command result received.",
  );
  assert.match(telegramSendersCopy.sshBlocked, /SSH accesses/);
  assert.match(routineCopy.sshRefused, /^SSH refused/);
  setLanguage("de");
  assert.equal(assistantSshCopy.summary(1, 1), "1 Host · 1 vertraut");
  assert.equal(assistantTeamCopy.internalTurns["ssh-result"].length > 0, true);
  assert.match(telegramSendersCopy.sshBlocked, /SSH-Zugänge/);
  assert.match(routineCopy.sshRefused, /^SSH abgelehnt/);
});
