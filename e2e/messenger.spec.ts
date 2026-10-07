import { test, expect, type Page } from "@playwright/test";

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
  await page
    .getByRole("button", { name: "Create channel", exact: true })
    .click();
  await page.getByLabel("Channel name").fill(name);
  await page
    .getByLabel("Description", { exact: true })
    .fill("A place to gather.");
  await page.getByLabel("Conversation style").selectOption(mode);
  await page.getByLabel("Who can read?").selectOption(visibility);
  await page.getByLabel("Who can join?").selectOption(admission);
  await page
    .locator("dialog")
    .getByRole("button", { name: "Create channel" })
    .click();
  await expect(page.locator("#channel-heading strong")).toHaveText(name);
}
async function openChannel(page: Page, name: string) {
  await page.locator("#browse").click();
  await page.getByRole("textbox", { name: "Search channels" }).fill(name);
  await page.locator(".browse-channel").filter({ hasText: name }).click();
  await expect(page.locator("#channel-heading strong")).toHaveText(name);
}
async function send(page: Page, value: string) {
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(value);
  await page.getByRole("button", { name: "Send message" }).click();
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
  await page.getByRole("button", { name: "New topic" }).click();
  await page.getByLabel("Topic title").fill("Planning");
  await page.getByRole("button", { name: "Create topic" }).click();
  await send(page, "Our first plan.");
  await page.getByRole("button", { name: "Reply to alice" }).click();
  await send(page, "A follow-up.");
  await page.getByRole("button", { name: "New topic" }).click();
  await page.getByLabel("Topic title").fill("Building");
  await page.getByRole("button", { name: "Create topic" }).click();
  await expect(
    page.locator(".message-body").filter({ hasText: "Our first plan." }),
  ).toHaveCount(0);
  await send(page, "Time to build.");
  await page
    .getByLabel("Conversation topic")
    .selectOption({ label: "Planning" });
  await expect(
    page.locator(".message-body").filter({ hasText: "Our first plan." }),
  ).toBeVisible();
  await expect(
    page.locator(".message-body").filter({ hasText: "Time to build." }),
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
  await page.getByRole("button", { name: "Reply to alice" }).click();
  await send(page, "First reply.");
  await page
    .locator(".message")
    .filter({ hasText: "First reply." })
    .getByRole("button", { name: "Reply to alice" })
    .click();
  await send(page, "Nested reply.");
  await expect(
    page.locator(".depth-2").filter({ hasText: "Nested reply." }),
  ).toBeVisible();
  const root = page.locator(".message").filter({ hasText: "Start here." });
  await root.hover();
  await root.getByRole("button", { name: "Edit message", exact: true }).click();
  await page
    .locator("dialog")
    .getByLabel("Thread title", { exact: true })
    .fill("An improved idea");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator(".thread-title")).toHaveText("An improved idea");
  await expect(page.locator(".depth-2")).toContainText("Nested reply.");
  await root.hover();
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
  await bob.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Channel settings" }).click();
  await page
    .getByRole("combobox", { name: "Person", exact: true })
    .selectOption({ label: "@bob" });
  await page
    .getByRole("combobox", { name: "Action", exact: true })
    .selectOption("allow");
  await page.getByRole("button", { name: "Apply change" }).click();
  await expect(page.locator("dialog")).toHaveCount(0);
  await expect(async () => {
    await bob.reload();
    await expect(bob.locator("#profile")).toBeVisible();
    await bob.locator("#browse").click();
    await bob.getByLabel("Search channels").fill("quiet-island");
    await expect(bob.locator(".browse-channel")).toHaveCount(1);
  }).toPass();
  await bob.locator(".browse-channel").click();
  await expect(bob.locator("dialog")).toHaveCount(0);
  await expect(bob.locator("#channel-heading strong")).toHaveText(
    "quiet-island",
  );
  await send(bob, "A private hello.");
  await expect(
    page.locator(".message-body").filter({ hasText: "A private hello." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Channel settings" }).click();
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

async function openAdmin(page: Page) {
  await page.locator("#profile").click();
  await page
    .getByRole("button", { name: "Instance administration", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Instance administration", exact: true }),
  ).toBeVisible();
}

test("standard and custom shortcodes render, and deleted custom emoji fall back to text", async ({
  page,
  browser,
}) => {
  await login(page);
  await createChannel(page, "emoji-island");
  await openAdmin(page);
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
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Hello :smile: ");
  await page.getByRole("button", { name: "Choose emoji" }).click();
  await page.getByLabel("Search emoji", { exact: true }).fill("island_wave");
  await page.locator('[data-emoji="island_wave"]').click();
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
  await openAdmin(page);
  await page
    .locator(".admin-emojis")
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await expect(page.locator(".admin-emojis img")).toHaveCount(0);
  await page.getByRole("button", { name: "Close dialog" }).click();
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
  await page
    .locator("dialog[open]")
    .getByRole("textbox", { name: "Message", exact: true })
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
  await page.getByRole("button", { name: "Close dialog" }).click();
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
  await page.locator("#profile").click();
  await page.getByLabel("Display name", { exact: true }).fill("Charlie");
  await page.getByRole("button", { name: "Save profile" }).click();
  await page.locator("#profile").click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator("[data-persona=charlie]")).toBeVisible();
});

async function openPersonalEmoji(page: Page) {
  await page.locator("#profile").click();
  await page.getByRole("button", { name: "Your emoji", exact: true }).click();
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
  await page.getByRole("button", { name: "Close dialog" }).click();
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
  await page.getByRole("button", { name: "Close dialog" }).click();
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
  await page
    .getByRole("button", { name: "Federation controls", exact: true })
    .click();
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
  await page.getByRole("button", { name: "Close dialog" }).click();
}
async function openFederated(page: Page) {
  await page.locator("#profile").click();
  await page
    .getByRole("button", { name: "Federated conversations", exact: true })
    .click();
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
  await createChannel(page, "federated-lounge");
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Federation and remote followers",
      exact: true,
    })
    .click();
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
  await page.getByRole("button", { name: "Close dialog" }).click();
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
  await send(bob, "Remote greeting.");
  await expect(
    page.locator(".message-body").filter({ hasText: "Remote greeting." }),
  ).toBeVisible();
  await openFederated(bob);
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
  await openFederated(page);
  await expect(page.locator("#federated-direct-list")).toContainText(
    "A federated private hello.",
  );
  await page.getByRole("button", { name: "Close dialog" }).click();
  await peerAdmin.locator("#profile").click();
  await peerAdmin
    .getByRole("button", { name: "Instance administration", exact: true })
    .click();
  await peerAdmin
    .getByRole("button", { name: "Federation controls", exact: true })
    .click();
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
  await bob.getByRole("button", { name: "Close dialog" }).click();
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
  await openAdmin(peer);
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
    .locator("div")
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
