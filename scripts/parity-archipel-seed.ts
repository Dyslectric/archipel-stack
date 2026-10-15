// Seeds one Archipel instance for the parity benchmark: local members with
// sessions, spread across timeline rooms. The measured server is the ordinary
// production entry point started afterwards against the same database.
import { writeFileSync } from "node:fs";
import { Store } from "../src/store.js";
import { PostgresDatabase } from "../src/db.js";

const [url, schema, members, rooms, history, output, origin] = process.argv.slice(2);
const store = new Store(new PostgresDatabase(url, schema), origin);
store.initializeRegistration("open");
const issuer = "urn:archipel:development", users: { index: number; token: string; csrf: string; channel: string; nick: string }[] = [];
store.transaction(() => {
  const accounts = Array.from({ length: Number(members) }, (_, i) =>
    store.loginIdentity(issuer, i === 0 ? "alice" : `load-${i}`, `load-${i}`, [], i === 0));
  const channels = Array.from({ length: Number(rooms) }, (_, r) => store.createChannel(store.user(accounts[r].id),
    { name: `room-${String(r).padStart(4, "0")}`, mode: "timeline", visibility: "members", admission: "open" }).id);
  accounts.forEach((account, i) => {
    if (i >= Number(rooms)) store.join(store.user(account.id), channels[i % channels.length]);
    const session = store.createSession(account.id);
    users.push({ index: i, token: session.token, csrf: session.csrf, channel: channels[i % channels.length], nick: `u${i}` });
  });
  for (const [r, channel] of channels.entries())
    for (let n = 0; n < Number(history); n++) store.post(store.user(accounts[r].id), channel, { body: `seed ${n}` });
});
writeFileSync(output, JSON.stringify(users));
store.close();
