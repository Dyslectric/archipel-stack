export type AppStyle = "default" | "fusion-compact" | "fusion-cozy";
const styles = [
  ["default", "Default", "The original layout, with rounded cards and grouped messages."],
  ["fusion-compact", "Fusion Compact", "Framed panes and dense message columns, without profile pictures."],
  ["fusion-cozy", "Fusion Cozy", "Framed panes with more space and profile pictures beside messages and members."],
] as const;
const valid = (value: unknown): value is AppStyle => styles.some(([key]) => key === value);
export const appStyle = (): AppStyle => {
  const value = document.documentElement.dataset.style;
  return valid(value) ? value : "default";
};
export const isFusion = () => appStyle() !== "default";
let scale = 100;
export function applyTextScale(value?: number) {
  if (value === undefined) {
    try { value = Number(localStorage.getItem("archipel-text-scale") || 100); }
    catch { value = 100; }
  }
  scale = Number.isFinite(value) && value >= 85 && value <= 175 ? Math.round(value) : 100;
  document.documentElement.style.setProperty("--text-scale", String(scale / 100));
  for (const input of document.querySelectorAll<HTMLInputElement>("[data-text-scale]")) {
    input.value = String(scale);
    input.setAttribute("aria-valuetext", `${scale}%`);
  }
  for (const output of document.querySelectorAll("[data-text-scale-value]")) output.textContent = `${scale}%`;
}
export const textScaleControls = () => `<div class="text-scale-control"><label for="text-scale">Text size <output for="text-scale" data-text-scale-value>${scale}%</output></label><input id="text-scale" data-text-scale type="range" min="85" max="175" step="5" value="${scale}" aria-valuetext="${scale}%"><button type="button" class="secondary" data-reset-text-scale>Reset to 100%</button></div>`;
function saveTextScale(value: number) {
  applyTextScale(value);
  try { localStorage.setItem("archipel-text-scale", String(scale)); } catch { /* Keep the choice for this visit. */ }
  document.dispatchEvent(new Event("text-scale-change"));
}
document.addEventListener("input", event => {
  const input = event.target as HTMLInputElement;
  if (input.matches("[data-text-scale]")) saveTextScale(Number(input.value));
});
document.addEventListener("click", event => {
  if ((event.target as Element).closest("[data-reset-text-scale]")) saveTextScale(100);
});
// Times on a 12- or a 24-hour clock. Until one is chosen, Fusion shows 24 hours and Default what the device's language uses.
const savedHours = () => {
  try {
    const value = localStorage.getItem("archipel-hours");
    return value === "12" || value === "24" ? value : null;
  } catch { return null; }
};
export const hour12 = () =>
  (savedHours() || (isFusion() || !new Intl.DateTimeFormat([], { hour: "numeric" }).resolvedOptions().hour12 ? "24" : "12")) === "12";
export function applyHours() {
  const hours = hour12() ? "12" : "24";
  document.documentElement.dataset.hours = hours;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-set-hours]")) {
    const selected = button.dataset.setHours === hours;
    button.classList.toggle("on", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
}
export const hourChoices = () => `<div class="seg" role="group" aria-label="Time format">${[["12", "12-hour", "1:30 PM"], ["24", "24-hour", "13:30"]].map(([key, label, sample]) => `<button type="button" data-set-hours="${key}" class="${hour12() === (key === "12") ? "on" : ""}" aria-pressed="${hour12() === (key === "12")}">${label} <span class="muted">${sample}</span></button>`).join("")}</div>`;
document.addEventListener("click", event => {
  const value = (event.target as Element).closest<HTMLElement>("[data-set-hours]")?.dataset.setHours;
  if (value !== "12" && value !== "24") return;
  try { localStorage.setItem("archipel-hours", value); } catch { /* Keep the choice for this visit. */ }
  applyHours();
  document.dispatchEvent(new Event("appearance-change"));
});
export function applyStyle(value?: string) {
  if (value === undefined) {
    try { value = localStorage.getItem("archipel-style") || "default"; }
    catch { value = "default"; }
  }
  document.documentElement.dataset.style = valid(value) ? value : "default";
  applyHours();
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-set-style]")) {
    const selected = button.dataset.setStyle === appStyle();
    button.classList.toggle("on", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
}
export const styleChoices = () => `<div class="style-choices" role="group" aria-label="Interface style">${styles.map(([key, label, about]) => `<button type="button" data-set-style="${key}" class="style-choice${appStyle() === key ? " on" : ""}" aria-pressed="${appStyle() === key}"><span class="style-preview ${key}" aria-hidden="true"><span></span><span></span><span></span></span><strong>${label}</strong><span class="muted small">${about}</span></button>`).join("")}</div>`;
document.addEventListener("click", event => {
  const value = (event.target as Element).closest<HTMLElement>("[data-set-style]")?.dataset.setStyle;
  if (!valid(value)) return;
  try { localStorage.setItem("archipel-style", value); } catch { /* Keep the choice for this visit. */ }
  applyStyle(value);
  document.dispatchEvent(new Event("appearance-change"));
});
window.addEventListener("storage", event => {
  if (event.key === "archipel-text-scale" || event.key === null) {
    applyTextScale();
    document.dispatchEvent(new Event("text-scale-change"));
  }
  if (event.key !== "archipel-style" && event.key !== "archipel-hours" && event.key !== null) return;
  applyStyle();
  document.dispatchEvent(new Event("appearance-change"));
});
