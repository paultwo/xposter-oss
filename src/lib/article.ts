type InlineStyle = { offset: number; length: number; style: "BOLD" | "ITALIC" };
type EntityRange = { offset: number; length: number; key: number };
type Block = {
  key: string;
  text: string;
  type: string;
  depth: number;
  inlineStyleRanges: InlineStyle[];
  entityRanges: EntityRange[];
  data: Record<string, never>;
};

export type ContentState = {
  blocks: Block[];
  entityMap: Record<
    string,
    { type: "LINK"; mutability: "MUTABLE"; data: { url: string } }
  >;
};

function blockType(line: string): { type: string; text: string } {
  if (line.startsWith("### "))
    return { type: "header-three", text: line.slice(4) };
  if (line.startsWith("## "))
    return { type: "header-two", text: line.slice(3) };
  if (line.startsWith("# ")) return { type: "header-one", text: line.slice(2) };
  if (line.startsWith("- "))
    return { type: "unordered-list-item", text: line.slice(2) };
  const ordered = /^(\d+)\. (.*)$/.exec(line);
  if (ordered?.[2] !== undefined)
    return { type: "ordered-list-item", text: ordered[2] };
  return { type: "unstyled", text: line };
}

function inlineMarkup(
  source: string,
  entityMap: ContentState["entityMap"],
  entityStart: number,
): {
  text: string;
  styles: InlineStyle[];
  entities: EntityRange[];
  nextEntity: number;
} {
  let text = "";
  const styles: InlineStyle[] = [];
  const entities: EntityRange[] = [];
  let nextEntity = entityStart;
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("**", i)) {
      const end = source.indexOf("**", i + 2);
      if (end !== -1) {
        const inner = source.slice(i + 2, end);
        styles.push({
          offset: text.length,
          length: inner.length,
          style: "BOLD",
        });
        text += inner;
        i = end + 2;
        continue;
      }
    }
    if (source[i] === "*") {
      const end = source.indexOf("*", i + 1);
      if (end !== -1) {
        const inner = source.slice(i + 1, end);
        styles.push({
          offset: text.length,
          length: inner.length,
          style: "ITALIC",
        });
        text += inner;
        i = end + 1;
        continue;
      }
    }
    if (source[i] === "[") {
      const match = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/.exec(
        source.slice(i),
      );
      if (match?.[1] && match[2]) {
        const key = nextEntity;
        nextEntity += 1;
        entityMap[String(key)] = {
          type: "LINK",
          mutability: "MUTABLE",
          data: { url: match[2] },
        };
        entities.push({ offset: text.length, length: match[1].length, key });
        text += match[1];
        i += match[0].length;
        continue;
      }
    }
    text += source[i];
    i += 1;
  }
  return { text, styles, entities, nextEntity };
}

export function markdownToContentState(markdown: string): ContentState {
  const entityMap: ContentState["entityMap"] = {};
  const blocks: Block[] = [];
  let entity = 0;
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    const typed = blockType(line);
    const inline = inlineMarkup(typed.text, entityMap, entity);
    entity = inline.nextEntity;
    blocks.push({
      key: `b${String(index).padStart(4, "0")}`,
      text: inline.text,
      type: typed.type,
      depth: 0,
      inlineStyleRanges: inline.styles,
      entityRanges: inline.entities,
      data: {},
    });
  }
  if (blocks.length === 0) {
    blocks.push({
      key: "b0000",
      text: "",
      type: "unstyled",
      depth: 0,
      inlineStyleRanges: [],
      entityRanges: [],
      data: {},
    });
  }
  return { blocks, entityMap };
}
