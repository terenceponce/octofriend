import fs from "node:fs";
import { delimiter, join } from "node:path";
import { buildOctoFlags } from "./cli/cli-args.ts";
import type { LiveMirror } from "./state.ts";
import type { Session } from "./session-history/index.ts";
import type { Transport } from "./transports/transport-common.ts";

/*
 * Herdr (https://herdr.dev) agent integration.
 *
 * Herdr panes export a few environment variables to every process they run, and agents report
 * back through the binary named by HERDR_BIN_PATH. Reporting lets Herdr show Octo's name and
 * state in its sidebar and `herdr agent list`, notify when a turn finishes or needs a decision,
 * and re-open the same session in the same pane after a Herdr server restart.
 *
 * See https://herdr.dev/docs/add-herdr-support/
 *
 * Outside of Herdr every entry point here is a no-op, so Octo behaves identically when it is not
 * running in a Herdr pane.
 */

// Herdr reserves the `herdr:` prefix for its own integrations.
const HERDR_SOURCE = "octofriend";
// The agent name users see in the sidebar and in `herdr agent list`.
const HERDR_AGENT = "octofriend";
/*
 * Herdr restores a pane by running the resume command itself, so its first word has to be a plain
 * command name that resolves on the user's PATH. Shell functions and aliases don't count, which is
 * why Octo checks for the command before offering it: a restore that lands on a missing command is
 * worse than no restore at all, and Herdr falls back to a plain shell in the saved directory.
 */
const RESUME_COMMAND = "octo";
// Canary runs are started by canary.sh's shell function, and the released `octo` on the user's
// PATH would bring the session back on a different build. Canary users who want automatic restore
// can put a real canary-octo executable on PATH instead.
const CANARY_RESUME_COMMAND = "canary-octo";
// Reports are best-effort: a slow or wedged Herdr must never hold up Octo.
const REPORT_TIMEOUT_MS = 2000;
// Herdr's limits on a resume command; see "Report the resume command" in the docs.
const MAX_RESUME_ARGS = 64;
const MAX_RESUME_BYTES = 8 * 1024;

export type HerdrEnv = {
  binPath: string;
  paneId: string;
};

export function readHerdrEnv(env: NodeJS.ProcessEnv = process.env): HerdrEnv | null {
  if (env["HERDR_ENV"] !== "1") return null;
  const binPath = env["HERDR_BIN_PATH"];
  const paneId = env["HERDR_PANE_ID"];
  if (!binPath || !paneId) return null;
  return { binPath, paneId };
}

export type HerdrAgentState = "idle" | "working" | "blocked";

export type HerdrResume = {
  sessionId: string;
  argv: string[];
};

export type HerdrReport = {
  state: HerdrAgentState;
  message?: string;
  resume?: HerdrResume;
};

export type HerdrStatus = {
  state: HerdrAgentState;
  message?: string;
};

/*
 * Maps Octo's state onto the three states Herdr understands. "Idle" means Octo handed the
 * conversation back to the user, "blocked" means it is parked waiting on a decision, and
 * "working" covers every mode where Octo is making progress on its own.
 */
export function herdrStatusFor(liveMode: LiveMirror): HerdrStatus {
  const { trajectoryMode, permissionUi } = liveMode;
  if (permissionUi.type === "prompt") {
    return {
      state: "blocked",
      message: `Waiting for permission: ${permissionUi.control.toolCall.name}`,
    };
  }

  switch (trajectoryMode.mode) {
    // Octo is waiting for the user, either for a new request or for steering after a rejection.
    case "ready-for-request":
    case "tool-call-permission":
    case "aborted":
      return { state: "idle" };
    // These park the turn until the user decides how to continue.
    case "request-error":
      return { state: "blocked", message: "Request error" };
    case "compaction-error":
      return { state: "blocked", message: "History compaction failed" };
    case "payment-error":
      return { state: "blocked", message: "Payment error" };
    case "rate-limit-error":
      return { state: "blocked", message: "Rate limited" };
    case "auth-error":
      return { state: "blocked", message: "Auth error" };
    // DO NOT turn these cases into "default": each new mode should decide what Herdr shows.
    case "responding":
    case "compacting":
    case "autofix-json":
    case "autofix-tool":
    case "request-error-retrying":
    case "tool-call":
    case "running-tool":
      return { state: "working" };
  }
}

// The command Herdr should re-run for this session, or null when nothing on the user's PATH
// could start Octo again.
export function resolveResumeCommand(env: NodeJS.ProcessEnv = process.env): string | null {
  const command = env["CANARY_OCTO"] === "1" ? CANARY_RESUME_COMMAND : RESUME_COMMAND;
  return isExecutableOnPath(command, env["PATH"]) ? command : null;
}

function isExecutableOnPath(command: string, searchPath: string | undefined): boolean {
  if (searchPath == null) return false;
  return searchPath
    .split(delimiter)
    .filter(dir => dir !== "")
    .some(dir => {
      const candidate = join(dir, command);
      try {
        if (!fs.statSync(candidate).isFile()) return false;
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

export function herdrResumeFor(
  session: Session,
  resumeCommand: string | null = resolveResumeCommand(),
): HerdrResume | null {
  if (resumeCommand == null) return null;
  const { sessionId, cliArgs } = session.metadata;
  // The session id is generated when the first history item is persisted, so there is nothing
  // to resume until Octo has something worth remembering.
  if (sessionId == null) return null;

  const argv = [resumeCommand, ...buildOctoFlags(cliArgs), "--resume", sessionId];
  // Herdr rejects a bad resume command with `invalid_resume_argv` and drops the state report it
  // was attached to, so a command it won't accept is better left off entirely.
  if (!resumeArgvAccepted(argv)) return null;
  return { sessionId, argv };
}

function resumeArgvAccepted(argv: string[]): boolean {
  if (argv.length === 0 || argv.length > MAX_RESUME_ARGS) return false;
  let bytes = 0;
  for (const arg of argv) {
    // Herdr parses the command itself, so an argument it can't quote is an argument it won't run.
    if (arg === "" || arg.includes("'") || /[\u0000-\u001f\u007f]/.test(arg)) return false;
    bytes += Buffer.byteLength(arg) + 1;
  }
  return bytes <= MAX_RESUME_BYTES;
}

// The slice of the app's session state this module reads. The store's SessionMode satisfies it
// structurally, and tests can build one without booting a session for real.
export type HerdrState =
  | { mode: "booting" }
  | { mode: "lost" }
  | { mode: "live"; liveMode: LiveMirror; session: Session };

export function herdrReportFor(
  sessionMode: HerdrState,
  resumeCommand: string | null = resolveResumeCommand(),
): HerdrReport | null {
  switch (sessionMode.mode) {
    case "booting":
      return null;
    case "lost":
      return { state: "blocked", message: "Session lost" };
    case "live": {
      const status = herdrStatusFor(sessionMode.liveMode);
      const resume = herdrResumeFor(sessionMode.session, resumeCommand);
      return resume == null ? status : { ...status, resume };
    }
  }
}

export type HerdrReporter = {
  report: (report: HerdrReport) => void;
  release: () => void;
};

export function createHerdrReporter(args: { env: HerdrEnv; transport: Transport }): HerdrReporter {
  const { env, transport } = args;
  let lastSeq = 0;
  let sending = false;
  let pending: HerdrReport | null = null;
  let released = false;

  // Herdr ignores any report whose seq is not higher than the last one it accepted, so seq must
  // keep increasing across reports, sessions, and restarts of Octo. Timestamps do that, and the
  // lastSeq bump keeps reports from the same millisecond in order.
  const nextSeq = () => {
    lastSeq = Math.max(Date.now(), lastSeq + 1);
    return lastSeq;
  };

  const spawnReport = (argv: string[]) => {
    const reported = transport.spawn(env.binPath, argv, {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: REPORT_TIMEOUT_MS,
      // The release report is sent as Octo exits, so it has to outlive Octo itself.
      surviveAfterOctoExit: true,
    });
    reported.on("error", () => {});
    reported.unref();
    return reported;
  };

  const flush = () => {
    if (sending || released) return;
    const report = pending;
    if (report == null) return;
    pending = null;
    sending = true;
    try {
      const reported = spawnReport(reportArgv(env, report, nextSeq()));
      reported.once("close", () => {
        sending = false;
        flush();
      });
    } catch {
      // Reports are best-effort: Herdr being unhappy is not Octo's problem.
      sending = false;
      flush();
    }
  };

  return {
    report: report => {
      if (released) return;
      // Only the latest state matters, so an older queued report is overwritten rather than sent.
      pending = report;
      flush();
    },
    release: () => {
      if (released) return;
      released = true;
      pending = null;
      try {
        spawnReport([
          "pane",
          "release-agent",
          env.paneId,
          "--source",
          HERDR_SOURCE,
          "--agent",
          HERDR_AGENT,
          "--seq",
          String(nextSeq()),
        ]);
      } catch {
        // Nothing to do: Herdr clears the agent itself once the pane is back at its shell.
      }
    },
  };
}

function reportArgv(env: HerdrEnv, report: HerdrReport, seq: number): string[] {
  const argv = [
    "pane",
    "report-agent",
    env.paneId,
    "--source",
    HERDR_SOURCE,
    "--agent",
    HERDR_AGENT,
    "--state",
    report.state,
    "--seq",
    String(seq),
  ];
  if (report.message != null) argv.push("--message", report.message);
  if (report.resume != null) {
    argv.push("--agent-session-id", report.resume.sessionId, "--", ...report.resume.argv);
  }
  return argv;
}

// The slice of the app store the integration drives from, so tests can subscribe to it without
// standing up the real store.
export type HerdrStatusSource = {
  getState: () => { sessionMode: HerdrState };
  subscribe: (
    listener: (state: { sessionMode: HerdrState }, prevState: { sessionMode: HerdrState }) => void,
  ) => () => void;
};

export function startHerdrIntegration(args: {
  env: HerdrEnv | null;
  transport: Transport;
  source: HerdrStatusSource;
}): () => void {
  if (args.env == null) return () => {};
  const reporter = createHerdrReporter({ env: args.env, transport: args.transport });
  let lastKey: string | null = null;

  const publish = (sessionMode: HerdrState) => {
    const report = herdrReportFor(sessionMode);
    if (report == null) return;
    const key = reportKey(report);
    if (key === lastKey) return;
    lastKey = key;
    reporter.report(report);
  };

  const unsubscribe = args.source.subscribe(state => publish(state.sessionMode));
  publish(args.source.getState().sessionMode);

  return () => {
    unsubscribe();
    reporter.release();
  };
}

function reportKey(report: HerdrReport): string {
  return JSON.stringify([report.state, report.message ?? null, report.resume?.argv ?? null]);
}
