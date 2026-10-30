/** English counterpart of de/project-groups.js with identical keys. */
export const projectGroups = Object.freeze({
  invalidDocument:
    "Groups must come as a document with a version, groups and assignments.",
  invalidName:
    "A group name must be 1 to 60 characters long and contain no control characters.",
  nameTaken: "A group with this name already exists.",
  unknownGroup: "This group does not exist (any more).",
  invalidAssignment:
    "A project can only be assigned to an existing group by its absolute path.",
  tooMany: "At most 200 groups and 5000 assignments are possible.",
  conflict:
    "The groups were changed elsewhere in the meantime. The current version is loaded.",
});
