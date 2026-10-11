import { api, go, state } from "./shared.js";

// Notifications on this device: the browser subscribes to its push service through a service
// worker (public/sw.js) and the instance is told where to send. Each browser is turned on
// separately, and signing out turns it off again.
const USER = "archipel-push-user";
let on = false;
export const pushOn = () => on;
// What the look on start found when it did not simply find notifications on: why a device went
// quiet is otherwise known to nobody.
let found = "";
export const pushFound = () => found;
export const pushSupported = () =>
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
export const pushBlocked = () =>
  pushSupported() && Notification.permission === "denied";

function remember(user: string | null) {
  try {
    if (user) localStorage.setItem(USER, user);
    else localStorage.removeItem(USER);
  } catch {
    /* Without storage the next sign-in asks again. */
  }
}
function remembered() {
  try {
    return localStorage.getItem(USER);
  } catch {
    return null;
  }
}
const bytes = (key: string) =>
  Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
// Whether the browser subscribed with this instance's current key.
function current(sub: PushSubscription, key: string) {
  const used = sub.options.applicationServerKey;
  return !used || new Uint8Array(used).join() === bytes(key).join();
}
const subscribe = (worker: ServiceWorkerRegistration, key: string) =>
  worker.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: bytes(key),
  });
async function register(sub: PushSubscription) {
  const { endpoint, keys } = sub.toJSON();
  await api("/push", "PUT", { endpoint, keys });
  on = true;
  remember(state.session.user!.id);
}
export async function enablePush() {
  if (!pushSupported())
    throw new Error("This browser cannot show notifications.");
  if ((await Notification.requestPermission()) !== "granted")
    throw new Error(
      "Notifications are blocked for this site. Allow them in the browser's site settings.",
    );
  const { public_key } = await api<{ public_key: string }>("/push"),
    worker = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  let sub = await worker.pushManager.getSubscription();
  if (sub && !current(sub, public_key)) {
    await sub.unsubscribe();
    sub = null;
  }
  await register(sub || (await subscribe(worker, public_key)));
}
export async function disablePush() {
  on = false;
  remember(null);
  if (!pushSupported()) return;
  const worker = await navigator.serviceWorker.getRegistration();
  await (await worker?.pushManager.getSubscription())?.unsubscribe();
  await api("/push", "DELETE");
}
// On start: a browser where this account turned notifications on keeps them through a new
// session; one left subscribed by someone else is let go.
export async function syncPush() {
  on = false;
  found = "";
  if (!pushSupported()) return;
  if (Notification.permission !== "granted")
    return void (found = `The browser's permission was "${Notification.permission}".`);
  const worker = await navigator.serviceWorker.getRegistration(),
    sub = await worker?.pushManager.getSubscription();
  if (!worker) return void (found = "The browser had no service worker for this site.");
  if (remembered() !== state.session.user?.id) {
    found = `${remembered() ? "Another account" : "Nobody"} was remembered as having turned them on here; the browser held ${sub ? "a subscription, which was let go" : "no subscription"}.`;
    if (sub) {
      await sub.unsubscribe();
      remember(null);
    }
    return;
  }
  try {
    const status = await api<{ public_key: string; endpoint: string | null }>(
      "/push",
    );
    void worker.update().catch(() => {});
    if (sub && current(sub, status.public_key) && status.endpoint === sub.endpoint)
      return void (on = true);
    found = `${!sub ? "The browser held no subscription" : !current(sub, status.public_key) ? "The browser's subscription was made with another instance key" : "The browser held a subscription"}; the instance held ${!status.endpoint ? "none" : status.endpoint === sub?.endpoint ? "the same one" : "a different one"} for this session.`;
    // The browser let its subscription go, or the instance holds none for this session: it is
    // new, or the push service refused what was sent. A subscription made now is one that works.
    await sub?.unsubscribe();
    await register(await subscribe(worker, status.public_key));
    found += " A new subscription was made.";
  } catch (error) {
    found += ` It failed: ${(error as Error)?.name}: ${(error as Error)?.message}`;
    throw error;
  }
}
export const testPush = () => api("/push/test", "POST", {});

// A click on a notification, with Archipel Web already open: the worker asks this tab to go there.
if ("serviceWorker" in navigator)
  navigator.serviceWorker.addEventListener("message", (event) => {
    const url = event.data?.type === "open" ? event.data.url : null;
    if (typeof url === "string")
      go(new URL(url, location.origin).hash || "#/");
  });
