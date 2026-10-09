import { nameToEmoji } from "gemoji";

export const standardEmojis = new Map(Object.entries(nameToEmoji));
export interface CustomEmoji {
  name: string;
  id: string;
  url: string;
  // Where a message's emoji came from: the host that hosts it, and whose it is.
  origin?: string;
  kind?: "instance" | "personal" | "remote";
}
export type EmojiPart =
  | { text: string }
  | { name: string; emoji: string }
  | { name: string; url: string; origin?: string; kind?: CustomEmoji["kind"] };

// What hovering over a custom emoji says about it.
export function emojiTitle(e: { name: string; origin?: string; kind?: CustomEmoji["kind"] }) {
  const what =
    e.kind === "personal"
      ? "Personal emoji"
      : e.kind === "remote"
        ? "Custom emoji"
        : e.kind === "instance"
          ? "Instance emoji"
          : "";
  return `:${e.name}:${what ? ` · ${what}${e.origin ? ` from ${e.origin}` : ""}${e.kind === "remote" ? " (click to keep)" : ""}` : ""}`;
}

// Keep the stored message intact so editing and unknown shortcodes are lossless.
export function emojiParts(body: string, custom: CustomEmoji[]): EmojiPart[] {
  const images = new Map(custom.map((e) => [e.name, e]));
  const parts: EmojiPart[] = [];
  let end = 0;
  for (const match of body.matchAll(/:([a-z0-9_+\-]{1,64}):/g)) {
    if (match.index > end) parts.push({ text: body.slice(end, match.index) });
    const name = match[1],
      emoji = standardEmojis.get(name),
      image = images.get(name);
    parts.push(
      emoji
        ? { name, emoji }
        : image
          ? {
              name,
              url: image.url,
              ...(image.origin ? { origin: image.origin } : {}),
              ...(image.kind ? { kind: image.kind } : {}),
            }
          : { text: match[0] },
    );
    end = match.index + match[0].length;
  }
  if (end < body.length) parts.push({ text: body.slice(end) });
  return parts;
}
