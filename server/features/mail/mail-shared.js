// Small rules the mail modules (and agent mail) share, each defined once.

/** A C0 control character or DEL: never in a folder, name or other agent input. */
export const controlChar = /[\u0000-\u001f\u007f]/;

/** controlChar or a Unicode line or paragraph separator: never in a header line. */
export const headerControlChar = /[\u0000-\u001f\u007f\u2028\u2029]/;

/** A programming error (a caller's bug), never a server's answer: it must surface. */
export const isBug = (error) =>
  error instanceof TypeError || error instanceof ReferenceError;

/**
 * A BODYSTRUCTURE node's decoded size estimate: base64 carries 3 bytes in 4
 * characters; any other encoding counts as it is stored.
 */
export const decodedEstimate = (node) =>
  String(node?.encoding ?? "").toLowerCase() === "base64"
    ? Math.floor(((Number(node.size) || 0) * 3) / 4)
    : Number(node?.size) || 0;

/** Whether a node is marked `Content-Disposition: attachment` (any case). */
export const markedAttachment = (node) =>
  String(node?.disposition ?? "").toLowerCase() === "attachment";
