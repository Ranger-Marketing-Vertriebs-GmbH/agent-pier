/** English counterpart of de/session-transfer.js with identical keys. */
export const sessionTransfer = Object.freeze({
  unsafePath: "Unsafe conversation history path.",
  unsafeLink: "Unsafe symbolic or hard link in conversation history.",
  unsafeDirectory: "Unsafe conversation history directory.",
  unsafeFile: "Unsafe conversation history file.",
  tooLarge: "Conversation history is too large to transfer.",
  sharedStorage: "The accounts share the same CLI storage.",
  notTransferable: "Native conversation history cannot be transferred.",
  changedDuringPreparation: "Conversation history changed during transfer preparation.",
  targetDiffers: "The target account contains different conversation history.",
  incomplete: "Conversation history is incomplete. Try again when the CLI is idle.",
  identityMismatch: "Conversation history identity does not match this session.",
  notPortable: "Conversation history format is incomplete or not portable.",
  targetChanged: "The target conversation changed during transfer.",
  codexStorageUnsupported:
    "This Codex history storage format does not expose a portable conversation. The account was not changed.",
});
