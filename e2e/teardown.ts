import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import type { Reporter } from "@playwright/test/reporter";

// Reporters exit after the web servers close, so SQLite files are unlocked on Windows.
export default class Cleanup implements Reporter {
  async onExit() {
    const database = process.env.ARCHIPEL_E2E_DATABASE;
    if (!database) return;
    const directory = dirname(resolve(database));
    if (dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith("archipel-browser-"))
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
