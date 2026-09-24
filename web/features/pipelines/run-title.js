const titleLimit = 160;
// The first task line is the run's headline: markdown heading marks are dropped,
// whitespace is collapsed and long headlines end with an ellipsis.
export function runTitle(run) {
  const headline = (run.task || "")
    .trim()
    .split(/\r?\n/, 1)[0]
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+/g, " ");
  const title =
    headline.length > titleLimit ? headline.slice(0, 157).trimEnd() + "…" : headline;
  return title || run.pipelineName || "";
}
