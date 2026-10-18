import { formatNumber, formatTimestamp } from "../../lib/i18n/index.js";

const UNITS = [
  ["terabyte", 1024 ** 4, 1],
  ["gigabyte", 1024 ** 3, 1],
  ["megabyte", 1024 ** 2, 0],
  ["kilobyte", 1024, 0],
];
/** A size in the active locale, such as "1.2 GB". */
export function statusBytes(bytes = 0) {
  const [unit, size, digits] = UNITS.find(([, size]) => bytes >= size) || ["byte", 1, 0];
  return formatNumber(bytes / size, {
    style: "unit",
    unit,
    maximumFractionDigits: digits,
  });
}
/** A share from 0 to 100 as a locale percentage, such as "42 %". */
export function statusPercent(value, digits = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  return formatNumber(value / 100, { style: "percent", maximumFractionDigits: digits });
}
export function statusNumber(value, digits = 2) {
  return formatNumber(value, { maximumFractionDigits: digits });
}
export const statusTime = (value) => formatTimestamp(value);
/** The used share of the disk bar; an unknown free share stays unknown ("–"). */
export const diskUsedPercent = (disk) =>
  Number.isFinite(disk?.freePercent) ? 100 - disk.freePercent : null;
/** An answer with every figure the row needs; anything else counts as no answer. */
export const usableStatus = (data) =>
  data &&
  typeof data === "object" &&
  ["disk", "cpu", "memory", "warning", "agentPier"].every(
    (key) => data[key] && typeof data[key] === "object",
  )
    ? data
    : null;
export const clampPercent = (value) =>
  Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
