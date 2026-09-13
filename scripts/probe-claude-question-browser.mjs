import { chromium, expect } from "@playwright/test";

/** The actual built UI and HTTP broker, without API fixture routes. */
export async function answerQuestionInBrowser(fixture, session) {
  const browser = await chromium.launch({
    headless: true,
    ...(process.platform === "darwin" ? { channel: "chrome" } : {}),
  });
  try {
    const context = await browser.newContext({
      locale: "en-GB",
      viewport: { width: 390, height: 700 },
    });
    await context.addCookies([
      {
        name: "agentpier_session",
        value: fixture.cookie.slice("agentpier_session=".length),
        url: fixture.url,
      },
    ]);
    const page = await context.newPage();
    await page.goto(`${fixture.url}/sessions/${session.id}/chat`);
    await page.getByRole("checkbox", { name: "API", exact: true }).check();
    await page.getByRole("checkbox", { name: "Web", exact: true }).check();
    await page.getByRole("button", { name: "Next question", exact: true }).click();
    await page.getByRole("radio", { name: "Other answer", exact: true }).check();
    await page
      .getByRole("textbox", {
        name: "Other answer: Where should the result be saved?",
        exact: true,
      })
      .fill("Custom destination ü\nsecond line");
    await page.getByRole("button", { name: "Send answer", exact: true }).click();
    await expect(page.locator(".native-request")).toHaveCount(0);
  } finally {
    await browser.close();
  }
}
