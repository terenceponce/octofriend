import fs from "node:fs";
import { delimiter, join } from "node:path";
import { buildOctoFlags } from "./cli/cli-args.ts";
import { errorToString } from "./libocto/result.ts";
import * as logger from "./logger.ts";
import type { Config } from "./config.ts";
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
// The agent name users see in the sidebar and in `herdr agent list`, unless the config overrides it.
const DEFAULT_AGENT_NAME = "octofriend";
/*
 * Herdr restores a pane by running the resume command itself, so its first word has to be a plain
 * command name that resolves on the user's PATH. Shell functions and aliases don't count, which is
 * why Octo checks for the command before offering it: a restore that lands on a missing command is
 * worse than no restore at all, and Herdr falls back to a plain shell in the saved directory.
 */
const DEFAULT_RESUME_COMMAND = "octo";
// A canary session resumed with the released `octo` would come back as a different build, so canary
// sessions offer the checkout's `canary-octo` command instead. canary.sh puts that command on PATH;
// if it isn't there, the session reports no resume command at all rather than the wrong build.
const DEFAULT_CANARY_RESUME_COMMAND = "canary-octo";
/*
 * Herdr learned to restore panes from a reported command in 0.9.2. An older CLI answers the
 * trailing argv that carries it with `unknown option: --` and exits 2, and the rejection takes the
 * state report it was attached to down with it, so the command has to stay off the wire until both
 * the CLI parsing our report and the server acting on it are new enough.
 */
const MIN_RESUME_COMMAND_VERSION: readonly [number, number, number] = [0, 9, 2];
// Reports are best-effort: a slow or wedged Herdr must never hold up Octo.
const REPORT_TIMEOUT_MS = 2000;
// The one startup probe, asking Herdr what it understands.
const PROBE_TIMEOUT_MS = 2000;
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

export type HerdrCapabilities = {
  // Whether a report may carry the command Herdr should re-run to bring the pane's session back.
  resumeCommand: boolean;
};

/*
 * What to assume when Herdr never told us: reporting state is the whole point of the integration,
 * and guessing wrong about a resume command costs the state report it rides on, so the guess is
 * always "no resume commands".
 */
export const CONSERVATIVE_HERDR_CAPABILITIES: HerdrCapabilities = { resumeCommand: false };

/*
 * Reads the client and server versions out of `herdr status --json`. Both have to be new enough:
 * the CLI is what parses our report and rejects an argv it doesn't know, and the server is what
 * turns a resume command into a restored pane. They can differ after an update, before the server
 * has been restarted.
 */
export function herdrCapabilitiesFromStatus(status: string): HerdrCapabilities {
  try {
    const parsed: unknown = JSON.parse(status);
    const { client, server } = (parsed ?? {}) as {
      client?: { version?: unknown };
      server?: { version?: unknown };
    };
    return {
      resumeCommand:
        versionAtLeast(client?.version, MIN_RESUME_COMMAND_VERSION) &&
        versionAtLeast(server?.version, MIN_RESUME_COMMAND_VERSION),
    };
  } catch {
    return CONSERVATIVE_HERDR_CAPABILITIES;
  }
}

function versionAtLeast(version: unknown, minimum: readonly [number, number, number]): boolean {
  if (typeof version !== "string") return false;
  const parts = version.split(".").map(part => Number.parseInt(part, 10));
  if (parts.length < minimum.length || parts.some(part => !Number.isFinite(part))) return false;
  for (let index = 0; index < minimum.length; index++) {
    if (parts[index] !== minimum[index]) return parts[index]! > minimum[index]!;
  }
  return true;
}

// The one place Octo asks Herdr about itself rather than reporting to it.
export async function readHerdrCapabilities(
  env: HerdrEnv | null,
  transport: Transport,
): Promise<HerdrCapabilities> {
  if (env == null) return CONSERVATIVE_HERDR_CAPABILITIES;
  try {
    return herdrCapabilitiesFromStatus(
      await execFileText(transport, env.binPath, ["status", "--json"]),
    );
  } catch (error) {
    logger.error("verbose", `Could not read Herdr's capabilities: ${errorToString(error)}`);
    return CONSERVATIVE_HERDR_CAPABILITIES;
  }
}

function execFileText(transport: Transport, file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    transport.execFile(file, args, { timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
      if (error == null) resolve(stdout);
      else reject(error);
    });
  });
}

// The name Herdr's skill is installed under, so the offer and the install agree on it.
export const HERDR_SKILL_NAME = "herdr";

/*
 * The pane to offer Herdr's own skill to, or null when there's no offer to make: the skill is only
 * useful inside a pane, and only worth offering to someone who doesn't have it already.
 */
export function herdrSkillOffer(
  env: HerdrEnv | null,
  skillNames: readonly string[],
): HerdrEnv | null {
  if (env == null || skillNames.includes(HERDR_SKILL_NAME)) return null;
  return env;
}

/*
 * Writes the skill Herdr ships for agents that drive it — the same file `herdr --skill` prints —
 * into the skills directory Octo searches. Octo's loader requires the containing directory to match
 * the skill's own `name`, so the name is read from what Herdr sent rather than assumed.
 *
 * Herdr runs on the host and so does this skill, so the caller passes a local transport even when
 * the session itself is sandboxed.
 */
export async function installHerdrSkill(args: {
  env: HerdrEnv;
  transport: Transport;
  skillsDir: string;
  signal: AbortSignal;
}): Promise<string> {
  const content = await execFileText(args.transport, args.env.binPath, ["--skill"]);
  const name = skillNameFrom(content);
  if (name == null) {
    throw new Error("the skill Herdr returned has no name in its frontmatter");
  }

  const dir = join(args.skillsDir, name);
  const path = join(dir, "SKILL.md");
  await args.transport.mkdir(args.signal, dir);
  await args.transport.writeFile(args.signal, path, content);
  return path;
}

// The `name:` Octo's loader needs, read the way that loader reads it: frontmatter, first line.
function skillNameFrom(content: string): string | null {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return null;
  const match = /^name:[ \t]*(.+)$/m.exec(content.slice(4, end));
  const name = match?.[1]?.trim().replace(/^["']|["']$/g, "");
  return name != null && name !== "" ? name : null;
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
    // Octo is waiting for the user: for a new request, or for the pane back after ESC.
    case "ready-for-request":
    case "aborted":
      return { state: "idle" };
    /*
     * Blocked either way, and deliberately mapped off the mode rather than the permission UI: the
     * store resets permissionUi to idle in the same update that installs this mode, and only pushes
     * the prompt afterwards. Reading the permission UI first would report a spurious "idle" in
     * between, which shows up as a flicker in the sidebar and can fire a spurious notification.
     */
    case "tool-call-permission":
      return permissionUi.type === "awaiting-steering"
        ? { state: "blocked", message: "Waiting for your message" }
        : { state: "blocked", message: "Waiting for permission" };
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

export type HerdrSettings = {
  enabled: boolean;
  // The name users see in the sidebar and in `herdr agent list`.
  agentName: string;
  // The command Herdr should re-run for this session, or null when nothing on the user's PATH
  // could start Octo again.
  resumeCommand: string | null;
};

/*
 * Reads the `herdr` config section. Reports are on by default and still only ever happen inside a
 * Herdr pane, and the resume command is chosen per pane from how this process was launched: `octo`
 * and `canary-octo` are two builds sharing one config file, so no single configured command is
 * correct for both. Herdr keeps resume state per pane, so panes can hold different commands.
 */
export function herdrSettingsFor(
  herdr: Config["herdr"],
  env: NodeJS.ProcessEnv = process.env,
): HerdrSettings {
  const resume = herdr?.resume;
  const command =
    env["CANARY_OCTO"] === "1"
      ? (resume?.canaryCommand ?? DEFAULT_CANARY_RESUME_COMMAND)
      : (resume?.command ?? DEFAULT_RESUME_COMMAND);

  return {
    enabled: herdr?.enabled !== false,
    agentName: herdr?.agentName ?? DEFAULT_AGENT_NAME,
    resumeCommand: isExecutableOnPath(command, env["PATH"]) ? command : null,
  };
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

export function herdrResumeFor(session: Session, resumeCommand: string | null): HerdrResume | null {
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
  resumeCommand: string | null,
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

export function createHerdrReporter(args: {
  env: HerdrEnv;
  agentName: string;
  capabilities: HerdrCapabilities;
  transport: Transport;
}): HerdrReporter {
  const { env, agentName, capabilities, transport } = args;
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
      const argv = reportArgv(env, agentName, capabilities, report, nextSeq());
      const reported = spawnReport(argv);
      reported.once("close", code => {
        logRejectedReport(argv, code);
        sending = false;
        flush();
      });
    } catch (error) {
      // Reports are best-effort: Herdr being unhappy is not Octo's problem.
      logger.error("verbose", `Could not run the Herdr binary: ${errorToString(error)}`);
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
      const argv = [
        "pane",
        "release-agent",
        env.paneId,
        "--source",
        HERDR_SOURCE,
        "--agent",
        agentName,
        "--seq",
        String(nextSeq()),
      ];
      try {
        spawnReport(argv).once("close", code => logRejectedReport(argv, code));
      } catch {
        // Nothing to do: Herdr clears the agent itself once the pane is back at its shell.
      }
    },
  };
}

/*
 * A rejected report is invisible by design: the output is discarded, and Herdr simply keeps showing
 * whatever it last accepted. That silence is how a server that refuses our argv froze the sidebar
 * for a whole session, so under OCTO_VERBOSE the command and its exit code are at least said out
 * loud, and can be re-run by hand to see what Herdr made of it.
 */
function logRejectedReport(argv: string[], code: number | null) {
  if (code === 0) return;
  logger.error("verbose", `herdr ${argv.join(" ")}\n  exited with code ${code}`);
}

function reportArgv(
  env: HerdrEnv,
  agentName: string,
  capabilities: HerdrCapabilities,
  report: HerdrReport,
  seq: number,
): string[] {
  const argv = [
    "pane",
    "report-agent",
    env.paneId,
    "--source",
    HERDR_SOURCE,
    "--agent",
    agentName,
    "--state",
    report.state,
    "--seq",
    String(seq),
  ];
  if (report.message != null) argv.push("--message", report.message);
  /*
   * What the server understands decides what goes on the wire. A Herdr older than 0.9.2 answers the
   * resume command's trailing argv with `unknown option: --` and exits 2, and that rejection takes
   * the state report it rode on down with it. On those servers the session stays out of the report
   * entirely: a pane that shows Octo's state but can't be restored beats one that never updates.
   */
  if (report.resume != null && capabilities.resumeCommand) {
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
  settings: HerdrSettings;
  capabilities: HerdrCapabilities;
  transport: Transport;
  source: HerdrStatusSource;
}): () => void {
  const { env, settings, capabilities } = args;
  if (env == null || !settings.enabled) return () => {};
  const reporter = createHerdrReporter({
    env,
    agentName: settings.agentName,
    capabilities,
    transport: args.transport,
  });
  let lastKey: string | null = null;

  const publish = (sessionMode: HerdrState) => {
    const report = herdrReportFor(sessionMode, settings.resumeCommand);
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
