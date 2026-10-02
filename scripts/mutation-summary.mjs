import fs from "node:fs";

const statuses = [
  "Killed",
  "Timeout",
  "Survived",
  "NoCoverage",
  "CompileError",
  "RuntimeError",
  "Ignored",
];
const counts = () => Object.fromEntries(statuses.map((status) => [status, 0]));
function row(name, values) {
  const detected = values.Killed + values.Timeout;
  const total = detected + values.Survived + values.NoCoverage;
  const score = total ? `${((detected / total) * 100).toFixed(2)}%` : "n/a";
  return `| ${name} | ${score} | ${values.Killed} | ${values.Timeout} | ${values.Survived} | ${values.NoCoverage} | ${values.CompileError + values.RuntimeError} | ${values.Ignored} |`;
}

try {
  const report = JSON.parse(
    fs.readFileSync(process.argv[2] || "coverage/mutation/mutation.json", "utf8"),
  );
  if (!report.files || !Object.keys(report.files).length)
    throw new Error("No files in mutation report.");
  const total = counts();
  const rows = Object.entries(report.files).map(([file, { mutants }]) => {
    const values = counts();
    for (const { status } of mutants) {
      if (!Object.hasOwn(values, status))
        throw new Error(`Unknown mutation status: ${status}`);
      values[status]++;
      total[status]++;
    }
    return row(file.replace(/[|\r\n]/g, " "), values);
  });
  console.log(
    [
      "## Mutation pilot",
      "",
      "Results cover only the configured pilot scope and selected tests, not the entire application.",
      "",
      "| Module | Score | Killed | Timeout | Survived | No coverage | Errors | Ignored |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...rows,
      row("**Total**", total),
      "",
      "Score counts killed and timed-out mutants as detected; errors and ignored mutants are excluded. Review timeouts separately from assertion failures.",
      "",
      "Download the mutation-report artifact and open index.html for individual mutants. There is no score gate during the pilot.",
    ].join("\n"),
  );
} catch (error) {
  console.error(`Cannot summarize mutation report: ${error.message}`);
  process.exitCode = 1;
}
