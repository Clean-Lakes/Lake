type ProseNode = {
  type: string;
  value?: string;
  children?: ProseNode[];
  position?: {start: {offset?: number}; end: {offset?: number}};
  data?: {hProperties?: Record<string, unknown>};
};

// Recover a common generated-label typo after Markdown parsing. Restrict this
// to literal prose with a colon: code, links, escaped Markdown and raw HTML are
// never rewritten, and the stored response remains unchanged.
export function remarkAssistantProse() {
  return (tree: ProseNode, file: {value: unknown}) => {
    const source = String(file.value ?? "");
    function visit(node: ProseNode) {
      if (!node.children || ["code", "inlineCode", "link", "linkReference", "image", "imageReference", "html"].includes(node.type)) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== "text" || !child.value) { visit(child); return [child]; }
        const {start, end} = child.position ?? {};
        if (start?.offset === undefined || end?.offset === undefined || source.slice(start.offset, end.offset) !== child.value) return [child];
        const text = child.value;
        const pieces: ProseNode[] = [];
        let offset = 0;
        for (const match of text.matchAll(/\*\*([^\s*][^*\n]{0,79}?[：:])([ \t]+)\*\*/gu)) {
          const at = match.index!;
          if (at > offset) pieces.push({type: "text", value: text.slice(offset, at)});
          pieces.push({type: "strong", children: [{type: "text", value: match[1]}]}, {type: "text", value: match[2]});
          offset = at + match[0].length;
        }
        if (!pieces.length) return [child];
        if (offset < text.length) pieces.push({type: "text", value: text.slice(offset)});
        return pieces;
      });
      if (node.type === "paragraph") {
        const first = node.children.find(child => child.type !== "text" || child.value?.trim());
        const label = first?.type === "strong" && first.children?.every(child => child.type === "text") ? first.children.map(child => child.value ?? "").join("") : "";
        if (/^(结论|综合结论|小结)[：:]?$/.test(label)) {
          node.data = {...node.data, hProperties: {...node.data?.hProperties, className: "assistant-summary"}};
        }
      }
    }
    visit(tree);
  };
}
