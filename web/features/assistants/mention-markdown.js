import { splitMentions } from "../../../server/features/assistants/member-mentions.js";

// A remark plugin that turns @mentions of the lead's members in an owner message
// into `member-mention` elements, parsed exactly as the server's write proof does.
// Code and the text of links stay as they are.
const skip = new Set(["link", "linkReference", "inlineCode", "code", "html"]);
export function remarkMemberMentions(members) {
  function walk(node) {
    if (!node.children || skip.has(node.type)) return;
    node.children = node.children.flatMap((child) => {
      if (child.type !== "text") {
        walk(child);
        return [child];
      }
      const parts = splitMentions(child.value, members);
      if (parts.every((part) => typeof part === "string")) return [child];
      return parts.map((part) =>
        typeof part === "string"
          ? { type: "text", value: part }
          : {
              type: "memberMention",
              data: {
                hName: "member-mention",
                hProperties: { member: part.memberId },
                hChildren: [{ type: "text", value: part.mention }],
              },
            },
      );
    });
  }
  return () => walk;
}
