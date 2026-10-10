// Signing in a program that has no browser of its own, such as a terminal client. The program
// asks for a sign-in and is given an address to show its user; the user opens it in a browser,
// signs in there as they always do, and says yes; the program, asking meanwhile, is then handed
// a session of its own. What the program holds while it waits is never shown in the browser,
// and the short code the browser sees cannot be turned into a session without it.
import { randomInt } from "node:crypto";
import { Problem, Store, hash, randomToken, type User } from "./store.js";

const LIFE = 10 * 60000,
  INTERVAL = 2, // seconds between a program's questions
  MOST = 1000; // sign-ins waiting at once
// No vowels, so no words; none of the letters mistaken for one another or for digits.
const LETTERS = "BCDFGHJKLMNPQRSTVWXZ";

export class DeviceSignIn {
  // Sign-ins wait in the database, so one being answered outlasts a restart of the server.
  constructor(
    private store: Store,
    private baseUrl: string,
  ) {}
  private sweep() {
    this.store.db.prepare("DELETE FROM device_flows WHERE expires_at<=?").run(Date.now());
  }
  /** A code as a person may have typed it, or "" when it could not be one. */
  code(value: unknown) {
    const letters = typeof value === "string" ? value.toUpperCase().replace(/[^A-Z]/g, "") : "";
    return letters.length === 8 && [...letters].every((c) => LETTERS.includes(c))
      ? `${letters.slice(0, 4)}-${letters.slice(4)}`
      : "";
  }
  begin() {
    const db = this.store.db;
    this.sweep();
    if (Number(db.prepare("SELECT COUNT(*) AS n FROM device_flows").get()?.n) >= MOST)
      throw new Problem(503, "Too many sign-ins are waiting. Try again shortly.");
    let code = "";
    do {
      code = this.code(Array.from({ length: 8 }, () => LETTERS[randomInt(LETTERS.length)]).join(""));
    } while (db.prepare("SELECT 1 FROM device_flows WHERE code_hash=?").get(hash(code)));
    const device = randomToken();
    db.prepare("INSERT INTO device_flows VALUES(?,?,NULL,?)").run(hash(device), hash(code), Date.now() + LIFE);
    return {
      device_code: device,
      user_code: code,
      verification_uri: `${this.baseUrl}/auth/device?code=${code}`,
      expires_in: LIFE / 1000,
      interval: INTERVAL,
    };
  }
  /** Whether this code is still waiting for someone's answer. */
  waiting(code: string) {
    return !!this.store.db
      .prepare("SELECT 1 FROM device_flows WHERE code_hash=? AND user_id IS NULL AND expires_at>?")
      .get(hash(code), Date.now());
  }
  /** The signed-in user's answer to the program showing this code. */
  decide(user: User, value: unknown, approve: boolean) {
    this.store.active(user.id);
    const code = hash(this.code(value)),
      db = this.store.db;
    // Only a sign-in nobody has answered yet takes an answer.
    const answered = approve
      ? db.prepare("UPDATE device_flows SET user_id=? WHERE code_hash=? AND user_id IS NULL AND expires_at>?").run(user.id, code, Date.now())
      : db.prepare("DELETE FROM device_flows WHERE code_hash=? AND user_id IS NULL AND expires_at>?").run(code, Date.now());
    if (!answered.changes)
      throw new Problem(404, "This sign-in is no longer waiting. Start again from the program.");
  }
  /** The program asking whether it has been let in: once it has, it is given its session, once. */
  poll(device: unknown) {
    const wanted = typeof device === "string" && device ? hash(device) : "",
      db = this.store.db;
    const flow = db
      .prepare("SELECT user_id FROM device_flows WHERE device_hash=? AND expires_at>?")
      .get(wanted, Date.now()) as { user_id: string | null } | undefined;
    if (!flow)
      throw new Problem(404, "This sign-in expired or was declined. Start again.");
    if (!flow.user_id) return { status: "pending" as const };
    // Taken before the session is made: asked twice at once, only one of them is given it.
    if (!db.prepare("DELETE FROM device_flows WHERE device_hash=?").run(wanted).changes)
      throw new Problem(404, "This sign-in expired or was declined. Start again.");
    this.store.active(flow.user_id);
    return { status: "approved" as const, ...this.store.createSession(flow.user_id) };
  }
}

const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
/** The page a browser is shown. `body` is HTML; everything put into it is escaped by the caller. */
function page(heading: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(heading)} · Archipel Server</title><style>
:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}
main{max-width:26rem;margin:1rem;padding:1.5rem 1.75rem;border:1px solid color-mix(in srgb,CanvasText 20%,transparent);border-radius:12px}
h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:.5rem 0}.muted{opacity:.7;font-size:.9rem}
.code{font:600 1.75rem/1 ui-monospace,monospace;letter-spacing:.12em;text-align:center;margin:1.25rem 0}
form{display:flex;gap:.75rem;margin-top:1.25rem}input,button{font:inherit;padding:.55rem 1rem;border-radius:8px;border:1px solid color-mix(in srgb,CanvasText 30%,transparent);background:transparent;color:inherit}
input{flex:1;min-width:0;text-transform:uppercase}button{cursor:pointer}button.go{background:CanvasText;color:Canvas;border-color:CanvasText;font-weight:600}
</style></head><body><main><h1>${esc(heading)}</h1>${body}</main></body></html>`;
}
export const devicePages = {
  /** Asks for the code, when the address was opened without one. */
  ask: (wrong = false) =>
    page(
      "Sign in a program",
      `${wrong ? "<p>That is not a sign-in code.</p>" : ""}<p>Type the code the program is showing.</p><form method="get" action="/auth/device"><input name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="XXXX-XXXX" aria-label="Sign-in code" required autofocus><button class="go">Continue</button></form>`,
    ),
  signIn: (code: string) =>
    page(
      "Sign in first",
      `<p>Sign in to this instance in this browser, then open this page again.</p><p><a href="/">Sign in</a> · <a href="/auth/device?code=${esc(code)}">I have signed in</a></p>`,
    ),
  confirm: (code: string, user: User, instance: string, csrf: string) =>
    page(
      "Sign in a program?",
      `<p>A program is asking to sign in to ${esc(instance)} as <strong>@${esc(user.username)}</strong>. It should be showing this code:</p><p class="code">${esc(code)}</p><p class="muted">Say yes only if you started this yourself and the code matches. The program will be able to do everything you can.</p><form method="post" action="/auth/device"><input type="hidden" name="code" value="${esc(code)}"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="go" name="decision" value="approve">Sign it in</button><button name="decision" value="deny">No</button></form>`,
    ),
  said: (heading: string, message: string) => page(heading, `<p>${esc(message)}</p>`),
};
