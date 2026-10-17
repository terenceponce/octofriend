import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import { delimiter, join } from "node:path";
import {
  createHerdrReporter,
  herdrReportFor,
  herdrResumeFor,
  herdrStatusFor,
  readHerdrEnv,
  resolveResumeCommand,
  startHerdrIntegration,
  type HerdrEnv,
  type HerdrState,
} from "./herdr.ts";
import type { LiveMirror } from "./state.ts";
import type { Session } from "./session-history/index.ts";
import type { ParsedCliArgs } from "./cli/cli-args.ts";
import type { octoAgent } from "./ir/octo-ir.ts";
import type { TrajectoryMode } from "./libocto/trajectory.ts";
import type { Transport } from "./transports/transport-common.ts";
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

function withPath<T>(dir: string, run: () => T): T {
  const previous = process.env["PATH"];
  process.env["PATH"] = `${dir}${delimiter}${previous ?? ""}`;
  try {
    return run();
  } finally {
    if (previous == null) delete process.env["PATH"];
    else process.env["PATH"] = previous;
  }
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
function withoutSeq(call: MockProcessCall): string[] {
  const args = [...call.args];
  const index = args.indexOf("--seq");
  expect(index).toBeGreaterThanOrEqual(0);
  return [...args.slice(0, index), "--seq", "<seq>", ...args.slice(index + 2)];
}

function seqOf(call: MockProcessCall): number {
  const args = [...call.args];
  return Number(args[args.indexOf("--seq") + 1]);
}

function stateOf(call: MockProcessCall): string {
  const args = [...call.args];
  return args[args.indexOf("--state") + 1];
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

  it("reports idle when the user is steering after rejecting a tool", () => {
    expect(herdrStatusFor(liveMode("tool-call-permission", AWAITING_STEERING))).toEqual({
      state: "idle",
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
    expect(herdrReportFor({ mode: "booting" })).toBeNull();
  });

  it("reports a blocked pane when the session is lost", () => {
    expect(herdrReportFor({ mode: "lost" })).toEqual({
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

describe("resolveResumeCommand", () => {
  it("resolves the command Herdr would re-run", () => {
    expect(resolveResumeCommand({ PATH: binDir(["octo"]) })).toBe("octo");
  });

  it("offers nothing when the command isn't on PATH", () => {
    expect(resolveResumeCommand({ PATH: binDir([]) })).toBeNull();
    expect(resolveResumeCommand({})).toBeNull();
  });

  it("ignores PATH entries that aren't executable files", () => {
    const withDirectory = binDir([]);
    fs.mkdirSync(join(withDirectory, "octo"));
    expect(resolveResumeCommand({ PATH: withDirectory })).toBeNull();

    const withPlainFile = binDir([]);
    fs.writeFileSync(join(withPlainFile, "octo"), "not executable", { mode: 0o644 });
    expect(resolveResumeCommand({ PATH: withPlainFile })).toBeNull();
  });

  it("never resumes a canary session with the released build", () => {
    // canary.sh's `canary-octo` is a shell function, so Herdr can't run it, and the `octo` on
    // PATH would be a different build than the one running the session.
    expect(resolveResumeCommand({ CANARY_OCTO: "1", PATH: binDir(["octo"]) })).toBeNull();
    expect(resolveResumeCommand({ CANARY_OCTO: "1", PATH: binDir(["canary-octo"]) })).toBe(
      "canary-octo",
    );
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

  it("resumes docker sessions without the docker subcommand, which the session records", () => {
    expect(
      herdrResumeFor(
        sessionFor("session-2", { kind: "docker-connect", target: "my-container" }),
        "octo",
      ),
    ).toEqual({
      sessionId: "session-2",
      argv: ["octo", "--resume", "session-2"],
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
});

describe("createHerdrReporter", () => {
  it("reports state through the Herdr binary in the current pane", () => {
    const transport = new MockTransport({});
    const reporter = createHerdrReporter({ env: HERDR_ENV, transport });

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
    const reporter = createHerdrReporter({ env: HERDR_ENV, transport });

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
    const reporter = createHerdrReporter({ env: HERDR_ENV, transport });

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

  it("increases seq across reports", () => {
    const transport = new MockTransport({});
    const reporter = createHerdrReporter({ env: HERDR_ENV, transport });

    reporter.report({ state: "working" });
    transport.spawnCalls[0].process.finish(0, null);
    reporter.report({ state: "idle" });

    expect(seqOf(transport.spawnCalls[1])).toBeGreaterThan(seqOf(transport.spawnCalls[0]));
  });

  it("drops queued reports in favor of the latest state", () => {
    const transport = new MockTransport({});
    const reporter = createHerdrReporter({ env: HERDR_ENV, transport });

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
    const reporter = createHerdrReporter({ env: HERDR_ENV, transport: failing });

    reporter.report({ state: "working" });
    reporter.release();
  });

  it("releases the pane on exit, and stops reporting afterwards", () => {
    const transport = new MockTransport({});
    const reporter = createHerdrReporter({ env: HERDR_ENV, transport });

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

describe("startHerdrIntegration", () => {
  it("does nothing outside a Herdr pane", () => {
    const transport = new MockTransport({});
    const source = fakeSource({ mode: "booting" });
    const stop = startHerdrIntegration({ env: null, transport, source });

    source.set(liveState({ mode: "responding", sessionId: "session-1" }));
    stop();

    expect(transport.spawnCalls).toHaveLength(0);
  });

  it("reports state changes, skipping reports that change nothing", () => {
    const transport = new MockTransport({});
    const source = fakeSource({ mode: "booting" });
    const stop = startHerdrIntegration({ env: HERDR_ENV, transport, source });
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
    withPath(binDir(["octo"]), () => {
      const transport = new MockTransport({});
      const session = sessionFor(null);
      const source = fakeSource({ mode: "live", liveMode: liveMode("ready-for-request"), session });
      startHerdrIntegration({ env: HERDR_ENV, transport, source });

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
  });
});
