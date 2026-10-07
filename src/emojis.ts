import { nameToEmoji } from "gemoji";

export const standardEmojis = new Map(Object.entries(nameToEmoji));
export interface CustomEmoji {
  name: string;
  id: string;
  url: string;
}
export type EmojiPart =
  | { text: string }
  | { name: string; emoji: string }
  | { name: string; url: string };

// Keep the stored message intact so editing and unknown shortcodes are lossless.
export function emojiParts(body: string, custom: CustomEmoji[]): EmojiPart[] {
  const images = new Map(custom.map((e) => [e.name, e.url]));
  const parts: EmojiPart[] = [];
  let end = 0;
  for (const match of body.matchAll(/:([a-z0-9_+\-]{1,64}):/g)) {
    if (match.index > end) parts.push({ text: body.slice(end, match.index) });
    const name = match[1],
      emoji = standardEmojis.get(name),
      url = images.get(name);
    parts.push(
      emoji ? { name, emoji } : url ? { name, url } : { text: match[0] },
    );
    end = match.index + match[0].length;
  }
  if (end < body.length) parts.push({ text: body.slice(end) });
  return parts;
}
