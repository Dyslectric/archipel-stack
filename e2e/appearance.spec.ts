import { test, expect, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page.locator("[data-persona=alice]").click();
  await expect(page.locator("#profile")).toBeVisible();
}

test("custom reaction previews work for another reader without emoji metadata", async ({ page, browser }) => {
  await login(page); await style(page, "fusion-compact");
  await create(page, "fusion-reaction-preview");
  const address = page.url();
  await page.goto("/#/settings/instance/emoji");
  await page.getByLabel("Emoji shortcode", { exact: true }).fill("fusion_preview");
  await page.getByLabel("Emoji image", { exact: true }).setInputFiles({ name: "preview.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=", "base64") });
  await page.getByRole("button", { name: "Add emoji", exact: true }).click();
  await expect(page.locator(".admin-emojis")).toContainText("fusion_preview");
  await page.goto(address); await send(page, "React to this message.");
  await page.locator("article.message").click(); await page.locator("#fusion-react").click();
  await page.getByLabel("Search emoji").fill("fusion_preview");
  await page.locator('.emoji-picker [data-emoji="fusion_preview"]').click();
  await expect(page.locator(".reaction")).toBeVisible();
  const context = await browser.newContext(), reader = await context.newPage();
  try {
    await reader.goto("/"); await reader.locator("[data-persona=bob]").click();
    await expect(reader.locator("#profile")).toBeVisible(); await style(reader, "fusion-cozy");
    await reader.goto(address);
    await reader.locator("#join-channel").click();
    await reader.locator("dialog.share-dialog").getByRole("button", { name: "Join channel", exact: true }).click();
    const reaction = reader.locator('.reaction[data-emoji="fusion_preview"]');
    await expect(reaction.locator("img")).toBeVisible();
    await reaction.locator("span:last-child").hover();
    await expect(reader.locator(".emoji-card")).toContainText(":fusion_preview:");
    await expect(reader.locator(".emoji-card img")).toBeVisible();
    await expect(reaction).toHaveAttribute("aria-pressed", "false");
  } finally {
    await context.close();
    await page.goto("/#/settings/instance/emoji");
    await page.locator('[data-remove-emoji="fusion_preview"]').click();
    await expect(page.locator('[data-remove-emoji="fusion_preview"]')).toHaveCount(0);
  }
});
async function style(page: Page, value: string) {
  await page.evaluate(value => {
    const button = document.createElement("button");
    button.dataset.setStyle = value;
    document.body.append(button); button.click(); button.remove();
  }, value);
  await expect(page.locator("html")).toHaveAttribute("data-style", value);
}
async function create(page: Page, name: string, mode = "timeline") {
  await page.locator("#browse").click();
  await page.locator("#open-create-channel").click();
  const dialog = page.locator(".create-channel-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Channel name").fill(name);
  await dialog.locator(`input[name=fusion_mode][value=${mode}]`).check();
  await dialog.getByRole("button", { name: "Create channel", exact: true }).click();
  await expect(page.locator("#channel-heading strong")).toHaveText(name);
}
async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator(".message-body").filter({ hasText: text.split("\n")[0] })).toBeVisible();
}

test("settings select independent persistent styles and color schemes", async ({ page }) => {
  await login(page);
  await page.goto("/#/settings/personal/appearance");
  await expect(page.getByRole("button", { name: /^Default/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /^Fusion Compact/ }).click();
  await page.locator('.settings-body [data-set-theme="dark"]').click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-style", "fusion-compact");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: /^Fusion Compact/ })).toHaveAttribute("aria-pressed", "true");
  const textSize = page.getByRole("slider", { name: "Text size" });
  await expect(textSize).toHaveValue("100");
  await textSize.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await expect(page.locator("[data-text-scale-value]")).toHaveText("125%");
  await expect.poll(() => page.locator("body").evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBe(18.75);
  await page.reload();
  await expect(textSize).toHaveValue("125");
  await page.getByRole("button", { name: /^Fusion Cozy/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: /^Default/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-style", "default");
  await expect(textSize).toHaveValue("125");
  await page.getByRole("button", { name: "Reset to 100%" }).click();
  await expect(textSize).toHaveValue("100");
  await page.evaluate(() => localStorage.setItem("archipel-style", "unknown"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-style", "default");
});

test("Fusion chat switches without losing drafts, supports both densities and a mobile drawer", async ({ page }, info) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await login(page); await style(page, "fusion-compact");
  await create(page, "fusion-chat");
  await send(page, "First compact message."); await send(page, "Second compact message.");
  await expect(page.locator(".compact-author")).toHaveCount(2);
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("An unsent draft.");
  const first = page.locator("article.message").filter({ hasText: "First compact message." });
  await first.click();
  await expect(first.locator(".compact-time")).toHaveText(/^\d{2}:\d{2}$/);
  await page.locator("#fusion-react").click();
  await page.getByLabel("Search emoji").fill("thumbsup");
  await page.locator('.emoji-picker [data-emoji="+1"]').click();
  await expect(first.locator(".reaction")).toHaveAttribute("aria-pressed", "true");
  await first.locator(".reaction > span:last-child").hover();
  await expect(page.locator(".emoji-card")).toContainText("Standard emoji");
  await expect(first.locator(".reaction")).toHaveAttribute("aria-pressed", "true");
  expect(await first.locator(".reaction .emoji").evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThan(22);
  await page.keyboard.press("Escape");
  await first.locator(".reaction").focus();
  await expect(page.locator(".emoji-card")).toContainText("Standard emoji");
  await page.keyboard.press("Escape");
  await page.locator("#fusion-reply").click();
  await expect(page.locator(".reply-banner")).toContainText("Replying to alice");
  await page.locator('[data-fusion-action="new"]').click();
  await expect(page.locator(".reply-banner")).toHaveCount(0);
  await expect(input).toHaveValue("An unsent draft.");
  await page.locator("#fusion-search").fill("Second compact");
  await expect(page.locator("article.message")).toHaveCount(1);
  await page.locator("#fusion-search").fill("");
  await expect(page.locator("article.message")).toHaveCount(2);
  await first.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit message" }).click();
  await page.getByLabel("Edited message").fill("First compact message.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByLabel("Edited message")).toHaveCount(0);
  await page.locator("#fusion-quote").click();
  await expect(page.locator(".quote-preview")).toContainText("First compact message.");
  await expect(input).toHaveValue("An unsent draft.");
  await page.getByRole("button", { name: "Remove quote" }).click();
  await expect(page.locator(".quote-preview")).toHaveCount(0);
  await expect(input).toHaveValue("An unsent draft.");
  await first.click();
  await page.locator("#fusion-quote").click();
  await input.fill("A quoted answer.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("article.message").filter({ hasText: "A quoted answer." }).locator("blockquote")).toContainText("First compact message.");
  await input.fill("An unsent draft.");
  await style(page, "fusion-cozy");
  await expect(input).toHaveValue("An unsent draft.");
  await expect(page.locator(".msg-gutter .avatar").first()).toBeVisible();
  if (await page.locator("#fusion-members").getAttribute("aria-pressed") !== "true") await page.locator("#fusion-members").click();
  await expect(page.locator(".member-rows .avatar").first()).toBeVisible();
  await page.screenshot({ animations: "disabled", path: info.outputPath("fusion-cozy-light.png") });
  await style(page, "fusion-compact");
  await expect(page.locator(".member-rows .avatar").first()).toBeHidden();
  await page.screenshot({ animations: "disabled", path: info.outputPath("fusion-compact-light.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#sidebar")).toBeHidden();
  await expect(page.locator('[data-nav="chat"] .label')).toBeVisible();
  if (await page.getByRole("button", { name: "Hide members" }).isVisible()) {
    await page.getByRole("button", { name: "Hide members" }).click();
  }
  await page.locator("#fusion-members").click();
  await expect(page.getByRole("button", { name: "Hide members" })).toBeVisible();
  await page.getByRole("button", { name: "Hide members" }).click();
  await page.locator("#mobile-menu").click();
  await expect(page.locator("#sidebar")).toBeVisible();
  await page.locator("#mobile-menu").click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ animations: "disabled", path: info.outputPath("fusion-compact-mobile.png") });
  await style(page, "default");
  await expect(input).toHaveValue("An unsent draft.");
});

test("Fusion directory has a working table, create dialog and administrator featured settings", async ({ page }, info) => {
  await login(page); await style(page, "fusion-compact");
  await create(page, "fusion-directory", "topical");
  await page.locator("#browse").click();
  await expect(page.locator(".channel-table")).toBeVisible();
  await expect(page.locator("#fusion-status-place")).toHaveText("Channel directory");
  await expect(page.locator(".channel-table").getByRole("link", { name: "fusion-directory", exact: true })).toBeVisible();
  await page.getByLabel("Search channels").fill("no-such-channel");
  await expect(page.locator("#channel-table-body")).toHaveText("No channels match.");
  await page.getByLabel("Search channels").fill("");
  await page.locator("#open-create-channel").click();
  await page.locator(".create-channel-dialog").getByLabel("Channel name").fill("retained-draft");
  await page.screenshot({ animations: "disabled", path: info.outputPath("fusion-create-dialog.png") });
  await page.getByRole("button", { name: "Close create channel" }).click();
  await page.locator("#open-create-channel").click();
  await expect(page.locator(".create-channel-dialog").getByLabel("Channel name")).toHaveValue("retained-draft");
  await page.keyboard.press("Escape");
  await page.screenshot({ animations: "disabled", path: info.outputPath("fusion-channel-directory.png") });
  await page.goto("/#/settings/federation/featured");
  await expect(page.getByLabel("Show featured external channels in the directory")).toBeVisible();
  await page.getByLabel("Show featured external channels in the directory").check();
  await page.reload();
  await expect(page.getByLabel("Show featured external channels in the directory")).toBeChecked();
});

test("Fusion threads fold whole conversations and quote into a nested reply", async ({ page }, info) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await login(page); await style(page, "fusion-cozy");
  await create(page, "fusion-threads", "threaded");
  await page.getByLabel("Thread title").fill("A collapsible conversation");
  await send(page, "The original post.");
  const thread = page.locator("details.fusion-thread");
  await expect(thread.locator(".thread-heading")).toContainText("A collapsible conversation");
  await thread.locator(".post .message-body").click();
  await page.locator("#fusion-quote").click();
  const reply = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(page.locator(".quote-preview")).toContainText("The original post.");
  await reply.fill("A nested reply.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(thread.locator(".comment .message-body")).toContainText("A nested reply.");
  await thread.locator(":scope > summary").click();
  await expect(thread.locator(".post")).toBeHidden();
  await style(page, "fusion-compact");
  await expect(thread.locator(".post")).toBeHidden();
  await thread.locator(":scope > summary").click();
  await expect(thread.locator(".post")).toBeVisible();
  await page.locator("#fusion-collapse").click();
  await expect(thread.locator(".post")).toBeHidden();
  await page.locator("#fusion-collapse").click();
  await expect(thread.locator(".post")).toBeVisible();
  await page.screenshot({ animations: "disabled", path: info.outputPath("fusion-threads-compact.png") });
  await style(page, "fusion-cozy");
  await page.locator("#profile").click();
  await page.locator('#account-menu [data-set-theme="dark"]').click();
  await page.locator("#profile").click();
  await page.screenshot({ animations: "disabled", path: info.outputPath("fusion-threads-cozy-dark.png") });
  await style(page, "default");
  await expect(page.locator("section.thread")).toBeVisible();
});

test("quotes can be edited and split with replies between sections while preserving the original", async ({ page }, info) => {
  await login(page); await style(page, "fusion-compact");
  await create(page, "fusion-partition-quotes");
  await send(page, "First passage.\n\nSecond passage.");
  const original = page.locator("article.message").first();
  await original.click(); await page.locator("#fusion-quote").click();
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("A closing answer.");
  await page.getByRole("button", { name: "Edit quote", exact: true }).click();
  const passage = page.getByRole("textbox", { name: "Quote text 1", exact: true });
  await passage.fill("First passage.\n\nSecond passage.");
  await passage.evaluate(el => { const input = el as HTMLTextAreaElement; input.setSelectionRange(16, 16); input.dispatchEvent(new Event("select")); });
  await page.getByRole("button", { name: "Split at cursor", exact: true }).click();
  await page.getByRole("textbox", { name: "Quote text 1", exact: true }).fill("Shortened first.");
  await page.getByRole("textbox", { name: "Reply after quote 1", exact: true }).fill("My answer to the first.");
  await style(page, "fusion-cozy");
  await page.getByRole("button", { name: "Preview quote", exact: true }).click();
  await expect(page.locator(".quote-content").first()).toHaveText("Shortened first.");
  await expect(draft).toHaveValue("A closing answer.");
  await page.screenshot({ animations: "disabled", path: info.outputPath("fusion-partitioned-quote.png") });
  await page.getByRole("button", { name: "Send message" }).click();
  const posted = page.locator("article.message").filter({ hasText: "A closing answer." });
  await expect(posted.locator("blockquote")).toHaveCount(2);
  await expect(posted.locator(".message-body > p").first()).toHaveText("My answer to the first.");
  await expect(original.locator(".message-body")).toHaveText("First passage.Second passage.");
  await expect(posted.locator(".reply-context")).toBeVisible();
  await original.click(); await page.locator("#fusion-quote").click();
  await draft.fill("Still writing.");
  await page.getByRole("button", { name: "Edit quote", exact: true }).click();
  await passage.evaluate(el => { const input = el as HTMLTextAreaElement; input.setSelectionRange(16, 16); input.dispatchEvent(new Event("select")); });
  await page.getByRole("button", { name: "Split at cursor", exact: true }).click();
  await page.getByRole("textbox", { name: "Reply after quote 1", exact: true }).fill("Keep this answer.");
  await page.getByRole("button", { name: "Cancel reply", exact: true }).click();
  await expect(draft).toHaveValue("Keep this answer.\n\nStill writing.");
  await expect(page.locator(".quote-preview")).toHaveCount(0);
});

test("topical folder icons expand and collapse another channel without navigating", async ({ page }, info) => {
  await login(page); await style(page, "fusion-compact");
  await create(page, "fusion-expand-topics", "topical");
  await page.getByLabel("Topic", { exact: true }).fill("Planning");
  await send(page, "A plan for the dormant channel.");
  await create(page, "fusion-stay-here");
  const address = page.url();
  const expand = page.getByRole("button", { name: "Expand topics in fusion-expand-topics", exact: true });
  const closedIcon = await expand.locator("svg").innerHTML();
  await expand.click();
  const topic = page.locator("#sidebar .topic-link").filter({ hasText: "Planning" });
  await expect(topic).toBeVisible();
  expect(page.url()).toBe(address);
  const collapse = page.getByRole("button", { name: "Collapse topics in fusion-expand-topics", exact: true });
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  expect(await collapse.locator("svg").innerHTML()).not.toBe(closedIcon);
  await page.screenshot({ animations: "disabled", path: info.outputPath("fusion-open-folder.png") });
  await collapse.click();
  await expect(topic).toHaveCount(0);
  expect(await expand.locator("svg").innerHTML()).toBe(closedIcon);
  await style(page, "default");
  await page.getByRole("button", { name: "Expand topics in fusion-expand-topics", exact: true }).click();
  await expect(topic).toBeVisible();
  expect(page.url()).toBe(address);
});
