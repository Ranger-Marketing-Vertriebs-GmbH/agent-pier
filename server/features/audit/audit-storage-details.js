// Data directory cleanups (storage-cleanup.js): which area, how many entries and how
// many bytes went, the age chosen for transcripts. Never a path, name or content.
const areas = ["update-backup", "transcripts", "dependencies"];
const count = (value) => Number.isSafeInteger(value) && value >= 0;

export function storageAuditDetails(details, event) {
  if (areas.includes(details.area)) event.details.area = details.area;
  for (const key of ["removed", "skipped", "bytes"])
    if (count(details[key])) event.details[key] = details[key];
  if ([30, 90, 180].includes(details.olderThanDays))
    event.details.olderThanDays = details.olderThanDays;
}
