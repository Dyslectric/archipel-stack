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
        icon: notice.icon || "/icon-192.png",
        badge: "/badge.png",
        data: { url: notice.url || "/" },
      });
    })(),
  );
});

// The browser replaced its subscription or let it go, with no page open to notice: the instance
// is told where to send now, for whoever is signed in here.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const key = event.oldSubscription?.options.applicationServerKey;
      const sub =
        event.newSubscription ||
        (key &&
          (await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: key,
          })));
      if (!sub) return;
      const { csrf } = await (await fetch("/api/session")).json();
      if (!csrf) return;
      const { endpoint, keys } = sub.toJSON();
      await fetch("/api/push", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ endpoint, keys }),
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
