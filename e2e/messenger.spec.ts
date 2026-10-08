import { test, expect, type Locator, type Page } from "@playwright/test";

async function login(page: Page, name = "alice") {
  await page.goto("/");
  await page.locator(`[data-persona=${name}]`).click();
  await expect(page.locator("#profile")).toBeVisible();
}
async function createChannel(
  page: Page,
  name: string,
  mode = "timeline",
  visibility = "public",
  admission = "open",
) {
  await page.locator("#browse").click();
  await page.getByLabel("Channel name").fill(name);
  await page
    .getByLabel("Description", { exact: true })
    .fill("A place to gather.");
  await page.getByLabel("Conversation style").selectOption(mode);
  await page.getByLabel("Who can read?").selectOption(visibility);
  await page.getByLabel("Who can join?").selectOption(admission);
  await page
    .locator("#new-channel")
    .getByRole("button", { name: "Create channel" })
    .click();
  await expect(page.locator("#channel-heading strong")).toHaveText(name);
}
async function openChannel(page: Page, name: string) {
  await page.locator("#browse").click();
  await page.getByLabel("Search channels").fill(name);
  await page
    .locator(".browse-channel")
    .filter({ hasText: name })
    .locator(".browse-name")
    .click();
  await expect(page.locator("#channel-heading strong")).toHaveText(name);
}
const openChat = (page: Page) => page.locator("[data-nav=chat]").click();

// Settings are pages: open one from the list on the left.
const section = (page: Page, name: string) =>
  page
    .locator(".settings-nav")
    .getByRole("link", { name, exact: true })
    .click();
async function channelSettings(page: Page, name: string) {
  await page.getByRole("link", { name: "Channel settings" }).click();
  await section(page, name);
}
async function send(page: Page, value: string) {
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(value);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.locator(".message-body").filter({ hasText: value }),
  ).toBeVisible();
}
// In a threaded channel a reply is written under the message it answers.
async function replyUnder(page: Page, message: Locator, value: string) {
  await message.locator("details.reply-box > summary").first().click();
  await message.getByLabel("Reply", { exact: true }).first().fill(value);
  await message
    .getByRole("button", { name: "Reply", exact: true })
    .first()
    .click();
  await expect(
    page.locator(".message-body").filter({ hasText: value }),
  ).toBeVisible();
}

test("two independent browsers exchange messages and retain history after reload", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page);
  await createChannel(page, "living-room");
  await send(page, "Hello from Alice.");
  const context = await browser.newContext();
  const bob = await context.newPage();
  await login(bob, "bob");
  await openChannel(bob, "living-room");
  await bob.getByRole("button", { name: "Join channel", exact: true }).click();
  await send(bob, "Hello from Bob.");
  await expect(
    page.locator(".message-body").filter({ hasText: "Hello from Bob." }),
  ).toBeVisible();
  await send(bob, '<img src=x onerror="window.archipelUnsafe=true">');
  await expect(
    page.locator(".message-body").filter({ hasText: "<img src=x" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { archipelUnsafe?: boolean }).archipelUnsafe,
    ),
  ).toBeUndefined();
  await page.reload();
  await expect(
    page.locator(".message-body").filter({ hasText: "Hello from Alice." }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});

test("topics separate conversations and allow replies within their topic", async ({
  page,
}) => {
  await login(page);
  await createChannel(page, "workshop", "topical");
  const topic = page.getByLabel("Topic", { exact: true });
  await topic.fill("Planning");
  await send(page, "Our first plan.");
  await page.locator(".message").filter({ hasText: "Our first plan." }).hover();
  await page.getByRole("button", { name: "Reply to alice" }).click();
  await send(page, "A follow-up.");
  await expect(page.locator(".reply-context")).toContainText(
    "Our first plan.",
  );
  await topic.fill("Building");
  await send(page, "Time to build.");
  // Every topic at once, each under its own bar, as in Zulip.
  await expect(page.locator(".recipient-bar")).toHaveCount(2);
  await page.locator(".topic-link").filter({ hasText: "Planning" }).click();
  await expect(
    page.locator(".message-body").filter({ hasText: "Our first plan." }),
  ).toBeVisible();
  await expect(
    page.locator(".message-body").filter({ hasText: "Time to build." }),
  ).toHaveCount(0);
  await expect(topic).toHaveValue("Planning");
  await page.locator(".topic-link").filter({ hasText: "Building" }).click();
  await expect(
    page.locator(".message-body").filter({ hasText: "Time to build." }),
  ).toBeVisible();
  await expect(
    page.locator(".message-body").filter({ hasText: "Our first plan." }),
  ).toHaveCount(0);
});

test("nested threads preserve replies when a parent is removed", async ({
  page,
}) => {
  await login(page);
  await createChannel(page, "ideas", "threaded");
  await page
    .getByRole("textbox", { name: "Thread title" })
    .fill("An idea worth sharing");
  await send(page, "Start here.");
  const root = page.locator(".thread > .post");
  await replyUnder(page, root, "First reply.");
  await replyUnder(
    page,
    page.locator("details.comment").filter({ hasText: "First reply." }),
    "Nested reply.",
  );
  const nested = page.locator('details.comment[data-depth="1"]');
  await expect(nested).toContainText("Nested reply.");
  await root.getByRole("button", { name: "Edit message", exact: true }).click();
  await root
    .getByLabel("Thread title", { exact: true })
    .fill("An improved idea");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator(".thread-title")).toHaveText("An improved idea");
  await expect(nested).toContainText("Nested reply.");
  // Folding a comment hides its replies, as in ThreadBNC.
  await page
    .getByRole("button", { name: "Collapse this thread" })
    .first()
    .click();
  await expect(nested).toBeHidden();
  await page.getByRole("button", { name: "Expand all" }).click();
  await expect(nested).toBeVisible();
  await root.getByRole("button", { name: "Remove message" }).click();
  await page
    .locator("dialog")
    .getByRole("button", { name: "Remove message" })
    .click();
  await expect(page.getByText("This message was removed.")).toBeVisible();
  await expect(
    page.locator(".message-body").filter({ hasText: "Nested reply." }),
  ).toBeVisible();
});

test("private invitation and a subsequent block change the other browser’s access", async ({
  page,
  browser,
}) => {
  await login(page);
  await createChannel(page, "quiet-island", "timeline", "members", "allowlist");
  const context = await browser.newContext();
  const bob = await context.newPage();
  await login(bob, "bob");
  await bob.locator("#browse").click();
  await bob.getByLabel("Search channels").fill("quiet-island");
  await expect(bob.locator(".browse-channel")).toHaveCount(0);
  await channelSettings(page, "Access rules");
  await page
    .getByRole("combobox", { name: "Person", exact: true })
    .selectOption({ label: "@bob" });
  await page
    .getByRole("combobox", { name: "Action", exact: true })
    .selectOption("allow");
  await page.getByRole("button", { name: "Apply change" }).click();
  await expect(page.locator(".rules-list")).toContainText("@bob");
  await expect(async () => {
    await bob.reload();
    await expect(bob.locator("#profile")).toBeVisible();
    await bob.locator("#browse").click();
    await bob.getByLabel("Search channels").fill("quiet-island");
    await expect(bob.locator(".browse-channel")).toHaveCount(1);
  }).toPass();
  await bob.locator(".browse-name").click();
  await expect(bob.locator("#channel-heading strong")).toHaveText(
    "quiet-island",
  );
  await send(bob, "A private hello.");
  await openChat(page);
  await expect(
    page.locator(".message-body").filter({ hasText: "A private hello." }),
  ).toBeVisible();
  await channelSettings(page, "Access rules");
  await page
    .getByRole("combobox", { name: "Person", exact: true })
    .selectOption({ label: "@bob" });
  await page
    .getByRole("combobox", { name: "Action", exact: true })
    .selectOption("block");
  await page.getByRole("button", { name: "Apply change" }).click();
  await expect(
    bob.locator(".message-body").filter({ hasText: "A private hello." }),
  ).toHaveCount(0);
  await context.close();
});

async function openAdmin(page: Page, name = "Membership") {
  await page.locator("#profile").click();
  await page
    .getByRole("link", { name: "Instance administration", exact: true })
    .click();
  await section(page, name);
  await expect(
    page.getByRole("heading", { name, exact: true, level: 1 }),
  ).toBeVisible();
}

test("standard and custom shortcodes render, and deleted custom emoji fall back to text", async ({
  page,
  browser,
}) => {
  await login(page);
  await createChannel(page, "emoji-island");
  await openAdmin(page, "Custom emoji");
  await page.getByLabel("Emoji shortcode", { exact: true }).fill("island_wave");
  await page.getByLabel("Emoji image", { exact: true }).setInputFiles({
    name: "island.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await page.getByRole("button", { name: "Add emoji", exact: true }).click();
  await expect(page.locator(".admin-emojis")).toContainText(":island_wave:");
  await openChat(page);
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Hello :smile: ");
  await page.getByRole("button", { name: "Choose emoji" }).click();
  await page.getByLabel("Search emoji", { exact: true }).fill("island_wave");
  await expect(page.locator(".emoji-picker")).toBeVisible();
  await page.locator('[data-emoji="island_wave"]').click();
  await expect(page.locator(".emoji-picker")).toHaveCount(0);
  await page.getByRole("button", { name: "Send message" }).click();
  const body = page.locator(".message-body").filter({ hasText: "Hello" });
  await expect(body).toContainText("😄");
  await expect(
    body.getByAltText(":island_wave:", { exact: true }),
  ).toBeVisible();
  await expect(async () =>
    expect(
      await body
        .locator("img")
        .evaluate((e: HTMLImageElement) => e.naturalWidth),
    ).toBeGreaterThan(0),
  ).toPass();
  const context = await browser.newContext(),
    bob = await context.newPage();
  await login(bob, "bob");
  await openChannel(bob, "emoji-island");
  await expect(bob.locator(".message-body img")).toBeVisible();
  await openAdmin(page, "Custom emoji");
  await page
    .locator(".admin-emojis")
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await expect(page.locator(".admin-emojis img")).toHaveCount(0);
  await expect(bob.locator(".message-body")).toContainText(":island_wave:");
  await expect(bob.locator(".message-body img")).toHaveCount(0);
  await context.close();
});

test("an author edits a message while another browser receives its edited marker", async ({
  page,
  browser,
}) => {
  await login(page);
  await createChannel(page, "editable");
  await send(page, "Original message.");
  const context = await browser.newContext(),
    bob = await context.newPage();
  await login(bob, "bob");
  await openChannel(bob, "editable");
  await expect(bob.locator(".edit-button")).toHaveCount(0);
  const article = page
    .locator(".message")
    .filter({ hasText: "Original message." });
  await article.hover();
  await article
    .getByRole("button", { name: "Edit message", exact: true })
    .click();
  await article
    .getByRole("textbox", { name: "Edited message", exact: true })
    .fill("Updated :heart: <img src=x onerror=evil()>");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(bob.locator(".message-body")).toContainText(
    "Updated ❤️ <img src=x onerror=evil()>",
  );
  await expect(bob.locator(".message-meta")).toContainText("(edited)");
  await expect(bob.locator(".message-body img")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".message-body")).toContainText("Updated ❤️");
  await expect(page.locator(".message-meta")).toContainText("(edited)");
  await context.close();
});

test("invite-only sign-in waits for an administrator decision and approval unlocks the browser", async ({
  page,
  browser,
}) => {
  await login(page);
  await openAdmin(page);
  await page
    .getByRole("combobox", { name: "New user access", exact: true })
    .selectOption("invite_only");
  await page
    .getByRole("button", { name: "Save membership policy", exact: true })
    .click();
  await expect(page.locator("#toast")).toContainText("Membership policy saved");
  const context = await browser.newContext(),
    applicant = await context.newPage();
  await applicant.goto("/");
  await expect(applicant.locator(".signin-footnote")).toContainText(
    "administrators can review",
  );
  await applicant.locator("[data-persona=charlie]").click();
  await expect(
    applicant.getByRole("heading", {
      name: "Waiting for approval",
      exact: true,
    }),
  ).toBeVisible();
  await expect(applicant.locator("#browse")).toHaveCount(0);
  await openAdmin(page);
  const row = page.locator(".application").filter({ hasText: "@charlie" });
  await expect(row).toContainText("No verified socials were shared");
  await row.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(
    applicant.getByRole("heading", {
      name: "Membership was declined",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .locator(".application")
    .filter({ hasText: "@charlie" })
    .getByRole("button", { name: "Approve", exact: true })
    .click();
  await expect(applicant.locator("#profile")).toBeVisible();
  await expect(page.locator(".application")).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "New user access", exact: true })
    .selectOption("open");
  await page
    .getByRole("button", { name: "Save membership policy", exact: true })
    .click();
  await expect(page.locator("#toast")).toContainText("Membership policy saved");
  await context.close();
});

test("mobile layout supports profile changes and sign-out", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "charlie");
  await expect(
    page.getByRole("button", { name: "Show channels" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.getByRole("button", { name: "Show channels" }).click();
  await expect(page.locator("#sidebar")).toBeVisible();
  await page.locator("#profile").click();
  await page.getByRole("link", { name: "Profile", exact: true }).click();
  await page.getByLabel("Display name", { exact: true }).fill("Charlie");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.locator("#toast")).toContainText("Profile saved");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.locator("#profile").click();
  await page
    .locator("#account-menu")
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await expect(page.locator("[data-persona=charlie]")).toBeVisible();
});

async function openPersonalEmoji(page: Page) {
  await page.locator("#profile").click();
  await page
    .locator("#account-menu")
    .getByRole("link", { name: "Your emoji", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your emoji", exact: true }),
  ).toBeVisible();
}
const personalPng = {
  name: "wave.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
    "base64",
  ),
};

test("members upload personal emoji and renaming preserves images in older messages for other readers", async ({
  page,
  browser,
}) => {
  await login(page, "bob");
  await createChannel(page, "personal-codes");
  await openPersonalEmoji(page);
  await page
    .getByLabel("Personal shortcode", { exact: true })
    .fill("private_wave");
  await page
    .getByLabel("Personal emoji image", { exact: true })
    .setInputFiles(personalPng);
  await page
    .getByRole("button", { name: "Upload personal emoji", exact: true })
    .click();
  await expect(page.locator(".personal-emoji-list")).toContainText(
    ":private_wave:",
  );
  await openChat(page);
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Personal :private_wave:");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page
      .locator(".message-body")
      .getByAltText(":private_wave:", { exact: true }),
  ).toBeVisible();
  const context = await browser.newContext(),
    alice = await context.newPage();
  await login(alice);
  await openChannel(alice, "personal-codes");
  await expect(
    alice
      .locator(".message-body")
      .getByAltText(":private_wave:", { exact: true }),
  ).toBeVisible();
  await openPersonalEmoji(page);
  await page
    .locator(".personal-emoji-list")
    .getByRole("button", { name: "Rename", exact: true })
    .click();
  await page.getByLabel("New shortcode", { exact: true }).fill("renamed_wave");
  await page
    .getByRole("button", { name: "Save shortcode", exact: true })
    .click();
  await expect(page.locator(".personal-emoji-list")).toContainText(
    ":renamed_wave:",
  );
  await openChat(page);
  await expect(
    page
      .locator(".message-body")
      .getByAltText(":private_wave:", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Renamed :renamed_wave:");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    alice
      .locator(".message-body")
      .getByAltText(":renamed_wave:", { exact: true }),
  ).toBeVisible();
  await openPersonalEmoji(alice);
  await expect(alice.locator(".personal-emoji-list")).not.toContainText(
    ":renamed_wave:",
  );
  await context.close();
});

async function grantFederation(page: Page, user: string) {
  await openAdmin(page);
  await section(page, "Instance federation");
  await page
    .getByRole("checkbox", {
      name: "Enable federation for this instance",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Save federation setting", exact: true })
    .click();
  await expect(page.locator("#toast")).toContainText(
    "Federation setting saved",
  );
  await page
    .getByRole("combobox", { name: "Local user", exact: true })
    .selectOption({ label: `@${user}` });
  for (const name of [
    "Send federated messages",
    "Receive federated messages",
    "Subscribe to remote channels",
    "Post in federated channels",
  ])
    await page.getByRole("checkbox", { name, exact: true }).check();
  await page
    .getByRole("button", { name: "Save user permissions", exact: true })
    .click();
  await expect(page.locator("#toast")).toContainText(
    "Federation permissions saved",
  );
  await openChat(page);
}
async function openFederated(page: Page, name = "Remote channels") {
  await page.locator("#profile").click();
  await page
    .getByRole("link", { name: "Federated conversations", exact: true })
    .click();
  await section(page, name);
}

test("two browser instances federate a channel and a direct message with admin-controlled posting", async ({
  page,
  browser,
}) => {
  test.setTimeout(60000);
  await login(page);
  const peerContext = await browser.newContext({
      baseURL: "http://127.0.0.1:8791",
    }),
    bob = await peerContext.newPage();
  await login(bob, "bob");
  const adminContext = await browser.newContext({
      baseURL: "http://127.0.0.1:8791",
    }),
    peerAdmin = await adminContext.newPage();
  await login(peerAdmin);
  await grantFederation(page, "alice");
  await grantFederation(peerAdmin, "bob");
  await page.goto("/#/settings/personal/profile");
  await page.getByLabel("Profile picture", { exact: true }).setInputFiles({ name: "portrait.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=", "base64") });
  await page.getByRole("button", { name: "Upload picture", exact: true }).click();
  await expect(page.locator("#profile-picture-preview img")).toHaveAttribute("src", /^\/api\/avatars\//);
  await createChannel(page, "federated-lounge");
  await channelSettings(page, "Federation");
  await page
    .getByRole("checkbox", {
      name: "Allow this channel to federate",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Save channel federation", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", {
      name: "Allow this channel to federate",
      exact: true,
    }),
  ).toBeChecked();
  await openChat(page);
  await send(page, "Home greeting.");
  await bob.reload();
  await expect(bob.locator("#profile")).toBeVisible();
  await openFederated(bob);
  await bob
    .getByLabel("Channel address", { exact: true })
    .fill("#federated-lounge@127.0.0.1:8790");
  await bob
    .getByRole("button", { name: "Subscribe to channel", exact: true })
    .click();
  await expect(async () => {
    await bob
      .getByRole("button", { name: "Refresh subscriptions", exact: true })
      .click();
    await expect(bob.locator(".remote-subscriptions")).toContainText(
      "accepted",
    );
  }).toPass({ timeout: 15000 });
  await bob.getByRole("button", { name: "Open channel", exact: true }).click();
  await expect(bob.locator(".message-body")).toContainText("Home greeting.");
  const remotePicture = bob.locator(".message").filter({ hasText: "Home greeting." }).locator(".avatar img");
  await expect(remotePicture).toHaveAttribute("src", /^\/api\/remote-avatars\//);
  await expect.poll(() => remotePicture.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.goto("/#/settings/personal/profile");
  await page.getByRole("button", { name: "Remove picture", exact: true }).click();
  await expect(remotePicture).toHaveCount(0);
  await openChat(page);
  await send(bob, "Remote greeting.");
  await expect(
    page.locator(".message-body").filter({ hasText: "Remote greeting." }),
  ).toBeVisible();
  await openFederated(bob, "Direct messages");
  await bob
    .getByLabel("Remote user address", { exact: true })
    .fill("alice@127.0.0.1:8790");
  await bob
    .getByRole("textbox", { name: "Direct message", exact: true })
    .fill("A federated private hello.");
  await bob
    .getByRole("button", { name: "Send federated message", exact: true })
    .click();
  await expect(bob.locator("#federated-direct-list")).toContainText(
    "A federated private hello.",
  );
  await openFederated(page, "Direct messages");
  await expect(page.locator("#federated-direct-list")).toContainText(
    "A federated private hello.",
  );
  await openAdmin(peerAdmin);
  await section(peerAdmin, "Instance federation");
  await peerAdmin
    .getByRole("combobox", { name: "Local user", exact: true })
    .selectOption({ label: "@bob" });
  await peerAdmin
    .getByRole("checkbox", { name: "Post in federated channels", exact: true })
    .uncheck();
  await peerAdmin
    .getByRole("button", { name: "Save user permissions", exact: true })
    .click();
  await expect(peerAdmin.locator("#toast")).toContainText(
    "Federation permissions saved",
  );
  await openChat(bob);
  await expect(bob.locator("#composer-area")).toContainText(
    "administrator must enable",
  );
  await expect(bob.locator("#message-body")).toHaveCount(0);
  await peerContext.close();
  await adminContext.close();
});

test("users adopt a remote instance emoji and keep a local copy under their chosen name", async ({
  page,
  browser,
}) => {
  const context = await browser.newContext({
      baseURL: "http://127.0.0.1:8791",
    }),
    peer = await context.newPage();
  await login(peer);
  await openAdmin(peer, "Custom emoji");
  await peer
    .getByLabel("Emoji shortcode", { exact: true })
    .fill("remote_island");
  await peer
    .getByLabel("Emoji image", { exact: true })
    .setInputFiles(personalPng);
  await peer.getByRole("button", { name: "Add emoji", exact: true }).click();
  await expect(peer.locator(".admin-emojis")).toContainText(":remote_island:");
  await login(page, "bob");
  await openPersonalEmoji(page);
  await page
    .getByLabel("Remote instance URL", { exact: true })
    .fill("http://127.0.0.1:8791");
  await page
    .getByRole("button", { name: "Load instance emoji", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Remote emoji", exact: true }),
  ).toContainText(":remote_island:");
  await page
    .getByLabel("Save as shortcode", { exact: true })
    .fill("adopted_island");
  await page.getByRole("button", { name: "Adopt emoji", exact: true }).click();
  const saved = page
    .locator(".personal-emoji-list")
    .locator("li")
    .filter({ hasText: ":adopted_island:" });
  await expect(saved.locator("img")).toBeVisible();
  expect(await saved.locator("img").getAttribute("src")).toMatch(
    /^\/api\/emojis\//,
  );
  await peer
    .locator(".admin-emojis")
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await page.reload();
  await expect(page.locator("#profile")).toBeVisible();
  await openPersonalEmoji(page);
  await expect(
    page
      .locator(".personal-emoji-list")
      .getByAltText(":adopted_island:", { exact: true }),
  ).toBeVisible();
  await context.close();
});

test("profile pictures preview, upload, replace and remove across messages and direct conversations", async ({ page, browser }) => {
  // Use a member account so this test does not share the admin suite's request budget.
  await login(page, "charlie");
  const session = await (await page.request.get("/api/session")).json();
  const headers = { Origin: "http://127.0.0.1:8790", "X-CSRF-Token": session.csrf };
  const created = await page.request.post("/api/channels", {
    headers,
    data: { name: "profile-pictures", description: "Avatar test", mode: "timeline", visibility: "public", admission: "open" },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const channel = await created.json();
  await page.goto(`/#/c/${channel.id}`);
  await send(page, "Posted before uploading a picture");
  const context = await browser.newContext(), bob = await context.newPage();
  try {
    await login(bob, "bob");
    const recipient = await (await bob.request.get("/api/session")).json();
    await page.request.post("/api/dms", { headers, data: { to: recipient.user.actor_url, body: "Avatar in direct messages" } });
    await bob.goto(`/#/dm/${session.user.id}`);
    await expect(bob.locator("#channel-heading strong")).toHaveText(session.user.display_name);
    await page.goto("/#/settings/personal/profile");
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=", "base64");
    const input = () => page.getByLabel("Profile picture", { exact: true });
    const upload = () => page.getByRole("button", { name: "Upload picture", exact: true }).click();
    const loaded = (picture: Locator) => expect.poll(() => picture.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await input().setInputFiles({ name: "portrait.png", mimeType: "image/png", buffer: image });
    await expect(page.locator("#profile-picture-preview img")).toHaveAttribute("src", /^data:image\/png;base64,/);
    await loaded(page.locator("#profile-picture-preview img"));
    await upload();
    const account = page.locator("#profile .avatar img");
    await expect(account).toHaveAttribute("src", /^\/api\/avatars\//);
    const original = await account.getAttribute("src");
    await loaded(account);
    await expect(bob.locator("#channel-heading .avatar img")).toHaveAttribute("src", original!);
    await loaded(bob.locator("#channel-heading .avatar img"));
    await expect(bob.locator(".dm-link .avatar img")).toHaveAttribute("src", original!);
    await expect(bob.locator(".message .avatar img")).toHaveAttribute("src", original!);
    await bob.locator("#channel-heading .name-button").click();
    await expect(bob.locator(".user-card .avatar img")).toHaveAttribute("src", original!);
    await bob.keyboard.press("Escape");
    await page.reload();
    await expect(page.locator("#profile-picture-preview img")).toHaveAttribute("src", original!);
    // Invalid input does not replace the saved picture.
    await input().setInputFiles({ name: "unsafe.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg/>') });
    await upload();
    await expect(page.locator("#profile-picture-form .form-error")).toContainText("PNG, JPEG, GIF and WebP");
    await expect(account).toHaveAttribute("src", original!);
    await input().setInputFiles({ name: "replacement.png", mimeType: "image/png", buffer: image });
    await upload();
    await expect(account).not.toHaveAttribute("src", original!);
    await loaded(account);
    const replacement = await account.getAttribute("src");
    await bob.goto(`/#/c/${channel.id}`);
    await expect(bob.locator(".message .avatar img")).toHaveAttribute("src", replacement!);
    await loaded(bob.locator(".message .avatar img"));
    await page.getByRole("button", { name: "Remove picture", exact: true }).click();
    await expect(account).toHaveCount(0);
    await expect(page.locator("#profile-picture-preview img")).toHaveCount(0);
    await expect(bob.locator(".message .avatar img")).toHaveCount(0);
  } finally { await context.close(); }
});

test("a name menu blocks and unblocks a user in channel messages and direct conversation headers", async ({ page, browser }) => {
  await login(page, "alice");
  const aliceSession = await (await page.request.get("/api/session")).json();
  const create = await page.request.post("/api/channels", {
    headers: { Origin: "http://127.0.0.1:8790", "X-CSRF-Token": aliceSession.csrf },
    data: { name: "personal-blocks", description: "Block test", mode: "timeline", visibility: "public", admission: "open" },
  });
  expect(create.ok()).toBeTruthy();
  const channel = await create.json();
  await page.goto(`/#/c/${channel.id}`);
  await send(page, "Visible before blocking");
  const context = await browser.newContext(), bob = await context.newPage();
  try {
    await login(bob, "bob");
    const bobSession = await (await bob.request.get("/api/session")).json();
    const headers = { Origin: "http://127.0.0.1:8790", "X-CSRF-Token": bobSession.csrf };
    await bob.request.post(`/api/channels/${channel.id}/join`, { headers });
    await bob.goto(`/#/c/${channel.id}`);
    await bob.locator(".message .name-button").filter({ hasText: "alice" }).first().click();
    await bob.getByRole("button", { name: "Block user", exact: true }).click();
    await expect(bob.locator(".message-body")).toContainText("hidden because you blocked this user");
    await expect(page.locator(".message-body")).toContainText("Visible before blocking");
    const sendBlocked = await page.request.post("/api/dms", {
      headers: { Origin: "http://127.0.0.1:8790", "X-CSRF-Token": aliceSession.csrf },
      data: { to: bobSession.user.actor_url, body: "Cannot get through" },
    });
    expect(sendBlocked.status()).toBe(403);
    await bob.reload();
    await bob.locator(".message .name-button").filter({ hasText: "alice" }).first().click();
    await expect(bob.getByRole("button", { name: "Unblock user", exact: true })).toBeVisible();
    await bob.getByRole("link", { name: "Open direct conversation" }).click();
    await expect(bob.locator(".composer-hint")).toContainText("You blocked this user");
    await bob.locator("#channel-heading .name-button").click();
    await bob.getByRole("button", { name: "Unblock user", exact: true }).click();
    await expect(bob.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    await send(bob, "Allowed after unblocking");
    await bob.locator("#channel-heading .name-button").click();
    await expect(bob.getByRole("button", { name: "Block user", exact: true })).toBeVisible();
    await bob.keyboard.press("Escape");
    await bob.goto(`/#/c/${channel.id}`);
    await expect(bob.locator(".message-body")).toContainText("Visible before blocking");
    await page.locator(".message .name-button").first().click();
    await expect(page.getByRole("button", { name: "Block user", exact: true })).toHaveCount(0);
  } finally { await context.close(); }
});

test("the inbox gathers new channel and direct messages, and the sidebar folds and groups them", async ({
  page,
  browser,
}) => {
  await login(page, "charlie");
  await createChannel(page, "harbour");
  await send(page, "Welcome aboard.");
  const context = await browser.newContext(),
    bob = await context.newPage();
  await login(bob, "bob");
  await openChannel(bob, "harbour");
  await bob.getByRole("button", { name: "Join channel", exact: true }).click();
  // Charlie looks elsewhere, so what Bob says next is news.
  await page.locator("[data-nav=inbox]").click();
  await expect(page.locator("#feed-empty")).toContainText("all caught up");
  await send(bob, "Ahoy from Bob.");
  // A name offers a direct message to its owner.
  await bob.locator(".message .name-button").first().click();
  await bob.getByRole("link", { name: "Send a direct message" }).click();
  await expect(bob.locator("#channel-heading strong")).toHaveText(/charlie/i);
  await send(bob, "A quiet word.");

  const inbox = page.locator("#rows.inbox");
  await expect(inbox.locator(".inbox-group")).toHaveCount(2);
  await expect(page.locator("#inbox-count")).toHaveText("2");
  await page.locator("[data-inbox-filter=dms]").click();
  await expect(inbox.locator(".inbox-group")).toHaveCount(1);
  await expect(inbox).toContainText("A quiet word.");
  await page.locator("[data-inbox-filter=channels]").click();
  await expect(inbox.locator(".inbox-group")).toHaveCount(1);
  await expect(inbox).toContainText("Ahoy from Bob.");
  await inbox.getByRole("button", { name: "Mark as read" }).click();
  await expect(page.locator("#feed-empty")).toContainText("Nothing new");
  await expect(page.locator("#inbox-count")).toHaveText("1");

  // Direct messages sit above channels; opening one reads it.
  await expect(page.locator(".side-section h2")).toHaveText([
    "Direct messages",
    "Channels",
  ]);
  await page.locator(".dm-link").filter({ hasText: "bob" }).click();
  await expect(
    page.locator(".message-body").filter({ hasText: "A quiet word." }),
  ).toBeVisible();
  await expect(page.locator("#inbox-count")).toBeHidden();
  await send(page, "Heard.");
  await expect(
    bob.locator(".message-body").filter({ hasText: "Heard." }),
  ).toBeVisible();

  // "New direct message" finds a member by name.
  await page
    .locator(".side-foot")
    .filter({ hasText: "New direct message" })
    .click();
  await page.getByLabel("To", { exact: true }).fill("ali");
  await page.locator(".people-list button").filter({ hasText: "@alice" }).click();
  await expect(page.locator("#channel-heading strong")).toHaveText("alice");

  // Channels go in groups, which fold away and stay that way.
  const row = page.locator(".side-item").filter({ hasText: "harbour" });
  await row.hover();
  await row.getByRole("button", { name: "Organise #harbour" }).click();
  await page.getByRole("menuitem", { name: "New group…" }).click();
  await page.locator("dialog input").fill("Docks");
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  const group = page.locator(".side-group").filter({ hasText: "Docks" });
  await expect(group.locator(".channel-link")).toContainText("harbour");
  await group.locator(".side-toggle").click();
  await expect(group.locator(".channel-link")).toHaveCount(0);
  await page.reload();
  await expect(group).toBeVisible();
  await expect(group.locator(".channel-link")).toHaveCount(0);
  await page.locator("[data-section=channels] > .side-head .side-toggle").click();
  await expect(page.locator(".side-group")).toHaveCount(0);
  await expect(page.locator(".dm-link")).toHaveCount(2);
  await page.locator("[data-section=dms] > .side-head .side-toggle").click();
  await expect(page.locator(".dm-link")).toHaveCount(0);
  await context.close();
});

test("XMPP app passwords are shown once, retained per account and revocable", async ({ page, browser }) => {
  await login(page, "charlie");
  await page.goto("/#/settings/personal/xmpp");
  await expect(page.getByText("Account address:")).toBeVisible();
  await page.getByLabel("App name").fill("Native phone");
  await page.getByRole("button", { name: "Create app password" }).click();
  const password = page.getByLabel("New XMPP app password");
  await expect(password).toBeVisible();
  await expect(password).toHaveValue(/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/);
  await expect(page.locator(".member-row").filter({ hasText: "Native phone" })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("New XMPP app password")).toHaveCount(0);
  await expect(page.locator(".member-row").filter({ hasText: "Native phone" })).toBeVisible();
  const context = await browser.newContext(), alice = await context.newPage();
  await login(alice, "alice");
  await alice.goto("/#/settings/personal/xmpp");
  await expect(alice.getByText("No active app passwords.")).toBeVisible();
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByText("No active app passwords.")).toBeVisible();
  await context.close();
});

test("external XMPP room browser flow joins, renders safe content, posts and follows room roles", async ({ page, browser }, testInfo) => {
  await login(page);
  const session = await (await page.request.get("/api/session")).json();
  const headers = { "X-CSRF-Token": session.csrf, Origin: "http://127.0.0.1:8790" };
  expect((await page.request.patch("/api/admin/federation", { headers, data: { enabled: true } })).ok()).toBeTruthy();
  expect((await page.request.patch(`/api/admin/users/${session.user.id}/federation`, { headers, data: {
    federation_receive: true, federation_subscribe: true, federation_send: true, federation_post: true,
  } })).ok()).toBeTruthy();
  await page.locator("#browse").click();
  await page.getByRole("link", { name: "Join an XMPP room", exact: true }).click();
  await page.getByLabel("Room address").fill("browser-test@muc.remote.example");
  await page.getByLabel("Nickname", { exact: true }).fill("alice-browser");
  await page.getByRole("button", { name: "Join room", exact: true }).click();
  await expect(page.locator("#channel-heading")).toContainText("browser-test@muc.remote.example");
  await expect(page.locator("#channel-heading")).toContainText("joining");
  const roomId = page.url().split("/xmpp/")[1];
  const adapterHeaders = { Authorization: "Bearer browser-test-bridge-secret-with-43-characters-minimum" };
  const sync = await (await page.request.post("/internal/xmpp/remote-rooms/sync", { headers: adapterHeaders, data: {} })).json();
  const occupant = sync.desired.find((r: { room: string }) => r.room === "browser-test@muc.remote.example");
  const receive = async (data: Record<string, unknown>) => {
    expect((await page.request.post("/internal/xmpp/remote-rooms/receive", {
      headers: adapterHeaders, data: { session: occupant.session, from: `${occupant.room}/alice-browser`, ...data },
    })).ok()).toBeTruthy();
  };
  await receive({ kind: "state", state: "joined", role: "participant" });
  await receive({ kind: "subject", subject: "A room hosted elsewhere" });
  await receive({ kind: "message", from: `${occupant.room}/host`, id: "foreign-1", body: '<img src=x onerror="window.archipelUnsafe=true">' });
  await expect(page.locator("#composer-area textarea")).toBeVisible();
  await expect(page.locator("#feed-top")).toContainText("A room hosted elsewhere");
  await expect(page.locator(".message-body")).toContainText("<img src=x");
  expect(await page.evaluate(() => (window as unknown as { archipelUnsafe?: boolean }).archipelUnsafe)).toBeUndefined();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Hello from the browser");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator(".xmpp-message").filter({ hasText: "Hello from the browser" })).toContainText("Queued");
  await page.reload();
  await expect(page.locator(".message-body").filter({ hasText: "Hello from the browser" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("external-room.png"), fullPage: true });
  const otherContext = await browser.newContext(), bob = await otherContext.newPage();
  await login(bob, "bob");
  expect(await (await bob.request.get("/api/xmpp/rooms")).json()).toEqual([]);
  expect((await bob.request.get(`/api/xmpp/rooms/${roomId}/messages`)).status()).toBe(404);
  await otherContext.close();
  await receive({ kind: "state", state: "joined", role: "visitor" });
  await expect(page.locator("#composer-area")).toContainText("reading only");
  await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(0);
  await page.getByRole("button", { name: "Leave room", exact: true }).click();
  await expect(page.locator("#channel-heading")).toContainText("left");
});
