import path from "node:path";
import { test } from "@playwright/test";

/** Only AGENTPIER_UPDATE_DOC_SCREENSHOTS=1 refreshes the images under docs/. */
export const updateDocScreenshots = process.env.AGENTPIER_UPDATE_DOC_SCREENSHOTS === "1";

/**
 * Where a spec saves a screenshot that the documentation shows. Normal runs keep
 * the checked-in images untouched and write into the test's output folder. Specs
 * name the full docs path so the affected-test graph still links image and spec.
 */
export function docScreenshot(file) {
  return updateDocScreenshots ? file : test.info().outputPath(path.basename(file));
}
