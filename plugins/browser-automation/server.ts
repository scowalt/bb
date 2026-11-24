import { experimental_resolveHostPath as resolveHostPath } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import type {
  BbPluginApi,
  PluginCliContext,
  PluginRpcHandlers,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DEFAULT_PROFILE,
  hostContract,
  rpcContract,
  sessionSchema,
  type PreviewOutput,
  type RunOutput,
  type Session,
} from "./contracts.js";
import {
  browserCliFailure,
  createBrowserAutomationCli,
  type BrowserCliMethod,
  type BrowserCliRequest,
} from "./cli.js";
import { previewDirective } from "./preview-directive.js";

const recordSchema = z
  .object({
    session: sessionSchema,
    lastUsed: z.number(),
    cleanupPending: z.boolean(),
  })
  .strict();
type RecordEntry = z.infer<typeof recordSchema>;
const legacyRecordSchema = z
  .object({
    session: sessionSchema.extend({
      backend: z.enum(["desktop", "local"]),
      profile: sessionSchema.shape.profile.default(null),
    }),
    desktop: z.unknown(),
    lastUsed: z.number(),
    cleanupPending: z.boolean(),
  })
  .strict();
const idleTimeoutMs = 30 * 60_000;
const maxLifetimeMs = 8 * 60 * 60_000;
const hardDeadline = (session: Session) => session.createdAt + maxLifetimeMs;
const previewWaitMs = 5_000;
const runCallGraceMs = 10_000;
const keyFor = (threadId: string, sessionId: string) =>
  `sessions/${encodeURIComponent(threadId)}/${sessionId}`;

export default async function browserAutomationPlugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const active = new Map<string, RecordEntry>();
  const busy = new Map<string, number>();
  const pending = new Set<Promise<void>>();
  const cleanup = new Map<
    string,
    { state: "stopped" | "closed"; work: Promise<Session> }
  >();
  const opening = new Map<string, AbortController>();
  const lifecycle = new AbortController();
  const threadLifecycles = new Map<string, AbortController>();
  const save = (record: RecordEntry) =>
    bb.storage.kv.set(
      keyFor(record.session.threadId, record.session.id),
      record,
    );
  async function owned(threadId: string, sessionId: string) {
    const record = recordSchema.parse(
      await bb.storage.kv.get(keyFor(threadId, sessionId)),
    );
    if (record.session.threadId !== threadId || record.session.id !== sessionId)
      throw new Error("Session does not belong to this thread");
    return active.get(sessionId) ?? record;
  }
  async function finish(
    record: RecordEntry,
    requested: "stopped" | "closed",
  ): Promise<Session> {
    const existing = cleanup.get(record.session.id);
    if (existing) {
      if (existing.state === "closed" || existing.state === requested)
        return existing.work;
      await existing.work.catch(() => {});
      return finish(record, requested);
    }
    const previous = recordSchema.safeParse(
      await bb.storage.kv.get(
        keyFor(record.session.threadId, record.session.id),
      ),
    );
    if (cleanup.has(record.session.id)) return finish(record, requested);
    const closed =
      record.session.state === "closed" ||
      (previous.success && previous.data.session.state === "closed");
    if (
      previous.success &&
      previous.data.session.state === "closed" &&
      !previous.data.cleanupPending
    )
      return previous.data.session;
    const state = closed ? "closed" : requested;
    const work = (async () => {
      const { session } = record;
      opening.get(session.id)?.abort();
      if (state === "closed") active.delete(session.id);
      else active.set(session.id, record);
      session.state = state;
      record.cleanupPending = true;
      await save(record);
      const failure = await host
        .call(
          "close",
          { sessionId: session.id },
          { hostId: session.hostId, signal: AbortSignal.timeout(10_000) },
        )
        .then(
          () => null,
          (reason: unknown) => ({ reason }),
        );
      record.cleanupPending = failure !== null;
      await save(record);
      if (failure) {
        const reasons =
          failure.reason instanceof Error
            ? failure.reason.message
            : String(failure.reason);
        bb.log.warn(
          `Browser Automation cleanup on host ${session.hostId} failed: ${reasons}`,
        );
        throw new Error(
          `Browser session ${state}, but cleanup on host ${session.hostId} failed: ${reasons}. Run close to retry.`,
        );
      }
      return session;
    })();
    cleanup.set(record.session.id, { state, work });
    try {
      return await work;
    } finally {
      cleanup.delete(record.session.id);
    }
  }
  async function readStored(key: string): Promise<RecordEntry | null> {
    const stored = await bb.storage.kv.get(key);
    const current = recordSchema.safeParse(stored);
    if (current.success) return current.data;
    const legacy = legacyRecordSchema.safeParse(stored);
    if (!legacy.success) return null;
    const {
      session: { backend, ...session },
      lastUsed,
      cleanupPending,
    } = legacy.data;
    if (backend === "desktop") {
      await bb.storage.kv.delete(key);
      return null;
    }
    const record: RecordEntry = { session, lastUsed, cleanupPending };
    await bb.storage.kv.set(key, record);
    return record;
  }
  const unfinished: RecordEntry[] = [];
  for (const key of await bb.storage.kv.list("sessions/")) {
    const record = await readStored(key);
    if (!record) continue;
    if (record.session.state === "closed" && !record.cleanupPending) continue;
    unfinished.push(record);
  }
  bb.background.service("restart-cleanup", {
    async start() {
      for (const record of unfinished.splice(0))
        await finish(record, "closed").catch(() =>
          bb.log.warn(
            "Browser Automation restart cleanup will need the browser host to reconnect",
          ),
        );
    },
  });
  async function open(
    input: z.output<typeof rpcContract.open.input>,
    signal: AbortSignal,
  ): Promise<Session> {
    let threadLifecycle = threadLifecycles.get(input.threadId);
    if (!threadLifecycle) {
      threadLifecycle = new AbortController();
      threadLifecycles.set(input.threadId, threadLifecycle);
    }
    signal = AbortSignal.any([signal, threadLifecycle.signal]);
    signal.throwIfAborted();
    await bb.sdk.threads.get({ threadId: input.threadId });
    const hostId = input.hostId ?? (await threadHost(input.threadId, signal));
    if (active.size >= 64)
      throw new Error(
        "Browser session limit reached; close an existing session",
      );
    const now = Date.now();
    const session: Session = {
      id: randomUUID(),
      threadId: input.threadId,
      hostId,
      profile: input.profile,
      state: "ready",
      createdAt: now,
      expiresAt: now + idleTimeoutMs,
    };
    const record: RecordEntry = {
      session,
      lastUsed: now,
      cleanupPending: false,
    };
    const retirement = new AbortController();
    opening.set(session.id, retirement);
    signal = AbortSignal.any([signal, retirement.signal]);
    try {
      await save(record);
      active.set(session.id, record);
      while (true) {
        const runtime = await host.call(
          "prepare",
          {},
          { hostId: session.hostId, signal },
        );
        if (runtime.status === "ready") break;
        bb.log.info(
          `DevBrowser runtime on host ${session.hostId}: ${runtime.detail}`,
        );
      }
      await host.call(
        "open",
        {
          sessionId: session.id,
          ...(session.profile === null ? {} : { profile: session.profile }),
          expiresAt: hardDeadline(session),
          idleTimeoutMs,
        },
        { hostId: session.hostId, signal },
      );
      signal.throwIfAborted();
      return session;
    } catch (error) {
      await finish(record, "closed").catch(() => {});
      throw error;
    } finally {
      opening.delete(session.id);
    }
  }
  async function touch(record: RecordEntry) {
    record.lastUsed = Date.now();
    record.session.expiresAt = Math.min(
      record.lastUsed + idleTimeoutMs,
      hardDeadline(record.session),
    );
    try {
      await save(record);
    } catch (error) {
      bb.log.warn(
        `Browser Automation could not persist session activity: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  async function run(
    input: z.output<typeof rpcContract.run.input>,
    signal: AbortSignal,
  ): Promise<RunOutput> {
    const record = await owned(input.threadId, input.sessionId);
    if (
      record.session.state !== "ready" ||
      Date.now() >= hardDeadline(record.session) ||
      (!busy.get(input.sessionId) && Date.now() >= record.session.expiresAt)
    )
      throw new Error("Session stopped or expired; open a new session");
    busy.set(input.sessionId, (busy.get(input.sessionId) ?? 0) + 1);
    try {
      await touch(record);
      const result = await host.call(
        "run",
        {
          sessionId: input.sessionId,
          script: input.script,
          timeoutMs: input.timeoutMs,
        },
        {
          hostId: record.session.hostId,
          signal,
          timeoutMs: input.timeoutMs + runCallGraceMs,
        },
      );
      if (result.exitCode === 124)
        await finish(record, "stopped").catch(() => {});
      return result;
    } catch (error) {
      await finish(record, "stopped").catch(() => {});
      throw error;
    } finally {
      const remaining = (busy.get(input.sessionId) ?? 1) - 1;
      if (remaining > 0) busy.set(input.sessionId, remaining);
      else busy.delete(input.sessionId);
      const current = active.get(input.sessionId);
      if (current?.session.state === "ready") await touch(current);
    }
  }
  const viewable = (session: Session) =>
    session.state === "ready" && Date.now() < session.expiresAt;
  async function preview(
    input: z.output<typeof rpcContract.preview.input>,
    signal: AbortSignal,
  ): Promise<PreviewOutput> {
    const record = await owned(input.threadId, input.sessionId);
    const { session } = record;
    if (!viewable(session)) return { session, frame: null };
    if (input.size === "full") await touch(record);
    const { frame } = await host.call(
      "preview",
      {
        sessionId: session.id,
        afterSequence: input.afterSequence,
        waitMs: previewWaitMs,
        size: input.size,
      },
      { hostId: session.hostId, signal },
    );
    return { session, frame };
  }
  async function input(
    request: z.output<typeof rpcContract.input.input>,
    signal: AbortSignal,
  ): Promise<null> {
    const record = await owned(request.threadId, request.sessionId);
    if (!viewable(record.session))
      throw new Error("Browser session is not ready; open a new session");
    await touch(record);
    return host.call(
      "input",
      { sessionId: request.sessionId, actions: request.actions },
      { hostId: record.session.hostId, signal },
    );
  }
  const openingForThread = new Map<string, Promise<Session>>();
  async function threadHost(threadId: string, signal: AbortSignal) {
    const { environmentId } = await bb.sdk.threads.get({ threadId, signal });
    const hostId =
      environmentId === null
        ? null
        : (await bb.sdk.environments.get({ environmentId, signal })).hostId;
    if (!hostId)
      throw new Error(
        "This thread has no environment host; choose one with `bb browser-automation open --machine <name-or-id>`",
      );
    return hostId;
  }
  function openForThread(threadId: string, signal: AbortSignal) {
    const inFlight = openingForThread.get(threadId);
    if (inFlight) return inFlight;
    const reusable = [...active.values()]
      .map((record) => record.session)
      .filter(
        (session) =>
          session.threadId === threadId &&
          viewable(session) &&
          Date.now() < hardDeadline(session),
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (reusable) return Promise.resolve(reusable);
    const work = open({ threadId, profile: DEFAULT_PROFILE }, signal).finally(
      () => openingForThread.delete(threadId),
    );
    openingForThread.set(threadId, work);
    return work;
  }
  function handlers(
    signal: AbortSignal,
  ): PluginRpcHandlers<typeof rpcContract> {
    return {
      open: (input) => open(input, signal),
      async list({ threadId }) {
        const records = await Promise.all(
          (
            await bb.storage.kv.list(
              `sessions/${encodeURIComponent(threadId)}/`,
            )
          )
            .slice(-64)
            .map(
              async (key) =>
                recordSchema.parse(await bb.storage.kv.get(key)).session,
            ),
        );
        return records.sort(
          (a, b) =>
            Number(b.state === "ready") - Number(a.state === "ready") ||
            b.createdAt - a.createdAt,
        );
      },
      run: (input) => run(input, signal),
      pages: (input) =>
        run(
          { ...input, script: "await browser.listPages()", timeoutMs: 30_000 },
          signal,
        ),
      screenshot: (input) =>
        run(
          {
            ...input,
            script: `const page = await browser.getPage(${JSON.stringify(input.page)}); await page.shot({ type: "jpeg", maxEdge: 960, quality: 70 }); undefined`,
            timeoutMs: 30_000,
          },
          signal,
        ),
      preview: (request) => preview(request, signal),
      input: (request) => input(request, signal),
      openForThread: ({ threadId }) => openForThread(threadId, signal),
      stop: async (input) =>
        finish(await owned(input.threadId, input.sessionId), "stopped"),
      close: async (input) =>
        finish(await owned(input.threadId, input.sessionId), "closed"),
    };
  }
  bb.rpc.register(rpcContract, handlers(lifecycle.signal));
  function dispatch(
    method: BrowserCliMethod,
    input: unknown,
    signal: AbortSignal,
  ) {
    const h = handlers(signal);
    switch (method) {
      case "open":
        return h.open(rpcContract.open.input.parse(input));
      case "list":
        return h.list(rpcContract.list.input.parse(input));
      case "run":
        return h.run(rpcContract.run.input.parse(input));
      case "pages":
        return h.pages(rpcContract.pages.input.parse(input));
      case "screenshot":
        return h.screenshot(rpcContract.screenshot.input.parse(input));
      case "preview":
        return h.preview(rpcContract.preview.input.parse(input));
      case "stop":
        return h.stop(rpcContract.stop.input.parse(input));
      case "close":
        return h.close(rpcContract.close.input.parse(input));
    }
  }
  bb.agents.configure(() => ({
    tools: [],
    skills: ["browser-automation"],
    instructions:
      "Use `bb browser-automation` for all web browsing. It drives the remote browser on this thread's host: the same browser, with the same signed-in profile, that the user sees and controls in the side panel's Remote browser tab. Run `bb browser-automation list --json` first and reuse a ready session, which the user may have opened from the side panel; otherwise run `bb browser-automation open --json`. Pass `--temporary` only when a task needs a clean, signed-out browser. Copy the previewDirective that `open` returns into your next response exactly once as a standalone line, not in backticks or a code fence, and never invent or edit the session ID; it shows the user a live view. Never drive the user's desktop in-app browser with `bb browser` commands; those are for the user's own use.",
  }));
  async function executeCli(
    request: BrowserCliRequest,
    context: PluginCliContext,
  ) {
    try {
      const input = { ...request.input };
      if (request.method === "open" && input.hostId !== undefined) {
        const target = input.hostId.trim();
        const hosts = await bb.sdk.hosts.list({ signal: context.signal });
        const idMatch = hosts.find((candidate) => candidate.id === target);
        const matches = idMatch
          ? [idMatch]
          : hosts.filter((candidate) => candidate.name === target);
        if (matches.length === 0)
          throw new Error(`Machine '${target}' was not found`);
        if (matches.length > 1)
          throw new Error(
            `Machine name '${target}' is ambiguous; use an exact host ID`,
          );
        input.hostId = matches[0].id;
      }
      if (request.scriptFile) {
        if (!request.scriptHost)
          throw new Error("Script file requires an explicit source host");
        const path = resolveHostPath({
          rootPath: context.cwd ?? "",
          path: request.scriptFile,
        });
        if (path === null)
          throw new Error(
            "Invalid script file path; relative paths require the invoking CLI working directory",
          );
        const file = await bb.sdk.files.read({
          hostId: request.scriptHost,
          path,
          signal: context.signal,
        });
        if (file.contentEncoding !== "utf8")
          throw new Error("Script file must be UTF-8 text");
        input.script = file.content;
      }
      const result = await dispatch(
        request.method,
        input,
        AbortSignal.any([
          context.signal ?? new AbortController().signal,
          lifecycle.signal,
        ]),
      );
      const output = rpcContract.run.output.safeParse(result);
      const previewed = rpcContract.preview.output.safeParse(result);
      const opened =
        request.method === "open"
          ? rpcContract.open.output.safeParse(result)
          : null;
      const printable = opened?.success
        ? { ...opened.data, previewDirective: previewDirective(opened.data.id) }
        : output.success
          ? {
              ...output.data,
              hostId: (await owned(input.threadId, input.sessionId ?? ""))
                .session.hostId,
            }
          : previewed.success
            ? {
                session: previewed.data.session,
                frame: previewed.data.frame && {
                  sequence: previewed.data.frame.sequence,
                  mimeType: previewed.data.frame.mimeType,
                  width: previewed.data.frame.width,
                  height: previewed.data.frame.height,
                  url: previewed.data.frame.url,
                  title: previewed.data.frame.title,
                  activeTabId: previewed.data.frame.activeTabId,
                  tabs: previewed.data.frame.tabs,
                  bytes: Buffer.byteLength(previewed.data.frame.data, "base64"),
                },
              }
            : result;
      return {
        exitCode: output.success ? output.data.exitCode : 0,
        stdout: JSON.stringify(printable),
      };
    } catch (error) {
      throw browserCliFailure(error);
    }
  }
  bb.cli.register(createBrowserAutomationCli({ execute: executeCli }));
  for (const event of [
    "thread.archived",
    "thread.deleted",
    "thread.failed",
  ] as const) {
    bb.events.on(event, async ({ thread }) => {
      threadLifecycles.get(thread.id)?.abort();
      threadLifecycles.delete(thread.id);
      const results = await Promise.allSettled(
        [...active.values()]
          .filter((record) => record.session.threadId === thread.id)
          .map((record) => finish(record, "closed")),
      );
      if (results.some((result) => result.status === "rejected")) {
        bb.log.warn(
          `Browser Automation cleanup for thread ${thread.id} needs its host to reconnect`,
        );
      }
    });
  }
  const timer = setInterval(() => {
    for (const record of active.values()) {
      if (
        Date.now() < hardDeadline(record.session) &&
        (busy.get(record.session.id) ||
          Date.now() - record.lastUsed < idleTimeoutMs)
      )
        continue;
      const work = finish(record, "closed").then(
        () => {},
        () => {},
      );
      pending.add(work);
      void work.finally(() => pending.delete(work));
    }
  }, 1000);
  timer.unref();
  host.experimental_onWorkerExit(async ({ hostId }) => {
    await Promise.allSettled(
      [...active.values()]
        .filter((record) => record.session.hostId === hostId)
        .map((record) => finish(record, "closed")),
    );
  });
  bb.onDispose(async () => {
    lifecycle.abort();
    clearInterval(timer);
    await Promise.allSettled(
      [...active.values()].map((record) => finish(record, "closed")),
    );
    await Promise.allSettled(pending);
  });
}
