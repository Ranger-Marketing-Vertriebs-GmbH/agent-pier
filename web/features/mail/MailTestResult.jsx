import React from "react";
import StatusChip from "../../components/StatusChip.jsx";
import { mailCopy as copy } from "../../lib/i18n/messages/mail.js";
import { mailSides } from "./mail-account-form.js";

/**
 * One side of a test: a fresh result (`{ ok, code? }`) or a stored one (`"ok"` or a
 * `MAIL_*` code). Server text never reaches the browser; only the code does.
 */
export function sideOutcome(value) {
  if (value === "ok" || value?.ok === true) return { ok: true };
  const code = typeof value === "string" ? value : value?.code;
  return { ok: false, code: typeof code === "string" ? code : "MAIL_PROTOCOL" };
}

export const testPassed = (result) =>
  Boolean(result) && mailSides.every((side) => sideOutcome(result[side]).ok);

/** The IMAP and SMTP lines of a connection test, each with its status chip. */
export default function MailTestResult({ result }) {
  if (!result) return null;
  return (
    <ul className="mail-test-result" aria-label={copy.testTitle}>
      {mailSides.map((side) => {
        const outcome = sideOutcome(result[side]);
        return (
          <li key={side}>
            <StatusChip tone={outcome.ok ? "ok" : "error"}>
              {outcome.ok
                ? copy.signedIn[side]
                : copy.failedSide(
                    copy[side],
                    copy.codes[outcome.code] ?? copy.codes.MAIL_PROTOCOL,
                  )}
            </StatusChip>
          </li>
        );
      })}
    </ul>
  );
}
