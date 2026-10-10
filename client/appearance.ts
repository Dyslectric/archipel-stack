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
export function applyStyle(value?: string) {
  if (value === undefined) {
    try { value = localStorage.getItem("archipel-style") || "default"; }
    catch { value = "default"; }
  }
  document.documentElement.dataset.style = valid(value) ? value : "default";
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
  if (event.key !== "archipel-style" && event.key !== null) return;
  applyStyle();
  document.dispatchEvent(new Event("appearance-change"));
});
