import { treeMentions } from "../../../server/features/assistants/member-mentions.js";

// A remark plugin that turns @mentions of the lead's members in an owner message
// into `member-mention` elements. It finds them with the server's own
// `treeMentions`, on the same Markdown tree, so a chip appears exactly where a
// mention can count: never in code, block quotes, links, images or HTML, never from
// a character reference or an escape, and only in messages small enough to count.
// Ambiguous mentions stay plain text.
const chip = (text, memberId) => ({
  type: "memberMention",
  data: {
    hName: "member-mention",
    hProperties: { member: memberId },
    hChildren: [{ type: "text", value: text }],
  },
});
export function remarkMemberMentions(members) {
  return () => (tree, file) => {
    const found = treeMentions(tree, members, String(file?.value ?? ""));
    // Last first, so earlier positions in a parent stay valid while splicing.
    for (const { parent, node, mentions } of found.reverse()) {
      const parts = [];
      let from = 0;
      for (const m of mentions) {
        if (m.ambiguous) continue;
        if (m.start > from)
          parts.push({ type: "text", value: node.value.slice(from, m.start) });
        parts.push(chip(node.value.slice(m.start, m.end), m.memberId));
        from = m.end;
      }
      if (!parts.length) continue;
      if (from < node.value.length)
        parts.push({ type: "text", value: node.value.slice(from) });
      parent.children.splice(parent.children.indexOf(node), 1, ...parts);
    }
  };
}
