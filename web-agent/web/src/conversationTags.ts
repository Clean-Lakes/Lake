import type { WorkspaceTag } from "../../shared/contracts";

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hName?: string; hProperties?: Record<string, string> };
};

export function conversationTagSignature(tags: readonly WorkspaceTag[] = []) {
  return JSON.stringify(tags.map(({id, name, color}) => [id, name, color]));
}

// Decorate prose after parsing Markdown, so commands, code, links and destinations
// retain their exact text and behavior. Only tags assigned to this session apply.
export function remarkConversationTags(tags: readonly WorkspaceTag[]) {
  const names = [...tags].filter(tag => tag.name.trim()).sort((a, b) => b.name.length - a.name.length);
  const pattern = names.length ? new RegExp(names.map(tag => tag.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi") : null;
  const byName = new Map(names.map(tag => [tag.name.toLowerCase(), tag]));
  return () => (tree: MarkdownNode) => {
    if (!pattern) return;
    function decorate(node: MarkdownNode) {
      if (!node.children || ["link", "linkReference", "code", "inlineCode", "html", "image", "imageReference"].includes(node.type)) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== "text" || !child.value) { decorate(child); return [child]; }
        const text = child.value;
        const pieces: MarkdownNode[] = [];
        let offset = 0;
        for (const match of text.matchAll(pattern!)) {
          const at = match.index!;
          const end = at + match[0].length;
          // Avoid changing parts of English identifiers, filenames or paths.
          if (/^[\w]/.test(match[0]) && /[\w/@.\-]/.test(text[at - 1] || "") ||
              /[\w]$/.test(match[0]) && /[\w/@\-]/.test(text[end] || "") ||
              text[end] === "." && /\w/.test(text[end + 1] || "")) continue;
          const tag = byName.get(match[0].toLowerCase())!;
          if (at > offset) pieces.push({type: "text", value: text.slice(offset, at)});
          pieces.push({type: "sessionTag", data: {hName: "span", hProperties: {className: `conversation-tag color-${tag.color}`, "data-tag-id": tag.id}}, children: [{type: "text", value: match[0]}]});
          offset = end;
        }
        if (!pieces.length) return [child];
        if (offset < text.length) pieces.push({type: "text", value: text.slice(offset)});
        return pieces;
      });
    }
    decorate(tree);
  };
}
