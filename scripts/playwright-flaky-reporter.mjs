import fs from "node:fs";
import path from "node:path";

// Playwright retries a failed test once in CI. A test that passes only on its
// retry is flaky: list it in the job summary and annotate it, so a retry absorbs
// the failure without hiding it.
export function flakyMarkdown(entries) {
  if (!entries.length) return "";
  return [
    "### Browser tests that passed only on retry",
    "",
    "| Test | Project | Failed attempts |",
    "| --- | --- | --- |",
    ...entries.map(
      ({ location, title, project, failures }) =>
        `| \`${location}\` ${title.replaceAll("|", "\\|")} | ${project} | ${failures} |`,
    ),
    "",
  ].join("\n");
}

export default class FlakyReporter {
  constructor({ summaryFile = process.env.GITHUB_STEP_SUMMARY, log = console.log } = {}) {
    this.summaryFile = summaryFile;
    this.log = log;
    this.entries = [];
  }

  printsToStdio() {
    return false;
  }

  onTestEnd(test) {
    if (test.outcome() !== "flaky") return;
    const location = `${path.relative(process.cwd(), test.location.file)}:${test.location.line}`;
    const entry = {
      location,
      title: test.titlePath().slice(3).join(" › "),
      project: test.parent.project()?.name || "",
      failures: test.results.filter((result) => result.status !== "passed").length,
    };
    this.entries.push(entry);
    this.log(`FLAKY (passed on retry): ${location} ${entry.title}`);
    if (process.env.GITHUB_ACTIONS === "true")
      this.log(
        `::warning file=${location.replace(/:\d+$/, "")},line=${test.location.line}::Passed only on retry: ${entry.title}`,
      );
  }

  onEnd() {
    const markdown = flakyMarkdown(this.entries);
    if (markdown && this.summaryFile)
      fs.appendFileSync(this.summaryFile, `${markdown}\n`);
  }
}
