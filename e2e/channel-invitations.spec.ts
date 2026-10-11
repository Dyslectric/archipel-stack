import { test, expect, type Page } from "@playwright/test";

async function login(page: Page, username: string) {
  await page.goto("/");
  await page.locator(`[data-persona=${username}]`).click();
  await expect(page.locator("#profile")).toBeVisible();
  return (await page.request.get("/api/session")).json();
}
async function post(page: Page, path: string, data: unknown, method = "POST") {
  const session = await (await page.request.get("/api/session")).json();
  const response = await page.request.fetch(`/api${path}`, {
    method, data, headers: { Origin: new URL(page.url()).origin, "X-CSRF-Token": session.csrf },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test("a channel role grants access separately and sends an invitation from the channel menu", async ({ page, browser }) => {
  const bobContext = await browser.newContext(), charlieContext = await browser.newContext();
  const bob = await bobContext.newPage(), charlie = await charlieContext.newPage();
  const origin = new URL(test.info().project.use.baseURL as string).origin;
  try {
    await login(page, "alice");
    // New contexts inherit no base URL, so use absolute URLs for navigation and API requests.
    await bob.goto(origin); await bob.locator("[data-persona=bob]").click();
    await expect(bob.locator("#profile")).toBeVisible();
    const member = (await (await bob.request.get(`${origin}/api/session`)).json()).user;
    await charlie.goto(origin); await charlie.locator("[data-persona=charlie]").click();
    await expect(charlie.locator("#profile")).toBeVisible();
    const c = await post(page, "/channels", { name: `invite-${Date.now()}`, mode: "timeline", visibility: "members", admission: "allowlist" });
    const role = await post(page, `/channels/${c.id}/roles`, { name: "Host", allow_access: true });
    await post(page, `/channels/${c.id}/members/${member.id}`, { rule: "allow" }, "PATCH");
    const session = await (await bob.request.get(`${origin}/api/session`)).json();
    expect((await bob.request.post(`${origin}/api/channels/${c.id}/join`, { data: {}, headers: { Origin: origin, "X-CSRF-Token": session.csrf } })).ok()).toBeTruthy();
    await post(page, `/channels/${c.id}/members/${member.id}`, { channel_role: role.id }, "PATCH");
    await page.goto(`/#/c/${c.id}`);
    await page.reload();
    await expect(page.locator("#channel-heading strong")).toHaveText(c.name);
    await page.goto(`/#/settings/channel/roles/${c.id}`);
    await expect(page.getByLabel("Allow people to access the channel").first()).toBeChecked();
    await bob.goto(`${origin}/#/c/${c.id}`);
    await bob.reload();
    await expect(bob.locator("#channel-heading strong")).toHaveText(c.name);
    await bob.goto(`${origin}/#/settings/channel/access/${c.id}`);
    await bob.getByLabel("Person's address", { exact: true }).fill("@charlie");
    await bob.getByRole("button", { name: "Allow access", exact: true }).click();
    await expect(bob.getByText("Access allowed.", { exact: true })).toBeVisible();
    const overview = await (await charlie.request.get(`${origin}/api/overview`)).json();
    expect(overview.dms).toEqual([]);
    await bob.goto(`${origin}/#/c/${c.id}`);
    await bob.getByRole("button", { name: "Channel options", exact: true }).click();
    await bob.getByRole("menuitem", { name: "Invite someone…", exact: true }).click();
    const invitation = bob.getByRole("dialog");
    await expect(invitation.getByText("Sends a direct message and grants access to join.")).toBeVisible();
    await invitation.locator("input").fill("@charlie");
    await invitation.getByRole("button", { name: "Send invitation", exact: true }).click();
    await expect(bob.getByText("Invitation sent as a direct message.", { exact: true })).toBeVisible();
    await charlie.goto(`${origin}/#/dm/${member.id}`);
    await charlie.getByRole("link", { name: "Join channel", exact: true }).click();
    await expect(charlie.getByRole("heading", { name: "Channel invitation" })).toBeVisible();
    await charlie.getByRole("button", { name: "Join channel", exact: true }).click();
    await expect(charlie.locator("#channel-heading strong")).toHaveText(c.name);
    await charlie.getByRole("button", { name: "Channel options", exact: true }).click();
    await expect(charlie.getByRole("menuitem", { name: "Invite someone…", exact: true })).toHaveCount(0);
  } finally {
    await bobContext.close(); await charlieContext.close();
  }
});
