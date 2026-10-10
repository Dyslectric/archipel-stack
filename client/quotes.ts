import { markdownQuote } from "./markdown.js";

export interface QuotePart { body: string; answer: string }
export function partitionQuote(parts: QuotePart[], index: number, at: number): QuotePart[] {
  const part = parts[index];
  if (!part || !part.body.slice(0, at).trim() || !part.body.slice(at).trim()) return parts;
  return [...parts.slice(0, index),
    { body: part.body.slice(0, at).trimEnd(), answer: "" },
    { body: part.body.slice(at).trimStart(), answer: part.answer },
    ...parts.slice(index + 1)];
}
export function quotedReply(parts: QuotePart[], draft: string) {
  return [...parts.flatMap(part => [part.body.trim() ? markdownQuote(part.body) : "", part.answer]), draft]
    .filter(text => text.trim()).join("\n\n");
}
