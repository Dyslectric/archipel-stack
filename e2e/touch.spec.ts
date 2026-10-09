import { test, expect, type Page } from "@playwright/test";

const png = {
  name: "wave.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
    "base64",
  ),
};
async function login(page: Page, name: string) {
  await page.goto("/");
  await page.locator(`[data-persona=${name}]`).click();
  await expect(page.locator("#profile")).toBeVisible();
}
async function send(page: Page, value: string) {
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(value);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("#composer textarea")).toHaveValue("");
}
// A finger held down where an element is, for longer than a tap.
async function hold(page: Page, selector: string, ms = 800) {
  const box = (await page.locator(selector).first().boundingBox())!,
    point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) },
    cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await page.waitForTimeout(ms);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
// What a finger does to a message, an emoji and a reaction: nothing a mouse's hover would have
// shown takes the tap that showed it.
test("taps show a message's buttons and an emoji's card, and a held reaction shows its card", async ({
  page,
  browser,
}) => {
  await login(page, "bob");
  await page.locator("#browse").click();
  await page.getByLabel("Channel name").fill("touch-audit");
  await page.locator("#new-channel").getByRole("button", { name: "Create channel" }).click();
  await expect(page.locator("#channel-heading strong")).toHaveText("touch-audit");
  await page.locator("[data-nav=settings]").click();
  await page.locator(".settings-nav").getByRole("link", { name: "Your emoji", exact: true }).click();
  await page.getByLabel("Personal shortcode", { exact: true }).fill("private_wave");
  await page.getByLabel("Personal emoji image", { exact: true }).setInputFiles(png);
  await page.getByRole("button", { name: "Upload personal emoji", exact: true }).click();
  await expect(page.locator(".personal-emoji-list")).toContainText(":private_wave:");
  await page.locator("[data-nav=chat]").click();
  for (const n of [1, 2, 3, 4, 5, 6]) await send(page, `Filler ${n}`);
  await send(page, "First message, long enough to span the whole row of a phone screen and wrap onto more lines.");
  await send(page, "Second message, also long enough to span the whole row of a phone screen and wrap around.");
  await send(page, "Third :smile: and :private_wave: here");
  const third = page.locator(".message").filter({ hasText: "Third" });
  await third.hover();
  await third.locator("[data-react-add]").click();
  await page.getByLabel("Search emoji", { exact: true }).fill("tada");
  await page.locator('.emoji-picker [data-emoji="tada"]').click();
  await expect(page.locator('.reaction[data-emoji="tada"]')).toBeVisible();

  const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 1200, height: 844 },
    }),
    alice = await context.newPage();
  await login(alice, "alice");
  await alice.locator("#browse").click();
  await alice.getByLabel("Search channels").fill("touch-audit");
  await alice.locator(".browse-channel").filter({ hasText: "touch-audit" }).locator(".browse-name").click();
  await alice.locator("#join-channel").click();
  await alice.locator("dialog.share-dialog").getByRole("button", { name: "Join channel", exact: true }).click();
  await expect(alice.locator("#message-body")).toBeVisible();
  await alice.setViewportSize({ width: 390, height: 844 });
  await alice.reload();
  await expect(alice.locator("#message-body")).toBeVisible();
  const second = alice.locator(".message").filter({ hasText: "Second" }),
    last = alice.locator(".message").filter({ hasText: "Third" }),
    nothingOpened = async () => {
      await expect(alice.locator(".emoji-picker, .menu-panel.popup, .reply-banner, dialog[open]")).toHaveCount(0);
      await expect(alice.locator("#message-body")).toHaveValue("");
    };

  // Anywhere on a message, the first tap only shows its buttons: even where a mouse finds them.
  await expect(alice.locator("#mobile-menu")).toBeVisible();
  await expect.poll(async () => (await second.boundingBox())!.width).toBeLessThan(390);
  for (const [dx, dy] of [[-30, 8], [-150, 8], [-180, 30]]) {
    const box = (await second.boundingBox())!;
    await alice.touchscreen.tap(box.x + box.width + dx, box.y + dy);
    await expect(second).toHaveClass(/show-actions/);
    await nothingOpened();
    // They sit under the message, covering none of it.
    const [text, bar] = [await second.locator(".message-body").boundingBox(), await second.locator(".message-actions").boundingBox()];
    expect(bar!.y).toBeGreaterThanOrEqual(text!.y + text!.height);
    await second.locator(".message-body").tap();
    await expect(second.locator(".message-actions")).toBeHidden();
  }
  // Shown, a button answers the next tap.
  await second.locator(".message-body").tap();
  await second.locator("[data-react-add]").tap();
  // The picker stays on the page, clear of the header, however little room the message has.
  const picker = (await alice.locator(".emoji-picker").boundingBox())!,
    header = (await alice.locator("#channel-heading").boundingBox())!;
  expect(picker.y).toBeGreaterThanOrEqual(header.y + header.height);
  expect(picker.y + picker.height).toBeLessThanOrEqual(844);
  await alice.locator("#channel-heading").tap();
  await expect(alice.locator(".emoji-picker")).toHaveCount(0);
  await second.locator("[data-reply]").tap();
  await expect(alice.locator(".reply-banner")).toContainText("Replying to bob");
  await alice.locator("#cancel-reply").tap();

  // An emoji in a message: its card, and from the card the dialog that keeps it.
  await last.locator(".message-body span.emoji").tap();
  await expect(alice.locator(".emoji-card")).toContainText(":smile:");
  await expect(last).not.toHaveClass(/show-actions/);
  await nothingOpened();
  await last.locator(".message-body img.custom-emoji").tap();
  await expect(alice.locator(".emoji-card")).toContainText(":private_wave:");
  await expect(alice.locator(".emoji-card")).toContainText("Tap the picture to keep it");
  await nothingOpened();
  await alice.locator(".emoji-card .ec-keep").tap();
  await expect(alice.locator("dialog[open] h2")).toHaveText("Keep this emoji");
  await alice.locator("dialog[open] [data-cancel]").tap();
  await second.locator(".message-meta, .msg-gutter").first().tap();
  await expect(alice.locator(".emoji-card")).toHaveCount(0);

  // A reaction: tapped it is given, with no card; held it shows the card and is not given.
  const tada = alice.locator('.reaction[data-emoji="tada"]');
  await tada.tap();
  await expect(tada).toHaveAttribute("aria-pressed", "true");
  await expect(tada).toContainText("2");
  await expect(alice.locator(".emoji-card")).toHaveCount(0);
  await hold(alice, '.reaction[data-emoji="tada"]');
  await expect(alice.locator(".emoji-card")).toContainText(":tada:");
  await alice.waitForTimeout(300);
  await expect(tada).toHaveAttribute("aria-pressed", "true");
  await expect(tada).toContainText("2");
  await alice.locator("#channel-heading").tap();
  await expect(alice.locator(".emoji-card")).toHaveCount(0);
  await tada.tap();
  await expect(tada).toHaveAttribute("aria-pressed", "false");
  await context.close();
});
