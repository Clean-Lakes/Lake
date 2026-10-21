type ProseNode = {
  type: string;
  value?: string;
  children?: ProseNode[];
  position?: {start: {offset?: number}; end: {offset?: number}};
  data?: {hProperties?: Record<string, unknown>};
};

// Models sometimes use the legal section shorthand in Chinese document
// references. Spell it out in prose without changing stored Markdown or code.
function sectionReferences(text: string): string {
  return text.replace(/(^|[^\\\p{Script=Latin}\p{N}_§])§[ \t]*(\d+(?:\.\d+)*)(?![\p{Script=Latin}\p{N}_])/gu, '$1第 $2 节');
}

// Recover unparsed generated strong delimiters in Chinese prose and short
// colon labels. Operate on exact literal source spans after Markdown parsing:
// code, links, escapes and already parsed formatting remain untouched.
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
        for (const match of text.matchAll(/\*\*(?!\*)([^\s*][^*\n]{0,4095}?)\*\*(?!\*)/gu)) {
          const at=match.index!;
          if(text[at-1]==='*')continue;
          const body=match[1]!.replace(/[ \t]+$/u,'');
          const trailing=match[1]!.slice(body.length);
          // English literal-star expressions remain literal. Long Chinese
          // conclusions and punctuation next to Chinese quotes are common
          // generated prose, not restricted to an 80-character colon label.
          if(!/\p{Script=Han}/u.test(body)&&!(trailing&&body.length<=80&&/[：:]$/u.test(body)))continue;
          if (at > offset) pieces.push({type: "text", value: text.slice(offset, at)});
          pieces.push({type: "strong", children: [{type: "text", value: body}]});
          if(trailing)pieces.push({type:'text',value:trailing});
          offset = at + match[0].length;
        }
        if (!pieces.length) return [{...child, value: sectionReferences(text)}];
        if (offset < text.length) pieces.push({type: "text", value: text.slice(offset)});
        for (const piece of pieces) {
          if (piece.type === 'text') piece.value = sectionReferences(piece.value ?? '');
          else for (const text of piece.children ?? []) text.value = sectionReferences(text.value ?? '');
        }
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
