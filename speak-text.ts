/** Prepare Markdown message text for a natural verbatim read-aloud. */
export function prepareSpeechText(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const cleaned: string[] = [];
  let fence: { character: string; length: number } | null = null;

  for (let line of lines) {
    if (fence) {
      const closing = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
      if (
        closing &&
        closing[1][0] === fence.character &&
        closing[1].length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }

    const opening = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (opening) {
      fence = { character: opening[1][0], length: opening[1].length };
      continue;
    }

    const tableCells = line.trim().replace(/^\||\|$/g, "").split("|");
    if (
      /^\s{0,3}(?:=+|-+)\s*$/.test(line) ||
      (tableCells.length > 1 &&
        tableCells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell)))
    ) {
      continue;
    }

    line = line
      .replace(/!\[[^\]]*\]\((?:\\.|[^)])*\)/g, "")
      .replace(/!\[[^\]]*\]\[[^\]]*\]/g, "")
      .replace(/\[([^\]]+)\]\((?:\\.|[^)])*\)/g, "$1")
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
      .replace(/(`+)(.*?)\1/g, "$2")
      .replace(/<(?:https?:\/\/|www\.)[^>]+>/gi, "")
      .replace(/(?:https?:\/\/|www\.)[^\s<]+/gi, "")
      .replace(/<\/?[A-Za-z][^>]*>/g, "")
      .replace(/^\s*(?:>\s*)+/, "")
      .replace(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/, "$1")
      .replace(/^\s*(?:[-+*]|\d+[.)])\s+/, "")
      .replace(/^\s*\[[ xX]\]\s+/, "")
      .replace(/~~(?=\S)(.*?\S)~~/g, "$1")
      .replace(/\*\*(?=\S)(.*?\S)\*\*/g, "$1")
      .replace(/(^|[^\p{L}\p{N}_])__(?=\S)(.*?\S)__(?![\p{L}\p{N}_])/gu, "$1$2")
      .replace(/\*(?=\S)(.*?\S)\*/g, "$1")
      .replace(/(^|[^\p{L}\p{N}_])_(?=\S)(.*?\S)_(?![\p{L}\p{N}_])/gu, "$1$2")
      .replace(/\s*\|\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    cleaned.push(line);
  }

  return cleaned
    .join("\n")
    .split(/\n\s*\n+/)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" "),
    )
    .filter(Boolean)
    .join("\n\n");
}

function splitOversizedText(text: string, max: number): string[] {
  const parts: string[] = [];
  let current = "";

  for (const word of text.match(/\S+/g) ?? []) {
    if (word.length > max) {
      if (current) {
        parts.push(current);
        current = "";
      }
      for (let offset = 0; offset < word.length; offset += max) {
        const slice = word.slice(offset, offset + max);
        if (slice.length === max) parts.push(slice);
        else current = slice;
      }
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= max) current = candidate;
    else {
      parts.push(current);
      current = word;
    }
  }

  if (current) parts.push(current);
  return parts;
}

function splitLongParagraph(paragraph: string, max: number): string[] {
  const sentences = paragraph.match(/[^.!?]+(?:[.!?]+["'”’)\]]*)?|[.!?]+/g) ?? [paragraph];
  const pieces = sentences.flatMap((sentence) => {
    const trimmed = sentence.trim();
    return trimmed.length <= max ? [trimmed] : splitOversizedText(trimmed, max);
  });
  const chunks: string[] = [];
  let current = "";

  for (const piece of pieces) {
    if (!piece) continue;
    const candidate = current ? `${current} ${piece}` : piece;
    if (candidate.length <= max) current = candidate;
    else {
      if (current) chunks.push(current);
      current = piece;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

/** Split prepared speech into ordered Realtime requests bounded by `max`. */
export function chunkSpeechText(text: string, max = 700): string[] {
  if (!Number.isFinite(max) || max < 1) throw new RangeError("max must be at least 1");
  max = Math.floor(max);
  const paragraphs = text
    .trim()
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return [];

  const chunks: string[] = [];
  let current = "";

  paragraphs.forEach((paragraph, paragraphIndex) => {
    const pieces = paragraph.length <= max ? [paragraph] : splitLongParagraph(paragraph, max);
    pieces.forEach((piece, pieceIndex) => {
      const separator = paragraphIndex > 0 && pieceIndex === 0 ? "\n\n" : " ";
      const candidate = current ? `${current}${separator}${piece}` : piece;
      if (candidate.length <= max) current = candidate;
      else {
        if (current) chunks.push(current);
        current = piece;
      }
    });
  });

  if (current) chunks.push(current);
  return chunks;
}
