import { icon } from "./shared.js";

// A picture or video in a message opens large, over the page: a click on the picture, or the
// corner button of the video. From there the arrows step through everything shown in the
// conversation, and Escape or a click beside it puts it away.
const shown = "a.attachment:not(.file), .attachment.video";
type Item = { url: string; name: string; video: HTMLVideoElement | null };
const item = (el: Element): Item => {
  const video = el.querySelector("video"),
    img = el.querySelector("img");
  return {
    url: video?.src || (el as HTMLAnchorElement).href,
    name: video?.title || img?.alt || "",
    video,
  };
};

function open(from: Element) {
  const elements = [...document.querySelectorAll(shown)].filter(el =>
    el.getClientRects().length && getComputedStyle(el).visibility !== "hidden" && !el.closest(".spoiler:not(.shown)"));
  let at = elements.indexOf(from);
  if (at < 0) return;
  const all = elements.map(item),
    opener = from.querySelector<HTMLElement>("[data-expand]") || from as HTMLElement;
  const dialog = document.createElement("dialog");
  dialog.className = "viewer";
  dialog.setAttribute("aria-label", "Attachment");
  dialog.innerHTML = `<div class="viewer-bar"><span class="viewer-name"></span><span class="viewer-count muted small" aria-live="polite"></span>
    <a class="icon-button" data-save target="_blank" rel="noopener noreferrer" aria-label="Download" title="Download">${icon("download")}</a>
    <a class="icon-button" data-original target="_blank" rel="noopener noreferrer" aria-label="Open in a new tab" title="Open in a new tab">${icon("external-link")}</a>
    <button type="button" class="icon-button" data-close aria-label="Close" title="Close">${icon("x")}</button></div>
    <button type="button" class="icon-button viewer-step" data-step="-1" aria-label="Previous" title="Previous">${icon("chevron-left")}</button>
    <div class="viewer-stage"></div><p class="viewer-error" role="status" hidden></p>
    <button type="button" class="icon-button viewer-step" data-step="1" aria-label="Next" title="Next">${icon("chevron-right")}</button>`;
  const stage = dialog.querySelector<HTMLElement>(".viewer-stage")!,
    error = dialog.querySelector<HTMLElement>(".viewer-error")!,
    save = dialog.querySelector<HTMLAnchorElement>("[data-save]")!;
  const fit = () => {
    const media = stage.querySelector("img, video");
    if (!media) return;
    const width = media instanceof HTMLImageElement ? media.naturalWidth : (media as HTMLVideoElement).videoWidth,
      height = media instanceof HTMLImageElement ? media.naturalHeight : (media as HTMLVideoElement).videoHeight;
    if (!width || !height || !stage.clientWidth || !stage.clientHeight) return;
    const scale = Math.min(stage.clientWidth / width, (stage.clientHeight - 12) / height);
    (media as HTMLElement).style.width = `${width * scale}px`;
    (media as HTMLElement).style.height = `${height * scale}px`;
  };
  const resize = new ResizeObserver(fit);
  resize.observe(stage);
  // A video carries on from where it was, and the one in the message takes the place back after.
  const leave = () => {
    const playing = stage.querySelector("video"),
      inline = all[at].video;
    if (playing && inline && playing.readyState >= 1) {
      // Live message updates may have replaced the inline element while the viewer was open.
      const current = inline.isConnected ? inline : [...document.querySelectorAll<HTMLVideoElement>(".attachment video")]
        .find(video => video.src === inline.src);
      if (current) {
        all[at].video = current;
        current.currentTime = playing.currentTime;
        current.volume = playing.volume;
        current.muted = playing.muted;
        current.playbackRate = playing.playbackRate;
      }
    }
    playing?.pause();
  };
  const show = () => {
    const { url, name, video } = all[at];
    error.hidden = true;
    const failed = () => {
      error.textContent = `This ${video ? "video" : "image"} could not be loaded. Try opening it in a new tab.`;
      error.hidden = false;
    };
    if (video) {
      const wasPlaying = !video.paused && !video.ended, position = video.currentTime;
      video.pause();
      const large = document.createElement("video");
      large.controls = large.playsInline = true;
      large.title = name;
      large.volume = video.volume;
      large.muted = video.muted;
      large.playbackRate = video.playbackRate;
      large.addEventListener("loadedmetadata", () => {
        fit();
        large.currentTime = position;
        if (wasPlaying && large.isConnected) void large.play().catch(() => {});
      }, { once: true });
      large.addEventListener("error", failed, { once: true });
      large.src = url;
      stage.replaceChildren(large);
    } else {
      const large = document.createElement("img");
      large.alt = name;
      large.referrerPolicy = "no-referrer";
      large.addEventListener("load", fit, { once: true });
      large.addEventListener("error", failed, { once: true });
      large.src = url;
      stage.replaceChildren(large);
    }
    dialog.querySelector(".viewer-name")!.textContent = name || (video ? "Video" : "Image");
    dialog.querySelector(".viewer-count")!.textContent = all.length > 1 ? `${at + 1} of ${all.length}` : "";
    dialog.querySelector<HTMLAnchorElement>("[data-original]")!.href = url;
    const download = new URL(url);
    // Cross-origin links need a download response from the source: browsers ignore their download attribute.
    if (/^\/media\/[A-Za-z0-9_-]{43}\.(png|jpg|gif|webp|mp4|webm)$/.test(download.pathname) && !download.search && !download.hash)
      download.search = "?download=1";
    save.href = download.href;
    save.download = name;
    for (const step of dialog.querySelectorAll<HTMLButtonElement>("[data-step]"))
      step.hidden = !all[at + Number(step.dataset.step)];
  };
  const step = (by: number) => {
    if (!all[at + by]) return;
    leave();
    at += by;
    show();
  };
  dialog.addEventListener("click", (e) => {
    const hit = e.target as Element,
      by = hit.closest<HTMLElement>("[data-step]");
    if (by) step(Number(by.dataset.step));
    else if (hit === dialog || hit === stage || hit.closest("[data-close]")) dialog.close();
  });
  dialog.addEventListener("keydown", (e) => {
    // The arrows belong to a video that has the focus: they seek.
    if ((e.target as Element).closest("video")) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      step(e.key === "ArrowLeft" ? -1 : 1);
    }
  });
  const navigate = () => dialog.close();
  addEventListener("hashchange", navigate);
  dialog.addEventListener("close", () => {
    leave();
    resize.disconnect();
    removeEventListener("hashchange", navigate);
    dialog.remove();
    if (opener.isConnected) opener.focus({ preventScroll: true });
  });
  document.body.append(dialog);
  show();
  dialog.showModal();
  dialog.querySelector<HTMLElement>("[data-close]")!.focus();
}

document.addEventListener("click", (e) => {
  // A click meant for a new tab or window is left to do that.
  if (e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const hit = e.target as Element,
    from = hit.closest?.("[data-expand]")?.closest(shown) || hit.closest?.("a.attachment:not(.file)");
  if (!from) return;
  e.preventDefault();
  open(from);
});
