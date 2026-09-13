import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/** Browser terminal input followed by HTTP chat, all inside the owned native fixture. */
export async function probeTerminalChat({ fixture, session, capture, waitFor, counts }) {
  const manager = fixture.application.sessions;
  let output = "";
  const client = await manager.attach(session.id, {
    onData: (text) => (output += text),
  });
  try {
    await waitFor(
      () => output,
      (text) => text.includes("\x1b[?2004h"),
    );
    const terminalMarker = "AP_PROBE_TERMINAL_SUBMIT";
    const text = `${terminalMarker}\n${"Long synthetic terminal draft. ".repeat(80)}`;
    await client.write(`\x1b[200~${text}\x1b[201~`);
    await waitFor(capture, (screen) => /Pasted|Long synthetic/.test(screen));
    await client.write("\r");
    await waitFor(capture, (screen) =>
      screen.includes(`Synthetic response complete: ${terminalMarker}`),
    );
    const body = {
      deliveryId: randomUUID(),
      deliveryScope: JSON.stringify([
        session.id,
        session.accountId,
        session.tool,
        session.createdAt || null,
      ]),
      text: "AP_PROBE_CHAT_AFTER_TERMINAL",
      submit: true,
    };
    const before = { ...counts };
    const send = async () =>
      (
        await fixture.request(`/api/sessions/${session.id}/input`, {
          method: "POST",
          body,
        })
      ).json();
    assert.equal((await send()).status, "handed-off");
    assert.equal((await send()).status, "handed-off");
    await waitFor(capture, (screen) =>
      screen.includes(`Synthetic response complete: ${body.text}`),
    );
    assert.equal(counts.paste - before.paste, 1);
    assert.equal(counts.submit - before.submit, 1);
    return { afterLongTerminalSubmit: true, paste: 1, submit: 1, replayWrites: 0 };
  } finally {
    client.dispose();
  }
}
