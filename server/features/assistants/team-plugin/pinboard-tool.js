// agentpier_pinboard (agent-pinboard.js).
const id = { type: "string", maxLength: 100 };
export const pinboardDefinition = {
  pinboard: {
    description:
      'Keep files for the owner on your pinboard: named lists of files beside this chat that the owner reads, watches and pages through. Entries link to files in your workspace (path relative to it) or in a project folder granted to you (projectId, path relative to that folder); nothing is copied, and the owner always sees the file as it is now, so editing a pinned file needs no call. Actions: list; create_list (title, description); update_list (listId, title, description); pin (listId, path, projectId, name: display name, defaults to the file name, note: a short status like \'draft\' — pinning a name the list already has replaces that entry); unpin (listId, entryId or name); reorder (listId, entryIds); archive_list, reopen_list, delete_list (listId). Unpin and delete never delete files. The owner sees a pinned HTML page as built but without scripts or external resources, using only files from its own folder and subfolders; to let the owner enlarge an image, link it to the image file itself, e.g. <a href="bilder/01.png"><img src="bilder/01.png" alt="..."></a>. Up to 50 open lists of 100 entries. Tidy lists up once the owner and you are done with them. Only for the owner: refused in a restricted user\'s chat.',
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "list",
            "create_list",
            "update_list",
            "pin",
            "unpin",
            "reorder",
            "archive_list",
            "reopen_list",
            "delete_list",
          ],
        },
        listId: id,
        title: { type: "string", minLength: 1, maxLength: 120 },
        description: { type: "string", maxLength: 500 },
        path: { type: "string", minLength: 1, maxLength: 4096 },
        projectId: { type: "string", minLength: 1, maxLength: 100 },
        name: { type: "string", minLength: 1, maxLength: 200 },
        note: { type: "string", maxLength: 200 },
        entryId: id,
        entryIds: { type: "array", items: id, maxItems: 100 },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
};
