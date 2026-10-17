import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

const RECORD_END = "--end--";

/*
 * A stand-in for HERDR_BIN_PATH: a script that records the argv it was called with, one argument
 * per line, with a marker between calls so a reader can tell a finished record from a partial one.
 *
 * Reports go out as real subprocesses, so this is what lets a test assert on the wire format and
 * the order of the reports Octo sends, without a Herdr install. Callers register `dir` for cleanup.
 */
export function fakeHerdrBinary(options: { versions?: { client: string; server: string } } = {}) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "octo-herdr-bin-"));
  const logPath = join(dir, "reports");
  const binPath = join(dir, "herdr");
  // A stub that answers `status --json` as a real Herdr from `options.versions` would, and records
  // every other call's argv. Without versions it answers nothing, which is the probe failing.
  const status =
    options.versions == null
      ? ""
      : [
          `if [ "$1" = "status" ]; then`,
          `  printf '%s\\n' '${JSON.stringify({
            client: { version: options.versions.client },
            server: { version: options.versions.server },
          })}'`,
          `  exit 0`,
          `fi`,
          "",
        ].join("\n");
  fs.writeFileSync(
    binPath,
    `#!/bin/sh\n${status}{\n  for arg in "$@"; do printf '%s\\n' "$arg"; done\n  printf '%s\\n' "${RECORD_END}"\n} >> "${logPath}"\n`,
  );
  fs.chmodSync(binPath, 0o755);

  const records = (): string[][] => {
    if (!fs.existsSync(logPath)) return [];
    const chunks = fs.readFileSync(logPath, "utf8").split(`${RECORD_END}\n`);
    // Drop the final chunk: it is empty once the last call has finished writing.
    chunks.pop();
    return chunks.map(chunk => chunk.slice(0, -1).split("\n"));
  };

  return {
    dir,
    binPath,
    records,
    // Waits for the first call matching `match`, and returns every record up to and including it.
    async waitForCall(match: (record: string[]) => boolean): Promise<string[][]> {
      let found: string[][] = [];
      const start = Date.now();
      while (found.length === 0) {
        const all = records();
        const index = all.findIndex(match);
        if (index >= 0) found = all.slice(0, index + 1);
        else if (Date.now() - start > 10_000) throw new Error("Timed out waiting for a Herdr call");
        else await new Promise(resolve => setTimeout(resolve, 10));
      }
      return found;
    },
  };
}

export function stateOf(record: readonly string[]): string {
  return record[record.indexOf("--state") + 1]!;
}
