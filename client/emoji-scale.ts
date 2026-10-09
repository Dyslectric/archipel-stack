// Custom emoji are stored as uploaded, often far larger than they are shown. A browser shrinking
// a big picture to a line of text in one step leaves it rough, so each one is resampled here, in
// halving steps, to the size it is shown at. The copy is offered through srcset: src stays the
// emoji's own address, which the rest of the client reads. Animated pictures are left alone.
const sizes = [32, 48, 64, 96, 128, 192];
const made = new Map<string, Promise<string | null>>();
const emojiUrl = /^\/api\/emojis\/[^/]+\/image$/;

function animated(bytes: Uint8Array, type: string) {
  if (type === "image/gif") return true;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  return head.includes("ANIM") || head.includes("acTL");
}
async function resample(url: string, target: number) {
  const response = await fetch(url);
  if (!response.ok) return null;
  const blob = await response.blob();
  if (animated(new Uint8Array(await blob.slice(0, 4096).arrayBuffer()), blob.type)) return null;
  const bitmap = await createImageBitmap(blob);
  let width = bitmap.width,
    height = bitmap.height;
  if (Math.max(width, height) < target * 1.5) return null;
  const scale = target / Math.max(width, height),
    endWidth = Math.max(1, Math.round(width * scale)),
    endHeight = Math.max(1, Math.round(height * scale));
  let source: CanvasImageSource = bitmap;
  for (;;) {
    const last = width / 2 <= endWidth;
    width = last ? endWidth : Math.round(width / 2);
    height = last ? endHeight : Math.max(1, Math.round(height / 2));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, width, height);
    source = canvas;
    if (last) return canvas.toDataURL("image/png");
  }
}
function fit(img: HTMLImageElement) {
  const url = img.getAttribute("src") || "";
  if (!emojiUrl.test(url) || img.srcset) return;
  const box = img.getBoundingClientRect(),
    shown = Math.max(box.width, box.height) * (window.devicePixelRatio || 1);
  if (!shown || Math.max(img.naturalWidth, img.naturalHeight) < shown * 1.5) return;
  const target = sizes.find((s) => s >= shown);
  if (!target) return;
  const key = `${url}@${target}`;
  if (!made.has(key)) made.set(key, resample(url, target).catch(() => null));
  void made.get(key)!.then((data) => {
    if (data && img.isConnected && img.getAttribute("src") === url) img.srcset = `${data} 1x`;
  });
}
// Load events do not bubble, but they can be caught on the way down.
document.addEventListener(
  "load",
  (e) => {
    if (e.target instanceof HTMLImageElement) fit(e.target);
  },
  true,
);
