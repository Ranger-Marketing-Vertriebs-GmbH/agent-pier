import React, { useState } from "react";
import { assistantCopy as copy } from "../../../lib/i18n/messages/assistants.js";
import { assistantApi } from "../assistant-api.js";

/**
 * One member's report in a team card. The team list carries an excerpt; a longer
 * report loads whole when it is opened. `shortened` is the note for a report stored
 * incomplete.
 */
export default function TeamReport({ teamId, report, shortened }) {
  const [whole, setWhole] = useState(null);
  const load = async () => {
    if (!report.truncated || whole !== null) return;
    try {
      setWhole((await assistantApi.teamReport(teamId, report.memberId)).text);
    } catch {
      /* The excerpt stays; a later open retries. */
    }
  };
  return (
    <details
      className="assistant-team-report"
      onToggle={(event) => event.currentTarget.open && load()}
    >
      <summary>{copy.team.report}</summary>
      <p>
        {whole ?? report.text}
        {report.truncated && whole === null && "…"}
      </p>
      {report.cut && shortened}
    </details>
  );
}
