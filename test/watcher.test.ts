import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { MessagesWatcher, WATCH_REARM_MS, type WatchHandle } from "../src/imessage/watcher.ts";

it("renews a silent watcher, ignores old callbacks, and debounces current database events", async () => {
  let time = 1000, changes = 0;
  const watches: { events: EventEmitter; changed: (name: string | null) => void; closed: boolean }[] = [];
  const watcher = new MessagesWatcher("/tmp/chat.db", () => changes++, () => time, (_dir, changed) => {
    const record = { events: new EventEmitter(), changed, closed: false };
    watches.push(record);
    return Object.assign(record.events, { close() { record.closed = true; record.events.emit("close"); } }) as unknown as WatchHandle;
  });
  watcher.start();
  try {
    time += WATCH_REARM_MS - 1;
    watcher.maintain();
    assert.equal(watches.length, 1);
    time++;
    watcher.maintain();
    assert.equal(watches.length, 2);
    assert.equal(watches[0].closed, true);
    watches[0].changed("chat.db");
    watches[1].changed("unrelated");
    await delay(60);
    assert.equal(changes, 0);
    for (const name of ["chat.db", "chat.db-wal", "chat.db-shm", "chat.db-journal", null]) watches[1].changed(name);
    await delay(60);
    assert.equal(changes, 1);
    watcher.rearm();
    assert.equal(watches.length, 3);
    watches[2].events.emit("error", new Error("watch lost"));
    assert.equal(watches[2].closed, true);
    time += 29_999;
    watcher.maintain();
    assert.equal(watches.length, 3);
    time++;
    watcher.maintain();
    assert.equal(watches.length, 4);
  } finally { watcher.stop(); }
  time += WATCH_REARM_MS;
  watcher.maintain();
  assert.equal(watches.length, 4);
  assert.equal(watches[3].closed, true);
});

it("retries a failed watcher setup without a busy loop", () => {
  let time = 0, attempts = 0;
  const watcher = new MessagesWatcher("/tmp/chat.db", () => {}, () => time, () => { attempts++; throw new Error("unavailable"); });
  watcher.start();
  for (let i = 0; i < 20; i++) watcher.maintain();
  assert.equal(attempts, 1);
  time = 30_000;
  watcher.maintain();
  assert.equal(attempts, 2);
  watcher.stop();
});
