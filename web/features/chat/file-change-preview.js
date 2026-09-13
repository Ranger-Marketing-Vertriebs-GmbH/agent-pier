export function changePreview(files, limit) {
  let budget = limit,
    chars = limit === 8 ? 4000 : Math.min(200000, limit * 100);
  const visible = [];
  let truncated = false;
  for (const file of files) {
    // Headers also consume the shared budget, including metadata-only changes.
    if (budget <= 0 || chars <= 0) {
      truncated = true;
      break;
    }
    budget--;
    const rows = [];
    for (const row of file.rows) {
      if (budget <= 0 || chars <= 0) {
        truncated = true;
        break;
      }
      const text = row.text.slice(0, chars);
      rows.push({ ...row, text });
      budget--;
      chars -= text.length + 1;
      if (text.length < row.text.length) {
        truncated = true;
        break;
      }
    }
    visible.push({ ...file, rows });
    if (truncated) break;
  }
  return { files: visible, truncated };
}
