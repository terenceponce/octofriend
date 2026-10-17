import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  createHerdrReporter,
  herdrReportFor,
  herdrResumeFor,
  herdrSettingsFor,
  herdrStatusFor,
  readHerdrEnv,
  startHerdrIntegration,
  type HerdrEnv,
  type HerdrSettings,
  type HerdrState,
} from "./herdr.ts";
import type { LiveMirror } from "./state.ts";
import type { Session } from "./session-history/index.ts";
import type { ParsedCliArgs } from "./cli/cli-args.ts";
import type { octoAgent } from "./ir/octo-ir.ts";
import type { TrajectoryMode } from "./libocto/trajectory.ts";
import type { Transport } from "./transports/transport-common.ts";
import { LocalTransport } from "./transports/local.ts";
import { MockTransport, type MockProcessCall } from "./transports/mock.ts";

const HERDR_ENV: HerdrEnv = { binPath: "/opt/herdr/bin/herdr", paneId: "pane-7" };

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

// Octo only offers Herdr a resume command it can find on PATH, so tests need a PATH of their own.
function binDir(commands: string[]): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "octo-herdr-"));
  tempDirs.push(dir);
  for (const command of commands) {
    fs.writeFileSync(join(dir, command), "#!/bin/sh\n");
    fs.chmodSync(join(dir, command), 0o755);
  }
  return dir;
}

function settings(overrides: Partial<HerdrSettings> = {}): HerdrSettings {
  return { enabled: true, agentName: "octofriend", resumeCommand: null, ...overrides };
}

function reporterFor(transport: Transport, agentName = "octofriend") {
  return createHerdrReporter({ env: HERDR_ENV, agentName, transport });
}

type OctoMode = TrajectoryMode<typeof octoAgent>["mode"];

function liveMode(
  mode: OctoMode,
  permissionUi: LiveMirror["permissionUi"] = { type: "idle" },
): LiveMirror {
  return { trajectoryMode: { mode } as TrajectoryMode<typeof octoAgent>, permissionUi };
}

// The permission UI carries a live control object; only the tool name matters to Herdr.
function permissionPrompt(toolName: string): LiveMirror["permissionUi"] {
  return {
    type: "prompt",
    control: { toolCall: { name: toolName } },
  } as unknown as LiveMirror["permissionUi"];
}

const AWAITING_STEERING = {
  type: "awaiting-steering",
} as unknown as LiveMirror["permissionUi"];

function sessionFor(sessionId: string | null, cliArgs: ParsedCliArgs = { kind: "local" }): Session {
  return { metadata: { sessionId, cwd: "/repo", cliArgs }, treeId: null, launchId: null };
}

function liveState(args: {
  mode: OctoMode;
  sessionId?: string | null;
  cliArgs?: ParsedCliArgs;
  liveMode?: LiveMirror;
}): HerdrState {
  return {
    mode: "live",
    liveMode: args.liveMode ?? liveMode(args.mode),
    session: sessionFor(args.sessionId ?? null, args.cliArgs),
  };
}

// Reports carry a timestamp-based seq, which is the one part of the argv tests can't pin down.
function maskSeq(args: readonly string[]): string[] {
  const index = args.indexOf("--seq");
  expect(index).toBeGreaterThanOrEqual(0);
  return [...args.slice(0, index), "--seq", "<seq>", ...args.slice(index + 2)];
}

function withoutSeq(call: MockProcessCall): string[] {
  return maskSeq(call.args);
}

function seqOf(args: readonly string[]): number {
  return Number(args[args.indexOf("--seq") + 1]);
}

function stateOf(call: MockProcessCall): string {
  return call.args[call.args.indexOf("--state") + 1];
}

function fakeSource(initial: HerdrState) {
  let state = { sessionMode: initial };
  const listeners = new Set<
    (state: { sessionMode: HerdrState }, prevState: { sessionMode: HerdrState }) => void
  >();
  return {
    getState: () => state,
    subscribe: (
      listener: (
        state: { sessionMode: HerdrState },
        prevState: { sessionMode: HerdrState },
      ) => void,
    ) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(sessionMode: HerdrState) {
      const prevState = state;
      state = { sessionMode };
      for (const listener of listeners) listener(state, prevState);
    },
    listenerCount: () => listeners.size,
  };
}

function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) reject(new Error("Timed out waiting for condition"));
      setTimeout(poll, 10);
    };
    poll();
  });
}

const RECORD_END = "--end--";

/*
 * A stand-in for HERDR_BIN_PATH that records the argv it was called with, one argument per line,
 * with a marker between calls so a reader can tell a finished record from a partial one.
 */
function fakeHerdrBinary() {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "octo-herdr-bin-"));
  tempDirs.push(dir);
  const logPath = join(dir, "reports");
  const binPath = join(dir, "herdr");
  fs.writeFileSync(
    binPath,
    `#!/bin/sh\n{\n  for arg in "$@"; do printf '%s\\n' "$arg"; done\n  printf '%s\\n' "${RECORD_END}"\n} >> "${logPath}"\n`,
  );
  fs.chmodSync(binPath, 0o755);

  const records = () => {
    if (!fs.existsSync(logPath)) return [];
    const chunks = fs.readFileSync(logPath, "utf8").split(`${RECORD_END}\n`);
    // The final chunk is whatever came after the last marker: nothing, unless a call is in flight.
    chunks.pop();
    return chunks.map(chunk => chunk.slice(0, -1).split("\n"));
  };

  return {
    binPath,
    async calls(count: number): Promise<string[][]> {
      await waitFor(() => records().length >= count);
      return records();
    },
  };
}

describe("readHerdrEnv", () => {
  it("reads the pane Herdr reports to", () => {
    expect(
      readHerdrEnv({
        HERDR_ENV: "1",
        HERDR_BIN_PATH: "/opt/herdr/bin/herdr",
        HERDR_PANE_ID: "pane-7",
      }),
    ).toEqual({ binPath: "/opt/herdr/bin/herdr", paneId: "pane-7" });
  });

  it("does nothing outside a Herdr pane", () => {
    expect(
      readHerdrEnv({
        HERDR_BIN_PATH: "/opt/herdr/bin/herdr",
        HERDR_PANE_ID: "pane-7",
      }),
    ).toBeNull();
    expect(readHerdrEnv({})).toBeNull();
  });

  it("does nothing when Herdr's variables are incomplete", () => {
    expect(readHerdrEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "pane-7" })).toBeNull();
    expect(readHerdrEnv({ HERDR_ENV: "1", HERDR_BIN_PATH: "/opt/herdr/bin/herdr" })).toBeNull();
    expect(readHerdrEnv({ HERDR_ENV: "1", HERDR_BIN_PATH: "", HERDR_PANE_ID: "" })).toBeNull();
  });
});

describe("herdrStatusFor", () => {
  it("reports idle when Octo is ready for a request", () => {
    expect(herdrStatusFor(liveMode("ready-for-request"))).toEqual({ state: "idle" });
  });

  it("reports blocked at a permission prompt, naming the tool", () => {
    expect(herdrStatusFor(liveMode("tool-call-permission", permissionPrompt("shell")))).toEqual({
      state: "blocked",
      message: "Waiting for permission: shell",
    });
  });

  it("reports blocked while the user writes a message to replace a rejected tool", () => {
    expect(herdrStatusFor(liveMode("tool-call-permission", AWAITING_STEERING))).toEqual({
      state: "blocked",
      message: "Waiting for your message",
    });
  });

  /*
   * The store resets permissionUi to idle in the same update that installs tool-call-permission,
   * and only pushes the prompt afterwards. Reporting idle in that window would flicker the sidebar
   * and could fire a spurious "ready" notification mid-turn.
   */
  it("reports blocked in the gap before the permission prompt is pushed", () => {
    expect(herdrStatusFor(liveMode("tool-call-permission"))).toEqual({
      state: "blocked",
      message: "Waiting for permission",
    });
  });

  it("reports working while Octo makes progress on its own", () => {
    const working: OctoMode[] = [
      "responding",
      "compacting",
      "autofix-json",
      "autofix-tool",
      "request-error-retrying",
      "tool-call",
      "running-tool",
    ];
    for (const mode of working) {
      expect(herdrStatusFor(liveMode(mode))).toEqual({ state: "working" });
    }
  });

  it("reports blocked when the turn is parked on a decision", () => {
    const parked: OctoMode[] = [
      "request-error",
      "compaction-error",
      "payment-error",
      "rate-limit-error",
      "auth-error",
    ];
    for (const mode of parked) {
      const status = herdrStatusFor(liveMode(mode));
      expect(status.state).toBe("blocked");
      expect(status.message).toBeTruthy();
    }
  });

  it("reports idle once Octo has exited", () => {
    expect(herdrStatusFor(liveMode("aborted"))).toEqual({ state: "idle" });
  });
});

describe("herdrReportFor", () => {
  it("reports nothing before a session is booted", () => {
    expect(herdrReportFor({ mode: "booting" }, null)).toBeNull();
  });

  it("reports a blocked pane when the session is lost", () => {
    expect(herdrReportFor({ mode: "lost" }, null)).toEqual({
      state: "blocked",
      message: "Session lost",
    });
  });

  it("reports the live session's state and resume command", () => {
    expect(
      herdrReportFor(liveState({ mode: "ready-for-request", sessionId: "session-1" }), "octo"),
    ).toEqual({
      state: "idle",
      resume: { sessionId: "session-1", argv: ["octo", "--resume", "session-1"] },
    });
  });

  it("omits the resume command until the session has an id", () => {
    expect(herdrReportFor(liveState({ mode: "responding", sessionId: null }), "octo")).toEqual({
      state: "working",
    });
  });
});

describe("herdrSettingsFor", () => {
  it("defaults to reporting as octofriend, resuming with octo", () => {
    expect(herdrSettingsFor(undefined, { PATH: binDir(["octo"]) })).toEqual({
      enabled: true,
      agentName: "octofriend",
      resumeCommand: "octo",
    });
  });

  it("offers no resume command when it isn't on PATH", () => {
    expect(herdrSettingsFor(undefined, { PATH: binDir([]) }).resumeCommand).toBeNull();
    expect(herdrSettingsFor(undefined, {}).resumeCommand).toBeNull();
  });

  it("ignores PATH entries that aren't executable files", () => {
    const withDirectory = binDir([]);
    fs.mkdirSync(join(withDirectory, "octo"));
    expect(herdrSettingsFor(undefined, { PATH: withDirectory }).resumeCommand).toBeNull();

    const withPlainFile = binDir([]);
    fs.writeFileSync(join(withPlainFile, "octo"), "not executable", { mode: 0o644 });
    expect(herdrSettingsFor(undefined, { PATH: withPlainFile }).resumeCommand).toBeNull();
  });

  it("never resumes a canary session with the released build", () => {
    // A canary session resumed by the released `octo` would silently come back as a different
    // build, so with no `canary-octo` on PATH there is no resume command at all.
    expect(
      herdrSettingsFor(undefined, { CANARY_OCTO: "1", PATH: binDir(["octo"]) }).resumeCommand,
    ).toBeNull();
    expect(
      herdrSettingsFor(undefined, { CANARY_OCTO: "1", PATH: binDir(["canary-octo"]) })
        .resumeCommand,
    ).toBe("canary-octo");
  });

  it("uses the configured name and commands", () => {
    const herdr = {
      agentName: "octo-main",
      resume: { command: "octo-dev", canaryCommand: "octo-canary-dev" },
    };
    const path = binDir(["octo-dev", "octo-canary-dev"]);
    expect(herdrSettingsFor(herdr, { PATH: path })).toEqual({
      enabled: true,
      agentName: "octo-main",
      resumeCommand: "octo-dev",
    });
    expect(herdrSettingsFor(herdr, { CANARY_OCTO: "1", PATH: path }).resumeCommand).toBe(
      "octo-canary-dev",
    );
  });

  it("turns reporting off when the config says so", () => {
    expect(herdrSettingsFor({ enabled: false }, { PATH: binDir(["octo"]) })).toEqual({
      enabled: false,
      agentName: "octofriend",
      resumeCommand: "octo",
    });
  });
});

describe("herdrResumeFor", () => {
  it("preserves the flags the session was started with", () => {
    expect(
      herdrResumeFor(
        sessionFor("session-1", {
          kind: "local",
          config: "/tmp/octo.json5",
          unchained: true,
        }),
        "octo",
      ),
    ).toEqual({
      sessionId: "session-1",
      argv: ["octo", "--config", "/tmp/octo.json5", "--unchained", "--resume", "session-1"],
    });
  });

  it("resumes a docker session by id, since the session records its container", () => {
    // `octo --resume` rebuilds the transport from the stored session, so the docker subcommand and
    // its target live in the database rather than in this argv. A docker-run session starts a fresh
    // container from the recorded args, which is what resuming one by hand does too.
    expect(
      herdrResumeFor(
        sessionFor("session-2", { kind: "docker-connect", target: "my-container" }),
        "octo",
      ),
    ).toEqual({
      sessionId: "session-2",
      argv: ["octo", "--resume", "session-2"],
    });
    expect(
      herdrResumeFor(
        sessionFor("session-3", { kind: "docker-run", dockerRunArgs: ["-i", "alpine"] }),
        "octo",
      ),
    ).toEqual({
      sessionId: "session-3",
      argv: ["octo", "--resume", "session-3"],
    });
  });

  it("reports no resume command when the session can't be started by name", () => {
    expect(herdrResumeFor(sessionFor("session-1"), null)).toBeNull();
  });

  it("drops a resume command Herdr would reject", () => {
    // Herdr rejects an argument with an apostrophe along with the state report it is attached to.
    expect(
      herdrResumeFor(
        sessionFor("session-1", { kind: "local", config: "/tmp/o'cto.json5" }),
        "octo",
      ),
    ).toBeNull();
    expect(herdrResumeFor(sessionFor(null), "octo")).toBeNull();
  });

  it("drops a resume command over Herdr's size limit", () => {
    expect(
      herdrResumeFor(
        sessionFor("session-1", { kind: "local", config: `/tmp/${"x".repeat(9 * 1024)}.json5` }),
        "octo",
      ),
    ).toBeNull();
  });
});

describe("createHerdrReporter", () => {
  it("reports state through the Herdr binary in the current pane", () => {
    const transport = new MockTransport({});
    const reporter = reporterFor(transport);

    reporter.report({ state: "working" });

    expect(transport.spawnCalls).toHaveLength(1);
    expect(transport.spawnCalls[0].command).toBe(HERDR_ENV.binPath);
    expect(withoutSeq(transport.spawnCalls[0])).toEqual([
      "pane",
      "report-agent",
      "pane-7",
      "--source",
      "octofriend",
      "--agent",
      "octofriend",
      "--state",
      "working",
      "--seq",
      "<seq>",
    ]);
  });

  it("keeps Octo out of Herdr's way", () => {
    const transport = new MockTransport({});
    const reporter = reporterFor(transport);

    reporter.report({ state: "idle" });

    const options = transport.spawnCalls[0].options;
    expect(options).toMatchObject({
      stdio: ["ignore", "ignore", "ignore"],
      surviveAfterOctoExit: true,
    });
    expect(options.timeout).toBeGreaterThan(0);
  });

  it("attaches a block's explanation and the session's resume command", () => {
    const transport = new MockTransport({});
    const reporter = reporterFor(transport);

    reporter.report({
      state: "blocked",
      message: "Waiting for permission: shell",
      resume: { sessionId: "session-1", argv: ["octo", "--resume", "session-1"] },
    });

    expect(withoutSeq(transport.spawnCalls[0])).toEqual([
      "pane",
      "report-agent",
      "pane-7",
      "--source",
      "octofriend",
      "--agent",
      "octofriend",
      "--state",
      "blocked",
      "--seq",
      "<seq>",
      "--message",
      "Waiting for permission: shell",
      "--agent-session-id",
      "session-1",
      "--",
      "octo",
      "--resume",
      "session-1",
    ]);
  });

  it("uses the agent name from the config", () => {
    const transport = new MockTransport({});
    const reporter = reporterFor(transport, "octo-canary");

    reporter.report({ state: "idle" });
    reporter.release();

    expect(transport.spawnCalls[0].args[transport.spawnCalls[0].args.indexOf("--agent") + 1]).toBe(
      "octo-canary",
    );
    expect(transport.spawnCalls[1].args[transport.spawnCalls[1].args.indexOf("--agent") + 1]).toBe(
      "octo-canary",
    );
  });

  it("increases seq across reports", () => {
    const transport = new MockTransport({});
    const reporter = reporterFor(transport);

    reporter.report({ state: "working" });
    transport.spawnCalls[0].process.finish(0, null);
    reporter.report({ state: "idle" });

    expect(seqOf(transport.spawnCalls[1].args)).toBeGreaterThan(
      seqOf(transport.spawnCalls[0].args),
    );
  });

  it("drops queued reports in favor of the latest state", () => {
    const transport = new MockTransport({});
    const reporter = reporterFor(transport);

    reporter.report({ state: "working" });
    reporter.report({ state: "blocked" });
    reporter.report({ state: "idle" });

    expect(transport.spawnCalls).toHaveLength(1);
    transport.spawnCalls[0].process.finish(0, null);
    expect(transport.spawnCalls).toHaveLength(2);
    expect(stateOf(transport.spawnCalls[1])).toBe("idle");
  });

  it("ignores reports Herdr never receives", () => {
    const failing = {
      spawn: () => {
        throw new Error("herdr is not there");
      },
    } as unknown as Transport;
    const reporter = reporterFor(failing);

    reporter.report({ state: "working" });
    reporter.release();
  });

  it("releases the pane on exit, and stops reporting afterwards", () => {
    const transport = new MockTransport({});
    const reporter = reporterFor(transport);

    reporter.release();
    reporter.release();
    reporter.report({ state: "idle" });

    expect(transport.spawnCalls).toHaveLength(1);
    expect(withoutSeq(transport.spawnCalls[0])).toEqual([
      "pane",
      "release-agent",
      "pane-7",
      "--source",
      "octofriend",
      "--agent",
      "octofriend",
      "--seq",
      "<seq>",
    ]);
  });
});

/*
 * The wire format Herdr actually receives, through a real subprocess rather than a mock: this is
 * the test to read when asking what Octo sends the Herdr binary.
 */
describe("reports sent to a real Herdr binary", () => {
  it("sends the state, the block's message, and the resume command", async () => {
    const herdr = fakeHerdrBinary();
    const reporter = createHerdrReporter({
      env: { binPath: herdr.binPath, paneId: "pane-7" },
      agentName: "octofriend",
      transport: new LocalTransport(),
    });

    reporter.report({
      state: "blocked",
      message: "Waiting for permission: shell",
      resume: { sessionId: "session-1", argv: ["octo", "--unchained", "--resume", "session-1"] },
    });

    const [record] = await herdr.calls(1);
    expect(maskSeq(record)).toEqual([
      "pane",
      "report-agent",
      "pane-7",
      "--source",
      "octofriend",
      "--agent",
      "octofriend",
      "--state",
      "blocked",
      "--seq",
      "<seq>",
      "--message",
      "Waiting for permission: shell",
      "--agent-session-id",
      "session-1",
      "--",
      "octo",
      "--unchained",
      "--resume",
      "session-1",
    ]);
  });

  it("releases the pane with a higher seq than the reports before it", async () => {
    const herdr = fakeHerdrBinary();
    const reporter = createHerdrReporter({
      env: { binPath: herdr.binPath, paneId: "pane-7" },
      agentName: "octofriend",
      transport: new LocalTransport(),
    });

    reporter.report({ state: "idle" });
    // Let the report land before releasing: the stub appends to one file, and two invocations
    // writing at once would interleave their arguments.
    await herdr.calls(1);
    reporter.release();

    const [report, release] = await herdr.calls(2);
    expect(maskSeq(report)).toEqual([
      "pane",
      "report-agent",
      "pane-7",
      "--source",
      "octofriend",
      "--agent",
      "octofriend",
      "--state",
      "idle",
      "--seq",
      "<seq>",
    ]);
    expect(maskSeq(release)).toEqual([
      "pane",
      "release-agent",
      "pane-7",
      "--source",
      "octofriend",
      "--agent",
      "octofriend",
      "--seq",
      "<seq>",
    ]);
    expect(seqOf(release)).toBeGreaterThan(seqOf(report));
  });
});

describe("startHerdrIntegration", () => {
  it("does nothing outside a Herdr pane", () => {
    const transport = new MockTransport({});
    const source = fakeSource({ mode: "booting" });
    const stop = startHerdrIntegration({ env: null, settings: settings(), transport, source });

    source.set(liveState({ mode: "responding", sessionId: "session-1" }));
    stop();

    expect(transport.spawnCalls).toHaveLength(0);
  });

  it("does nothing when the config turns it off", () => {
    const transport = new MockTransport({});
    const source = fakeSource({ mode: "booting" });
    const stop = startHerdrIntegration({
      env: HERDR_ENV,
      settings: settings({ enabled: false }),
      transport,
      source,
    });

    source.set(liveState({ mode: "responding", sessionId: "session-1" }));
    stop();

    expect(transport.spawnCalls).toHaveLength(0);
    expect(source.listenerCount()).toBe(0);
  });

  it("reports state changes, skipping reports that change nothing", () => {
    const transport = new MockTransport({});
    const source = fakeSource({ mode: "booting" });
    const stop = startHerdrIntegration({ env: HERDR_ENV, settings: settings(), transport, source });
    expect(transport.spawnCalls).toHaveLength(0);

    source.set(liveState({ mode: "responding", sessionId: "session-1" }));
    expect(transport.spawnCalls).toHaveLength(1);
    expect(stateOf(transport.spawnCalls[0])).toBe("working");
    transport.spawnCalls[0].process.finish(0, null);

    source.set(liveState({ mode: "responding", sessionId: "session-1" }));
    expect(transport.spawnCalls).toHaveLength(1);

    source.set(liveState({ mode: "ready-for-request", sessionId: "session-1" }));
    expect(transport.spawnCalls).toHaveLength(2);
    expect(stateOf(transport.spawnCalls[1])).toBe("idle");

    expect(source.listenerCount()).toBe(1);
    stop();
    expect(source.listenerCount()).toBe(0);
    expect(transport.spawnCalls[2].args[1]).toBe("release-agent");
  });

  it("reports the resume command as soon as the session has an id", () => {
    const transport = new MockTransport({});
    const session = sessionFor(null);
    const source = fakeSource({ mode: "live", liveMode: liveMode("ready-for-request"), session });
    startHerdrIntegration({
      env: HERDR_ENV,
      settings: settings({ resumeCommand: "octo" }),
      transport,
      source,
    });

    // Nothing to resume until Octo has persisted something worth remembering.
    expect(transport.spawnCalls[0].args).not.toContain("--agent-session-id");

    // Octo assigns the session id when the first history item is persisted.
    session.metadata.sessionId = "session-1";
    source.set({ mode: "live", liveMode: liveMode("responding"), session });
    transport.spawnCalls[0].process.finish(0, null);

    const args = withoutSeq(transport.spawnCalls[1]);
    expect(args.slice(args.indexOf("--agent-session-id"))).toEqual([
      "--agent-session-id",
      "session-1",
      "--",
      "octo",
      "--resume",
      "session-1",
    ]);
  });

  it("reports the new session rather than releasing when the session changes", () => {
    const transport = new MockTransport({});
    const source = fakeSource({
      mode: "live",
      liveMode: liveMode("ready-for-request"),
      session: sessionFor("session-1"),
    });
    startHerdrIntegration({
      env: HERDR_ENV,
      settings: settings({ resumeCommand: "octo" }),
      transport,
      source,
    });
    transport.spawnCalls[0].process.finish(0, null);

    source.set({
      mode: "live",
      liveMode: liveMode("ready-for-request"),
      session: sessionFor("session-2"),
    });

    const args = withoutSeq(transport.spawnCalls[1]);
    expect(args[1]).toBe("report-agent");
    expect(args.slice(args.indexOf("--agent-session-id"))).toEqual([
      "--agent-session-id",
      "session-2",
      "--",
      "octo",
      "--resume",
      "session-2",
    ]);
  });
});
