import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { log } from "../log.ts";

export const WATCH_REARM_MS = 5 * 60_000;
const RETRY_MS = 30_000;
const DEBOUNCE_MS = 40;
export type WatchHandle = Pick<FSWatcher, "close" | "on">;
export type WatchFactory = (directory: string, changed: (filename: string | null) => void) => WatchHandle;

/** Periodic renewal repairs silently stale macOS file watches; polling remains the fallback. */
export class MessagesWatcher {
  #enabled = false;
  #watcher?: WatchHandle;
  #timer?: NodeJS.Timeout;
  #nextArmAt = 0;
  #path: string;
  #changed: () => void;
  #now: () => number;
  #create: WatchFactory;
  constructor(
    path: string,
    changed: () => void,
    now: () => number = Date.now,
    create: WatchFactory = (dir, changed) => watch(dir, { persistent: false }, (_event, name) => changed(name)),
  ) {
    this.#path = path;
    this.#changed = changed;
    this.#now = now;
    this.#create = create;
  }

  start(): void {
    this.#enabled = true;
    this.maintain();
  }

  maintain(): void {
    if (!this.#enabled || this.#now() < this.#nextArmAt) return;
    this.#close();
    this.#nextArmAt = this.#now() + RETRY_MS;
    try {
      const name = basename(this.#path);
      const watcher = this.#create(dirname(this.#path), (filename) => {
        if (this.#watcher !== watcher || !this.#enabled) return;
        if (filename !== null && ![name, `${name}-wal`, `${name}-shm`, `${name}-journal`].includes(filename)) return;
        if (this.#timer) return;
        this.#timer = setTimeout(() => {
          this.#timer = undefined;
          try { this.#changed(); } catch (err) { log.warn("Reading messages after a file change failed", err); }
        }, DEBOUNCE_MS);
        this.#timer.unref();
      });
      this.#watcher = watcher;
      const lost = (err?: Error) => {
        if (this.#watcher !== watcher) return;
        this.#close();
        this.#nextArmAt = this.#now() + RETRY_MS;
        log.warn("Messages watcher stopped; polling continues until it is re-armed", err);
      };
      watcher.on("error", lost);
      watcher.on("close", lost);
      this.#nextArmAt = this.#now() + WATCH_REARM_MS;
    } catch (err) {
      log.warn("Couldn't watch the Messages database; polling continues until retry", err);
    }
  }

  rearm(): void {
    this.#nextArmAt = 0;
    this.maintain();
  }

  stop(): void {
    this.#enabled = false;
    this.#close();
    this.#nextArmAt = 0;
  }

  #close(): void {
    const previous = this.#watcher;
    this.#watcher = undefined;
    previous?.close();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
