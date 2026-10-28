import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";

// The live channel end to end, against the isolated test server (no stub): a loaded
// page reads the workspace state only through the `state` topic, and a write from
// elsewhere reaches the open page as a push.
test.use({ live: "real", locale: "en-GB" });

const resume = "Resume interrupted sessions automatically";
const setAutoResume = (page, value) =>
  page.request.patch(baseURL + "/api/preferences", {
    data: { autoResumeInterrupted: value },
    headers: { origin: new URL(baseURL).origin },
  });

test("a loaded page polls no state and follows a preference written elsewhere", async ({
  page,
}) => {
  test.setTimeout(30000);
  const stateReads = [];
  page.on("request", (request) => {
    if (request.method() === "GET" && new URL(request.url()).pathname === "/api/state")
      stateReads.push(request.url());
  });
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.goto(baseURL + "/settings");
  const toggle = page.getByRole("switch", { name: resume });
  await expect(toggle).toBeChecked();
  await page.waitForTimeout(10000);
  expect(stateReads).toEqual([]);
  // Later specs share the server: the default is restored in `finally`. A failed
  // restore is logged there, so it never hides a failure above, and asserted after.
  let restoreProblem = "";
  try {
    const answer = await setAutoResume(page, false);
    expect(answer.ok()).toBe(true);
    await expect(toggle).not.toBeChecked({ timeout: 2000 });
  } finally {
    try {
      const restored = await setAutoResume(page, true);
      if (!restored.ok()) restoreProblem = `status ${restored.status()}`;
    } catch (error) {
      restoreProblem = error.message;
    }
    if (restoreProblem)
      console.error(
        `live-end-to-end: could not restore the preference: ${restoreProblem}`,
      );
  }
  expect(restoreProblem).toBe("");
});
