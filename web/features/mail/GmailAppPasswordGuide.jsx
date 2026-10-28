import React from "react";
import { mailCopy as copy } from "../../lib/i18n/messages/mail.js";

export const twoStepUrl = "https://myaccount.google.com/signinoptions/twosv";
export const appPasswordsUrl = "https://myaccount.google.com/apppasswords";

function External({ href, children }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/** The three steps to a Gmail app password, shown for the Gmail preset. */
export default function GmailAppPasswordGuide() {
  const steps = copy.gmailSteps;
  return (
    <section className="mail-guide" aria-labelledby="mail-guide-title">
      <h3 id="mail-guide-title">{steps.title}</h3>
      <ol>
        <li>
          {steps.twoStep} <External href={twoStepUrl}>{steps.twoStepLink}</External>
        </li>
        <li>
          {steps.create} <External href={appPasswordsUrl}>{steps.createLink}</External>
        </li>
        <li>{steps.paste}</li>
      </ol>
    </section>
  );
}
