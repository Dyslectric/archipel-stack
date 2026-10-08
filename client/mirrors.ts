import { $, api, esc, go, onSubmit, state, type Channel } from "./shared.js";

// Mirroring starts from the thing mirrored: a channel followed from another instance, or a joined
// XMPP room, becomes a source of a mirror the reader owns. Channels hosted here are never offered.
export function mirrorDialog(
  kind: "channel" | "xmpp",
  source: string,
  label: string,
  mode: Channel["mode"] = "timeline",
) {
  if (document.querySelector(".mirror-dialog")) return;
  const mine = state.channels.filter(
    // A mirror keeps the format of its sources, so only mirrors of this format can take it.
    (c) => c.mirror && c.mode === mode && c.owner_id === state.session.user!.id,
  );
  const dialog = document.createElement("dialog");
  dialog.className = "card dialog mirror-dialog";
  dialog.innerHTML = `<h2>Mirror ${esc(label)}</h2><p class="muted small">A mirror is a channel you own on ${esc(state.session.instance)} that keeps a copy of what you receive from here. The source isn't told, and nobody can write in the mirror until you open it.</p>
    <form class="stack"><label>Copy into<select name="mirror">${mine.map((c) => `<option value="${c.id}">#${esc(c.name)}</option>`).join("")}<option value="">A new mirror…</option></select></label>
    <div class="stack" data-new><label>Mirror name<span class="input-prefix"><span>#</span><input name="name" minlength="2" maxlength="40" pattern="[a-zA-Z0-9][a-zA-Z0-9_\\-]{1,39}" autocomplete="off"></span></label>
    <label>Who can read it?<select name="visibility"><option value="members">Only people I invite</option><option value="public">Everyone on this instance</option></select></label></div>
    <p class="form-error" role="alert"></p><div class="row end"><button type="button" class="secondary" data-cancel>Cancel</button><button>Mirror</button></div></form>`;
  document.body.append(dialog);
  const select = $<HTMLSelectElement>("select[name=mirror]", dialog),
    fresh = $("[data-new]", dialog),
    name = $<HTMLInputElement>("input[name=name]", dialog);
  const choose = () => {
    fresh.hidden = !!select.value;
    name.required = !select.value;
  };
  select.addEventListener("change", choose);
  choose();
  $("[data-cancel]", dialog).addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  onSubmit($<HTMLFormElement>("form", dialog), async (data) => {
    let id = String(data.get("mirror") || "");
    if (!id) {
      const visibility = data.get("visibility");
      id = (
        await api<Channel>("/mirrors", "POST", {
          name: data.get("name"),
          description: `Mirror of ${label}`,
          mode,
          visibility,
          admission: visibility === "public" ? "open" : "allowlist",
        })
      ).id;
      // Should adding the source fail, the new mirror is there to retry with.
      state.channels = await api<Channel[]>("/channels");
      select.insertAdjacentHTML("afterbegin", `<option value="${id}">#${esc(String(data.get("name")).toLowerCase())}</option>`);
      select.value = id;
      choose();
    }
    await api(`/channels/${id}/mirror/sources`, "POST", { kind, source });
    state.channels = await api<Channel[]>("/channels");
    dialog.close();
    go(`#/settings/channel/mirror/${id}`);
  });
  dialog.showModal();
}
