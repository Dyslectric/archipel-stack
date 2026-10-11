import { icon, state, toast } from "./shared.js";
import { markdownQuote } from "./markdown.js";

// Files go into a message as ![name](address), where the cursor is: chosen with the paperclip,
// pasted, or dropped on the box. The address is the file on this instance. Pictures and videos
// a browser shows are shown in the message; anything else is there to download.
const pictures = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const boxes = "#message-body, .inline-form textarea, #xmpp-composer textarea";
const uploading = new WeakMap<HTMLTextAreaElement, number>();
export const canAttach = () => !!state.session.user?.attachments;
export const attachButton = (attrs: string) =>
  canAttach()
    ? `<button type="button" class="icon-button" ${attrs} aria-label="Attach a file" title="Attach a file">${icon("paperclip")}</button>`
    : "";

function put(area: HTMLTextAreaElement, text: string) {
  const at = area.selectionStart ?? area.value.length,
    gap = at && !/\s$/.test(area.value.slice(0, at)) ? " " : "";
  area.setRangeText(gap + text, at, area.selectionEnd ?? at, "end");
  area.dispatchEvent(new Event("input", { bubbles: true }));
}
// A quoted message goes in on lines of its own, with the cursor left under it for the answer.
export function quoteInto(area: HTMLTextAreaElement, body: string) {
  const at = area.selectionStart ?? area.value.length,
    before = area.value.slice(0, at),
    gap = !before.trim() ? "" : "\n\n".slice(/\n*$/.exec(before)![0].length);
  area.focus();
  area.setRangeText(`${gap}${markdownQuote(body)}\n\n`, at, area.selectionEnd ?? at, "end");
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
  if (files.length > 10) toast("Attach up to 10 files at a time. Only the first 10 will be uploaded.", true);
  uploading.set(area, (uploading.get(area) || 0) + 1);
  area.setAttribute("aria-busy", "true");
  try {
    for (const file of files.slice(0, 10)) {
      const picture = pictures.includes(file.type);
      if (!file.size) {
        toast(`${file.name}: the file is empty.`, true);
        continue;
      }
      if (file.size > (picture ? 10485760 : 52428800)) {
        toast(`${file.name}: ${picture ? "images can be up to 10" : "files can be up to 50"} MiB.`, true);
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
  } finally {
    const remaining = (uploading.get(area) || 1) - 1;
    uploading.set(area, remaining);
    if (!remaining) area.removeAttribute("aria-busy");
  }
}
export function pickFiles(area: HTMLTextAreaElement) {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.addEventListener("change", () => {
    area.focus();
    void attachFiles(area, [...(input.files || [])]);
  });
  input.click();
}

const box = (e: Event) =>
  canAttach() ? (e.target as Element).closest?.<HTMLTextAreaElement>(boxes) : null;
// Every composer (including edits, replies and XMPP rooms) waits for its files before sending.
document.addEventListener("submit", (e) => {
  const area = (e.target as HTMLFormElement).querySelector<HTMLTextAreaElement>("textarea");
  if (!area || !uploading.get(area)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  toast("Wait for your files to finish uploading before sending.", true);
}, true);
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
