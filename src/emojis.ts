import { gemoji, nameToEmoji } from "gemoji";

export const standardEmojis = new Map(Object.entries(nameToEmoji));
// Every shortcode of a standard emoji, however it was typed: with or without a skin tone or
// the variation selector.
const bare = (emoji: string) => emoji.replace(/[\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu, "");
const namesOf = new Map(gemoji.map((g) => [bare(g.emoji), g.names]));
export const emojiNames = (emoji: string) => namesOf.get(bare(emoji)) ?? [];
export interface CustomEmoji {
  name: string;
  id: string;
  url: string;
  // Where a message's emoji came from: the host that hosts it, and whose it is.
  origin?: string;
  kind?: "instance" | "personal" | "remote";
  owner?: string; // the handle of a personal emoji's owner
  personal?: boolean; // an emoji from another server that is its owner's own
}
type Source = Pick<CustomEmoji, "origin" | "kind" | "owner" | "personal">;
export type EmojiPart =
  | { text: string }
  | { name: string; emoji: string }
  | ({ name: string; url: string } & Source);

// What a custom emoji says about itself when hovered: kept on the image for the hover card.
export function emojiData(e: Source, escape: (s: string) => string) {
  return [
    e.kind ? ` data-kind="${e.kind === "personal" || e.personal ? "personal" : "instance"}"` : "",
    e.kind && e.origin ? ` data-origin="${escape(e.origin)}"` : "",
    e.kind && e.owner ? ` data-owner="${escape(e.owner)}"` : "",
    e.kind === "remote" ? " data-remote" : "",
  ].join("");
}

// Emoji typed as themselves (not as shortcodes) are marked like the rest, so they are sized alike:
// each on its own (a flag is two letters), so that hovering over one can say which it is.
const typed =
  /[\u{1F1E6}-\u{1F1FF}]{2}|[\u{231A}-\u{23FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F000}-\u{1FAFF}][\u{FE0F}\u{1F3FB}-\u{1F3FF}]?(?:\u200D[\u{2600}-\u{27BF}\u{1F000}-\u{1FAFF}][\u{FE0F}\u{1F3FB}-\u{1F3FF}]?)*/gu;
export const markEmoji = (escaped: string) =>
  escaped.replace(typed, '<span class="emoji">$&</span>');

// A ban names an emoji by one shortcode and covers it however it is written: under any of its
// shortcodes, or typed as itself.
export function bannedNames(banned: string[]) {
  const names = new Set<string>();
  for (const name of banned) {
    names.add(name);
    const emoji = standardEmojis.get(name);
    if (emoji) for (const other of emojiNames(emoji)) names.add(other);
  }
  return names;
}
const banned = (name: string | undefined, names: Set<string>) =>
  name !== undefined && names.has(name) ? name : undefined;
// The first banned emoji a text uses, by a shortcode of it.
export function bannedEmoji(body: string, names: Set<string>) {
  if (!names.size) return undefined;
  for (const match of body.matchAll(/:([a-z0-9_+\-]{1,64}):/g))
    if (names.has(match[1])) return match[1];
  for (const match of body.matchAll(typed)) {
    const name = banned(emojiNames(match[0])[0], names);
    if (name) return name;
  }
  return undefined;
}
// The text with them left out. What is stored is not changed: lifting the ban brings them back.
export const withoutEmojis = (body: string, names: Set<string>) =>
  names.size
    ? body
        .replace(/:([a-z0-9_+\-]{1,64}):/g, (code, name) => (names.has(name) ? "" : code))
        .replace(typed, (emoji) => (banned(emojiNames(emoji)[0], names) ? "" : emoji))
    : body;

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
              ...(image.owner ? { owner: image.owner } : {}),
              ...(image.personal ? { personal: true } : {}),
            }
          : { text: match[0] },
    );
    end = match.index + match[0].length;
  }
  if (end < body.length) parts.push({ text: body.slice(end) });
  return parts;
}
