import { test, expect, type Page } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function setup(page: Page, style: string, theme: string, mode = "timeline") {
  await page.addInitScript(({ style, theme }) => {
    localStorage.setItem("archipel-style", style);
    localStorage.setItem("archipel-theme", theme);
    localStorage.setItem("archipel-hours", "12");
  }, { style, theme });
  await page.goto("/");
  await page.locator("[data-persona=alice]").click();
  await expect(page.locator("#profile")).toBeVisible();
  const session = await (await page.request.get("/api/session")).json();
  const headers = { Origin: new URL(page.url()).origin, "X-CSRF-Token": session.csrf };
  const response = await page.request.post("/api/channels", {
    headers, data: { name: `mobile-${style}-${theme}-${mode}`, mode, visibility: "public", admission: "open" },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const channel = await response.json();
  await page.goto(`/#/c/${channel.id}`);
  await expect(page.locator("#message-body")).toBeVisible();
  return { channel, headers };
}

// Track blur as well as final focus: refocusing a replacement input still flickers the keyboard.
async function trackInput(page: Page) {
  await page.locator("#message-body").evaluate(el => {
    const tracking = window as unknown as { composeInput: Element; composeBlurs: number };
    tracking.composeInput = el;
    tracking.composeBlurs = 0;
    el.addEventListener("blur", () => tracking.composeBlurs++);
  });
}
async function sendWithoutBlur(page: Page, text: string, enter = false) {
  const body = page.locator("#message-body");
  await body.fill(text);
  if (enter) await body.press("Enter");
  else await page.locator("#send-message").tap();
  await expect(body).toHaveValue("");
  await expect(page.locator(".message-body").filter({ hasText: text })).toBeVisible();
  await expect(page.locator("#send-message")).toBeEnabled();
  expect(await page.evaluate(() => {
    const tracking = window as unknown as { composeInput: Element; composeBlurs: number };
    return { same: tracking.composeInput === document.querySelector("#message-body"),
      focused: document.activeElement === tracking.composeInput, blurs: tracking.composeBlurs };
  })).toEqual({ same: true, focused: true, blurs: 0 });
}

for (const style of ["default", "fusion-compact", "fusion-cozy"]) {
  for (const theme of ["light", "dark"]) {
    test(`${style} ${theme}: sends preserve mobile focus and Default timestamps have room`, async ({ page, browser }, info) => {
      const { headers } = await setup(page, style, theme);
      await trackInput(page);
      await sendWithoutBlur(page, "First mobile message");
      await sendWithoutBlur(page, "Second mobile message");
      await sendWithoutBlur(page, "Send with Enter", true);

      if (style === "default") for (const width of [320, 390, 1300]) {
        await page.setViewportSize({ width, height: 844 });
        if (width === 1300) await page.locator("html").evaluate(el => el.classList.remove("touch"));
        for (const scale of [100, 175]) {
          await page.evaluate(scale => document.documentElement.style.setProperty("--text-scale", String(scale / 100)), scale);
          const row = page.locator("article.message").filter({ hasText: "Second mobile message" });
          await row.hover();
          const gutter = row.locator(".msg-gutter time");
          await gutter.evaluate(el => el.textContent = "12:59 PM");
          await expect(gutter).toBeVisible();
          const [side, text, bounds] = await Promise.all([
            gutter.evaluate(el => {
              const range = document.createRange();
              range.selectNodeContents(el);
              const box = range.getBoundingClientRect();
              return { x: box.x, width: box.width };
            }), row.locator(".message-body").boundingBox(), row.boundingBox(),
          ]);
          expect(side!.x).toBeGreaterThanOrEqual(bounds!.x + 12);
          expect(text!.x - (side!.x + side!.width)).toBeGreaterThanOrEqual(12);
          expect(text!.x + text!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
          const first = page.locator("article.message").filter({ hasText: "First mobile message" });
          const [avatar, firstText, firstRow, meta] = await Promise.all([
            first.locator(".msg-gutter .avatar").boundingBox(), first.locator(".message-body").boundingBox(),
            first.boundingBox(), first.locator(".message-meta").boundingBox(),
          ]);
          expect(firstText!.x - (avatar!.x + avatar!.width)).toBeGreaterThanOrEqual(14);
          const leftPadding = avatar!.x - firstRow!.x;
          const rightPadding = firstText!.x - (avatar!.x + avatar!.width);
          expect(Math.abs(leftPadding - rightPadding)).toBeLessThanOrEqual(1);
          expect(Math.abs(avatar!.y + avatar!.height / 2 - (meta!.y + meta!.height))).toBeLessThanOrEqual(1);
          if (width === 390 && scale === 100 && theme === "dark")
            await page.screenshot({ path: info.outputPath("default-mobile-spacing.png") });
        }
      }

      // Direct conversations use a separate asynchronous send/refresh path.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => document.documentElement.style.setProperty("--text-scale", "1"));
      const peerContext = await browser.newContext(), peer = await peerContext.newPage();
      await peer.goto("/");
      await peer.locator("[data-persona=bob]").click();
      await expect(peer.locator("#profile")).toBeVisible();
      const { user: bob } = await (await peer.request.get("/api/session")).json();
      await peerContext.close();
      const dm = await page.request.post("/api/dms", { headers, data: { to: bob.actor_url, body: "Start mobile DM" } });
      expect(dm.ok(), await dm.text()).toBeTruthy();
      await page.goto(`/#/dm/${bob.id}`);
      await expect(page.locator("#message-body")).toBeVisible();
      await trackInput(page);
      await sendWithoutBlur(page, `${style} ${theme} mobile direct message`);
      await sendWithoutBlur(page, `${style} ${theme} another direct message`);
    });
  }
}

test("a sent Fusion thread reply resets its controls while keeping the input focused", async ({ page }) => {
  await setup(page, "fusion-cozy", "dark", "threaded");
  await page.locator("#thread-title").fill("Mobile thread");
  await trackInput(page);
  await sendWithoutBlur(page, "Thread opening");
  await expect(page.locator("#thread-title")).toHaveValue("");
  await page.locator(".message").filter({ hasText: "Thread opening" }).click();
  await expect(page.locator(".reply-banner")).toBeVisible();
  await trackInput(page);
  await sendWithoutBlur(page, "Thread reply");
  await expect(page.locator(".reply-banner")).toHaveCount(0);
  await expect(page.locator("#thread-title")).toBeVisible();
  await expect(page.locator("#send-message")).toHaveText("Post thread");
  await page.locator("#thread-title").fill("Next mobile thread");
  await trackInput(page);
  await sendWithoutBlur(page, "Next thread opening");
});
