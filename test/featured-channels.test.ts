import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, Problem } from "../src/store.js";

test("featured channels require an administrator and publish only eligible metadata in saved order", () => {
  const store = new Store(":memory:");
  try {
    let admin = store.loginIdentity("https://id.example", "admin", "admin", []);
    const reader = store.loginIdentity("https://id.example", "reader", "reader", []);
    store.db.prepare("UPDATE users SET admin=1 WHERE id=?").run(admin.id);
    admin = store.user(admin.id);
    const channels = ["one", "two", "private"].map(name => {
      const c = store.createChannel(admin, { name, mode: "timeline", visibility: name === "private" ? "members" : "public", admission: "open" });
      store.db.prepare("UPDATE channels SET remote_actor=? WHERE id=?").run(`https://remote.example/actors/channels/${name}`, c.id);
      return c;
    });
    const settings = { enabled: true, channels: [{ id: channels[1].id, enabled: true }, { id: channels[0].id, enabled: true }] };
    assert.throws(() => store.setFeaturedChannels(reader, settings), (e: unknown) => e instanceof Problem && e.status === 403);
    assert.equal(store.featuredCandidates(admin).length, 2);
    assert.throws(() => store.setFeaturedChannels(admin, { enabled: true, channels: [{ id: channels[2].id, enabled: true }] }), Problem);
    assert.throws(() => store.setFeaturedChannels(admin, { enabled: true, channels: [settings.channels[0], settings.channels[0]] }), Problem);
    assert.throws(() => store.setFeaturedChannels(admin, { enabled: "true", channels: [] }), Problem);
    assert.deepEqual(store.setFeaturedChannels(admin, settings), settings);
    assert.deepEqual(store.featuredSettings(), settings);
    const shown = store.featuredChannels(reader);
    assert.deepEqual(shown.map(c => c.id), [channels[1].id, channels[0].id]);
    assert.deepEqual(Object.keys(shown[0]).sort(), ["address", "description", "id", "joined", "mode", "name"]);
    assert.equal(shown[0].joined, false);
    assert.equal(store.listChannels(reader).length, 0);
    store.setFeaturedChannels(admin, { ...settings, channels: [{ ...settings.channels[0], enabled: false }, settings.channels[1]] });
    assert.deepEqual(store.featuredChannels(reader).map(c => c.id), [channels[0].id]);
    store.db.prepare("UPDATE channels SET visibility='members' WHERE id=?").run(channels[0].id);
    assert.deepEqual(store.featuredChannels(reader), []);
    store.setFeaturedChannels(admin, { enabled: false, channels: [] });
    assert.deepEqual(store.featuredChannels(reader), []);
  } finally { store.close(); }
});

test("featured metadata disappears when blocked or no longer followed", () => {
  const store = new Store(":memory:");
  try {
    let admin = store.loginIdentity("https://id.example", "admin", "admin", []);
    const reader = store.loginIdentity("https://id.example", "reader", "reader", []);
    store.db.prepare("UPDATE users SET admin=1 WHERE id=?").run(admin.id);
    admin = store.user(admin.id);
    const c = store.createChannel(admin, { name: "remote", mode: "topical", visibility: "public", admission: "open" });
    store.db.prepare("UPDATE channels SET remote_actor='https://remote.example/actors/channels/remote' WHERE id=?").run(c.id);
    store.setFeaturedChannels(admin, { enabled: true, channels: [{ id: c.id, enabled: true }] });
    store.db.prepare("INSERT INTO federation_blocks VALUES('https://remote.example','instance')").run();
    assert.deepEqual(store.featuredChannels(reader), []);
    store.db.prepare("DELETE FROM federation_blocks").run();
    assert.equal(store.featuredChannels(reader).length, 1);
    store.db.prepare("DELETE FROM memberships WHERE channel_id=?").run(c.id);
    assert.deepEqual(store.featuredChannels(reader), []);
    assert.deepEqual(store.featuredCandidates(admin), []);
  } finally { store.close(); }
});
