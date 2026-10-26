import { expect } from "@playwright/test";

// The new agent wizard (web/features/assistants/wizard/) in both languages.
const labels = {
  en: {
    next: "Next",
    skip: "Skip",
    create: "Create agent",
    talk: /^Conversation partner/,
  },
  de: {
    next: "Weiter",
    skip: "Überspringen",
    create: "Agent anlegen",
    talk: /^Gesprächspartner/,
  },
};

export const wizardNext = (page, language = "en") =>
  page.getByRole("button", { name: labels[language].next, exact: true }).click();

/** From the Start step to Identity & model (blank start). */
export async function wizardToIdentity(page, language = "en") {
  await expect(
    page.getByRole("heading", { name: "Start", level: 2, exact: true }),
  ).toBeVisible();
  await wizardNext(page, language);
}

/**
 * From Identity & model to "Create agent": the "Conversation partner" profile (no
 * capabilities step) unless `keepProfile`, Access and Channels skipped.
 */
export async function wizardFinish(page, { language = "en", keepProfile = false } = {}) {
  const text = labels[language];
  await wizardNext(page, language);
  if (!keepProfile) await page.getByRole("radio", { name: text.talk }).check();
  await wizardNext(page, language);
  await page.getByRole("button", { name: text.skip, exact: true }).click();
  await page.getByRole("button", { name: text.skip, exact: true }).click();
  await page.getByRole("button", { name: text.create, exact: true }).click();
}
