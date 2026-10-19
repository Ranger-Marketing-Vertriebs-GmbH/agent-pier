import React from "react";
import ChatMarkdown from "../../components/ChatMarkdown.jsx";
import { requestCopy as copy } from "../../lib/i18n/messages/requests.js";

/** The plan Claude asks to leave plan mode with (ExitPlanMode), as Markdown. */
export default function ClaudePlan({ plan }) {
  return (
    <section className="native-request-plan" aria-label={copy.plan} tabIndex={0}>
      <ChatMarkdown>{plan}</ChatMarkdown>
    </section>
  );
}
