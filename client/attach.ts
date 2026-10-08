import { icon, state, toast } from "./shared.js";

// Pictures and videos go into a message as ![name](address), where the cursor is: chosen with the
// paperclip, pasted, or dropped on the box. The address is the file on this instance.
const accept = "image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm";
const boxes = "#message-body, .inline-form textarea, #xmpp-composer textarea";
export const canAttach = () => !!state.session.user?.attachments;
export const attachButton = (attrs: string) =>
  canAttach()
    ? `<button type="button" class="icon-button" ${attrs} aria-label="Attach an image or video" title="Attach an image or video">${icon("paperclip")}</button>`
    : "";

function put(area: HTMLTextAreaElement, text: string) {
  const at = area.selectionStart ?? area.value.length,
    gap = at && !/\s$/.test(area.value.slice(0, at)) ? " " : "";
  area.setRangeText(gap + text, at, area.selectionEnd ?? at, "end");
  area.dispatchEvent(new Event("input", { bubbles: true }));
}
function swap(area: HTMLTextAreaElement, from: string, to: string) {
  const at = area.value.indexOf(from);
  if (at < 0) {
    // The placeholder was edited away; the file still goes in.
    if (to) put(area, to);
    return;
  }
  const caret = area.selectionStart;
  area.setRangeText(to, at, at + from.length, "preserve");
  if (caret >= at + from.length)
    area.selectionStart = area.selectionEnd = caret + to.length - from.length;
  area.dispatchEvent(new Event("input", { bubbles: true }));
}
async function upload(file: File) {
  const response = await fetch("/api/attachments", {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-CSRF-Token": state.session.csrf || "",
      "X-Filename": encodeURIComponent(file.name.slice(0, 100)),
    },
    body: file,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The file could not be attached.");
  return data as { url: string; name: string };
}
export async function attachFiles(area: HTMLTextAreaElement, files: File[]) {
  if (!canAttach()) return toast("Your role does not allow attaching files.", true);
  for (const file of files.slice(0, 10)) {
    const video = file.type.startsWith("video/");
    if (!accept.split(",").includes(file.type)) {
      toast(`${file.name}: only PNG, JPEG, GIF and WebP images and MP4 and WebM videos can be attached.`, true);
      continue;
    }
    if (file.size > (video ? 52428800 : 10485760)) {
      toast(`${file.name}: ${video ? "videos can be up to 50" : "images can be up to 10"} MiB.`, true);
      continue;
    }
    const waiting = `[Uploading ${file.name.replace(/[[\]()]/g, "")}…]`;
    put(area, waiting);
    try {
      const sent = await upload(file);
      swap(area, waiting, `![${sent.name}](${sent.url})`);
    } catch (error) {
      swap(area, waiting, "");
      toast((error as Error).message, true);
    }
  }
}
export function pickFiles(area: HTMLTextAreaElement) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.multiple = true;
  input.addEventListener("change", () => {
    area.focus();
    void attachFiles(area, [...(input.files || [])]);
  });
  input.click();
}

const box = (e: Event) =>
  canAttach() ? (e.target as Element).closest?.<HTMLTextAreaElement>(boxes) : null;
document.addEventListener("paste", (e) => {
  const area = box(e),
    files = [...(e.clipboardData?.files || [])];
  if (!area || !files.length) return;
  e.preventDefault();
  void attachFiles(area, files);
});
document.addEventListener("dragover", (e) => {
  if (box(e) && e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
document.addEventListener("drop", (e) => {
  const area = box(e),
    files = [...(e.dataTransfer?.files || [])];
  if (!area || !files.length) return;
  e.preventDefault();
  area.focus();
  void attachFiles(area, files);
});
// A spoiler shows what it hides when clicked or opened from the keyboard.
document.addEventListener("click", (e) => {
  (e.target as Element).closest?.(".spoiler")?.classList.toggle("shown");
});
document.addEventListener("keydown", (e) => {
  const spoiler = (e.target as Element).closest?.(".spoiler");
  if (spoiler && e.target === spoiler && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    spoiler.classList.toggle("shown");
  }
});
