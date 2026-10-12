import { formatNumber } from "../../lib/i18n/index.js";

const UNITS = [
  ["gigabyte", 1073741824, 1],
  ["megabyte", 1048576, 1],
  ["kilobyte", 1024, 0],
];
/** A backup or upload size in the active locale, such as "1.2 MB". */
export function backupSize(bytes = 0) {
  const [unit, size, digits] = UNITS.find(([, size]) => bytes >= size) || ["byte", 1, 0];
  return formatNumber(bytes / size, {
    style: "unit",
    unit,
    maximumFractionDigits: digits,
  });
}
