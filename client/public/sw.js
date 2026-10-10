// Archipel Web's service worker: shows the notifications the instance pushes (src/push.ts), and takes
// the reader to the conversation when one is clicked. It keeps nothing and answers no requests.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const windows = () =>
  self.clients.matchAll({ type: "window", includeUncontrolled: true });

self.addEventListener("push", (event) => {
  let notice = {};
  try {
    notice = event.data.json();
  } catch {
    /* A message that cannot be read still says something arrived. */
  }
  event.waitUntil(
    (async () => {
      // Someone looking at Archipel Web sees what is new there already.
      if (!notice.test && (await windows()).some((client) => client.focused))
        return;
      await self.registration.showNotification(notice.title || "Archipel Web", {
        body: notice.body || "Something new was said.",
        tag: notice.tag,
        renotify: !!notice.tag,
        icon: "/icon-192.png",
        badge: "/badge.png",
        data: { url: notice.url || "/" },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin)
    .href;
  event.waitUntil(
    (async () => {
      const open = (await windows())[0];
      if (!open) return self.clients.openWindow(url);
      open.postMessage({ type: "open", url });
      return open.focus();
    })(),
  );
});
