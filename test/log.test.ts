import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { errorDiagnostic, rotateLogIfNeeded } from "../src/log.ts";

it("leaves small/missing logs alone and truncates at the threshold without breaking append descriptors", () => {
  const dir = mkdtempSync(join(tmpdir(), "iagents-log-"));
  const path = join(dir, "relay.log");
  try {
    assert.equal(rotateLogIfNeeded(path, 10), false);
    writeFileSync(path, "123456789");
    assert.equal(rotateLogIfNeeded(path, 10), false);
    assert.equal(readFileSync(path, "utf8"), "123456789");
    const inode = statSync(path).ino;
    const fd = openSync(path, "a");
    try {
      writeSync(fd, "0");
      assert.equal(rotateLogIfNeeded(path, 10), true);
      assert.equal(statSync(path).ino, inode);
      assert.equal(statSync(path).size, 0);
      writeSync(fd, "next log line");
      assert.equal(readFileSync(path, "utf8"), "next log line");
      assert.equal(rotateLogIfNeeded(path, 10), true);
    } finally { closeSync(fd); }
    assert.throws(() => rotateLogIfNeeded(path, 0));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("never includes echoed message text or subprocess argv in error diagnostics", () => {
  const err = Object.assign(new Error("osascript -e 'private message text'"), { code: "ENOENT", status: 403, signal: "SIGTERM", stderr: "private content" });
  assert.equal(errorDiagnostic(err), "code=ENOENT status=403 signal=SIGTERM");
  for (const detail of ["private content", new Error("private content"), { code: "private content" }]) {
    assert.equal(errorDiagnostic(detail), "error detail omitted");
  }
});
