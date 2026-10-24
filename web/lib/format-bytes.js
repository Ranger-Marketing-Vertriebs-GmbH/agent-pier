// Byte sizes as short local units (artifacts, SFTP transfers).
/** "9.2 MB", "1 GB"; binary multiples as the storage limit is 1 GiB. */
export function formatBytes(bytes, locale) {
  const value = Math.max(0, Number(bytes) || 0);
  const [unit, size] =
    value >= 1024 ** 3
      ? ["gigabyte", 1024 ** 3]
      : value >= 1024 ** 2
        ? ["megabyte", 1024 ** 2]
        : value >= 1024
          ? ["kilobyte", 1024]
          : ["byte", 1];
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: 1,
  }).format(value / size);
}
