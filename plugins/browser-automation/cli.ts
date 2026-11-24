import {
  PluginCliError,
  cliCommand,
  defineCli,
  type PluginCliContext,
  type PluginCliRegistration,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import { DEFAULT_PROFILE, profileSchema } from "./contracts.js";

export type BrowserCliMethod =
  | "open"
  | "list"
  | "run"
  | "pages"
  | "screenshot"
  | "preview"
  | "stop"
  | "close";

export interface BrowserCliInput {
  threadId: string;
  sessionId?: string;
  hostId?: string;
  profile?: string | null;
  script?: string;
  timeoutMs?: number;
  page?: string;
  afterSequence?: number;
}

export interface BrowserCliRequest {
  method: BrowserCliMethod;
  input: BrowserCliInput;
  scriptFile?: string;
  scriptHost?: string;
}

const SESSION_POSITIONAL = {
  name: "session-id",
  description: "Session id returned by `bb browser-automation open`",
  required: true,
} as const;

const THREAD_OPTION = {
  type: "string",
  placeholder: "id",
  description:
    "Thread that owns the session; defaults to the invoking thread and cannot name another",
} as const;

const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

const REOPEN_HINT = "Open a new session with `bb browser-automation open`.";

function resolveThreadId(
  option: string | undefined,
  ctx: PluginCliContext,
): string {
  const threadId = option ?? ctx.threadId;
  if (threadId === undefined || threadId === "") {
    throw new PluginCliError("Run from a BB thread or pass --thread <id>", {
      code: "thread_required",
    });
  }
  if (ctx.threadId !== undefined && threadId !== ctx.threadId) {
    throw new PluginCliError(
      "CLI calls from a thread cannot access another thread's browser session",
      { code: "cross_thread" },
    );
  }
  return threadId;
}

export function createBrowserAutomationCli(deps: {
  execute(
    request: BrowserCliRequest,
    ctx: PluginCliContext,
  ): Promise<PluginCliResult>;
}): PluginCliRegistration {
  return defineCli({
    name: "browser-automation",
    summary:
      "Remote browser sessions on the thread's host, shared with the side panel",
    description:
      "Sessions run in the remote browser on a bb host: the browser the user sees and controls in the side panel's Remote browser tab. By default they use the host's default profile, so the user and agents share one signed-in browser.\nSessions belong to the thread that opened them. run, pages, and screenshot renew expiry to 30 minutes after use, capped at 8 hours from creation.\nlist and thumbnail previews do not renew expiry; the full-size viewer and its input do. A stopped or expired session cannot be resumed; open a new one.",
    commands: {
      open: cliCommand({
        summary:
          "Open a remote browser session on the thread's host, shared with the side panel",
        constraints: [
          { kind: "at-most-one", options: ["profile", "temporary"] },
        ],
        options: {
          machine: {
            type: "string",
            placeholder: "name-or-id",
            description:
              "Host that runs the browser: exact ID or unambiguous name; defaults to the thread's environment host",
          },
          profile: {
            type: "string",
            placeholder: "name",
            default: DEFAULT_PROFILE,
            description:
              "Persistent browser profile on the host, shared with the side panel's Remote browser tab",
          },
          temporary: {
            type: "boolean",
            description:
              "Use a clean, signed-out profile that is deleted when the session ends",
          },
          thread: THREAD_OPTION,
          json: JSON_OPTION,
        },
        run(input, ctx) {
          const threadId = resolveThreadId(input.options.thread, ctx);
          const profile = input.options.temporary
            ? null
            : input.options.profile;
          if (profile !== null && !profileSchema.safeParse(profile).success) {
            throw new PluginCliError(
              "Profile names use 1-40 lowercase letters, digits, and dashes, starting with a letter or digit",
              { code: "invalid_selection" },
            );
          }
          const hostId = input.options.machine;
          return deps.execute(
            {
              method: "open",
              input: {
                threadId,
                profile,
                ...(hostId === undefined ? {} : { hostId }),
              },
            },
            ctx,
          );
        },
      }),
      list: cliCommand({
        summary: "List this thread's browser sessions, with each one's profile",
        options: { thread: THREAD_OPTION, json: JSON_OPTION },
        run: (input, ctx) =>
          deps.execute(
            {
              method: "list",
              input: { threadId: resolveThreadId(input.options.thread, ctx) },
            },
            ctx,
          ),
      }),
      run: cliCommand({
        summary: "Run a trusted DevBrowser script; runs serialize per session",
        description:
          "Scripts may return at most 4 screenshots per run, JPEG only, 500 KB combined;\nanything larger or in another format fails the run. Output over 512 KB stops\nthe run with exit code 1 and keeps the session open.",
        positionals: [SESSION_POSITIONAL],
        constraints: [
          { kind: "exactly-one", options: ["script", "script-file"] },
          { kind: "requires", option: "script-file", needs: ["script-host"] },
          { kind: "requires", option: "script-host", needs: ["script-file"] },
          { kind: "at-most-one", options: ["timeout", "timeout-ms"] },
        ],
        options: {
          script: {
            type: "string",
            placeholder: "code",
            description: "DevBrowser script source",
          },
          "script-file": {
            type: "string",
            placeholder: "path",
            description: "File holding the script, read from --script-host",
          },
          "script-host": {
            type: "string",
            placeholder: "host-id",
            description: "Host that holds --script-file",
          },
          "timeout-ms": {
            type: "integer",
            min: 1000,
            max: 120_000,
            default: 30_000,
            description: "Run timeout in milliseconds",
          },
          timeout: {
            type: "duration",
            defaultUnit: "s",
            bareUnits: ["s", "ms"],
            min: 1000,
            max: 120_000,
            description:
              "Run timeout as a duration (90s, 2m, 1500ms); a bare number is seconds (1-120) or milliseconds (1000-120000)",
          },
          thread: THREAD_OPTION,
          json: JSON_OPTION,
        },
        run(input, ctx) {
          const threadId = resolveThreadId(input.options.thread, ctx);
          const scriptFile = input.options["script-file"];
          const scriptHost = input.options["script-host"];
          return deps.execute(
            {
              method: "run",
              input: {
                threadId,
                sessionId: input.positionals["session-id"],
                ...(input.options.script === undefined
                  ? {}
                  : { script: input.options.script }),
                timeoutMs: input.options.timeout ?? input.options["timeout-ms"],
              },
              ...(scriptFile === undefined ? {} : { scriptFile }),
              ...(scriptHost === undefined ? {} : { scriptHost }),
            },
            ctx,
          );
        },
      }),
      pages: cliCommand({
        summary: "Inspect persistent named pages",
        positionals: [SESSION_POSITIONAL],
        options: { thread: THREAD_OPTION, json: JSON_OPTION },
        run: (input, ctx) =>
          deps.execute(
            {
              method: "pages",
              input: {
                threadId: resolveThreadId(input.options.thread, ctx),
                sessionId: input.positionals["session-id"],
              },
            },
            ctx,
          ),
      }),
      screenshot: cliCommand({
        summary:
          "Save a bounded JPEG in session tmp; return its path and host ID",
        positionals: [SESSION_POSITIONAL],
        options: {
          page: {
            type: "string",
            placeholder: "name",
            default: "main",
            description: "Named page to capture",
          },
          thread: THREAD_OPTION,
          json: JSON_OPTION,
        },
        run: (input, ctx) =>
          deps.execute(
            {
              method: "screenshot",
              input: {
                threadId: resolveThreadId(input.options.thread, ctx),
                sessionId: input.positionals["session-id"],
                page: input.options.page,
              },
            },
            ctx,
          ),
      }),
      preview: cliCommand({
        summary:
          "Describe the live preview frame of a session, without image bytes",
        positionals: [SESSION_POSITIONAL],
        options: {
          after: {
            type: "integer",
            min: 0,
            max: Number.MAX_SAFE_INTEGER,
            default: 0,
            description: "Only report a frame newer than this sequence number",
          },
          thread: THREAD_OPTION,
          json: JSON_OPTION,
        },
        run: (input, ctx) =>
          deps.execute(
            {
              method: "preview",
              input: {
                threadId: resolveThreadId(input.options.thread, ctx),
                sessionId: input.positionals["session-id"],
                afterSequence: input.options.after,
              },
            },
            ctx,
          ),
      }),
      stop: cliCommand({
        summary: "Cancel queued and running work; open a new session to resume",
        positionals: [SESSION_POSITIONAL],
        options: { thread: THREAD_OPTION, json: JSON_OPTION },
        run: (input, ctx) =>
          deps.execute(
            {
              method: "stop",
              input: {
                threadId: resolveThreadId(input.options.thread, ctx),
                sessionId: input.positionals["session-id"],
              },
            },
            ctx,
          ),
      }),
      close: cliCommand({
        summary:
          "End the session and close its named pages; a shared profile keeps its other tabs",
        positionals: [SESSION_POSITIONAL],
        options: { thread: THREAD_OPTION, json: JSON_OPTION },
        run: (input, ctx) =>
          deps.execute(
            {
              method: "close",
              input: {
                threadId: resolveThreadId(input.options.thread, ctx),
                sessionId: input.positionals["session-id"],
              },
            },
            ctx,
          ),
      }),
    },
  });
}

export function browserCliFailure(error: unknown): PluginCliError {
  if (error instanceof PluginCliError) return error;
  const message =
    error instanceof Error ? error.message : "Browser command failed";
  if (/stopped or expired|does not belong to this thread/u.test(message)) {
    return new PluginCliError(message, {
      code: "session_unavailable",
      hint: REOPEN_HINT,
    });
  }
  if (/screenshot|JPEG/iu.test(message)) {
    return new PluginCliError(message, {
      code: "screenshot_limit",
      hint: "Return at most 4 JPEG screenshots per run, 500 KB combined.",
    });
  }
  return new PluginCliError(message, { code: "command_failed" });
}
