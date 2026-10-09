import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, Problem } from "../src/store.js";
import { emojiNames, emojiParts, markEmoji } from "../src/emojis.js";

export const tinyPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";

test("emoji shortcodes support standard aliases, custom images, and lossless unknown text", () => {
  const parts = emojiParts("Hello :smile: :+1: :island: :not_real: <script>", [
    { name: "island", id: "id", url: "/api/emojis/id/image" },
  ]);
  assert.deepEqual(
    parts.filter((p) => "emoji" in p).map((p) => "emoji" in p && p.emoji),
    ["😄", "👍"],
  );
  assert.deepEqual(
    parts.find((p) => "url" in p),
    { name: "island", url: "/api/emojis/id/image" },
  );
  assert.ok(parts.some((p) => "text" in p && p.text === ":not_real:"));
  assert.ok(parts.some((p) => "text" in p && p.text.includes("<script>")));
  assert.deepEqual(emojiParts(":constructor: :__proto__:", []), [
    { text: ":constructor:" },
    { text: " " },
    { text: ":__proto__:" },
  ]);
});

test("typed emoji are marked one by one and know their shortcodes", () => {
  assert.equal(
    markEmoji("a 👍🏽😄 🇫🇷 👨‍👩‍👧"),
    'a <span class="emoji">👍🏽</span><span class="emoji">😄</span> <span class="emoji">🇫🇷</span> <span class="emoji">👨‍👩‍👧</span>',
  );
  assert.deepEqual(emojiNames("👍🏽"), ["+1", "thumbsup"]);
  assert.deepEqual(emojiNames("❤"), ["heart"]);
  assert.deepEqual(emojiNames("🇫🇷"), ["fr"]);
  assert.deepEqual(emojiNames("x"), []);
});

test("custom emoji are restricted to instance admins, raster images and unique nonstandard names", () => {
  const store = new Store(":memory:");
  const admin = store.loginIdentity(
    "https://id.example",
    "admin",
    "admin",
    [],
    true,
  );
  const member = store.loginIdentity(
    "https://id.example",
    "member",
    "member",
    [],
  );
  const denied = (fn: () => unknown, status: number) =>
    assert.throws(fn, (e) => e instanceof Problem && e.status === status);
  denied(() => store.addEmoji(member, { name: "island", image: tinyPng }), 403);
  const emoji = store.addEmoji(admin, { name: "island", image: tinyPng })!;
  assert.equal(emoji.name, "island");
  assert.equal(store.emojiImage(emoji.id).mime, "image/png");
  assert.equal(
    Buffer.from(store.emojiImage(emoji.id).image).toString("base64"),
    tinyPng,
  );
  denied(() => store.addEmoji(admin, { name: "island", image: tinyPng }), 409);
  denied(() => store.addEmoji(admin, { name: "smile", image: tinyPng }), 400);
  denied(
    () => store.addEmoji(admin, { name: 'bad"name', image: tinyPng }),
    400,
  );
  denied(
    () =>
      store.addEmoji(admin, {
        name: "svg",
        image: Buffer.from('<svg onload="evil()"/>').toString("base64"),
      }),
    400,
  );
  denied(
    () =>
      store.addEmoji(admin, {
        name: "huge",
        image: Buffer.alloc(262145).toString("base64"),
      }),
    400,
  );
  denied(() => store.removeEmoji(member, "island"), 403);
  store.removeEmoji(admin, "island");
  assert.deepEqual(store.emojis(), []);
  denied(() => store.emojiImage(emoji.id), 404);
  assert.deepEqual(emojiParts(":island:", []), [{ text: ":island:" }]);
  store.close();
});
