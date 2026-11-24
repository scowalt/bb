import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeHostResponse,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import plugin from "./server.js";
import { rpcContract } from "./contracts.js";

async function setup() {
  const worker = vi.fn(
    async ({
      method,
    }: {
      method: string;
      hostId: string;
      signal?: AbortSignal;
    }): Promise<unknown> =>
      method === "run"
        ? { text: "done", images: [], exitCode: 0 }
        : method === "prepare"
          ? { status: "ready", version: "1.0.0-test", source: "release" }
          : null,
  );
  const host = createFakePluginHost({
    pluginId: "browser-automation",
    agentSkillIds: ["browser-automation"],
    experimental_callHostRpc: worker,
  });
  host.harness.sdk.stub("threads.get", async () =>
    makeThreadResponse({ id: "thread-test", environmentId: "env-1" }),
  );
  host.harness.sdk.stub("environments.get", async () => ({
    hostId: "env-host",
  }));
  host.harness.sdk.stub("hosts.list", async () => [
    makeHostResponse({ id: "local-host", name: "Lab workstation" }),
    makeHostResponse({ id: "env-host", name: "Thread host" }),
  ]);
  await plugin(host.bb);
  async function open(threadId = "thread-test", hostId = "local-host") {
    const result = await host.harness.behavior.callRpc("open", {
      threadId,
      hostId,
    });
    return rpcContract.open.output.parse(result);
  }
  return { ...host, worker, open };
}

it.each([
  ["/workspace", "script.js", "/workspace/script.js"],
  [
    "//server/share/workspace",
    "script.js",
    "\\\\server\\share\\workspace\\script.js",
  ],
  ["C:", "script.js", "C:\\script.js"],
  ["C:\\workspace", "\\script.js", null],
])("reads CLI scripts on their host: %s + %s", async (cwd, file, expected) => {
  const h = await setup();
  try {
    const session = await h.open();
    h.harness.sdk.stub("files.read", async () => ({
      content: "return 1",
      contentEncoding: "utf8",
    }));
    const result = await h.harness.behavior.runCli(
      ["run", session.id, "--script-file", file, "--script-host", "local-host"],
      { threadId: "thread-test", cwd },
    );
    if (expected === null) {
      expect(result.exitCode).toBe(1);
      expect(h.harness.sdk.callsTo("files.read")).toEqual([]);
    } else {
      expect(result.exitCode).toBe(0);
      expect(h.harness.sdk.callsTo("files.read")).toEqual([
        [expect.objectContaining({ hostId: "local-host", path: expected })],
      ]);
    }
  } finally {
    await h.harness.lifecycle.dispose();
  }
});

describe("server session ownership", () => {
  it.each([
    ["Lab workstation", "local-host"],
    ["local-host", "local-host"],
  ])("resolves machine selector %s before opening", async (target, hostId) => {
    const h = await setup();
    try {
      const result = await h.harness.behavior.runCli(
        ["open", "--machine", target, "--json"],
        { threadId: "thread-test" },
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ hostId });
      expect(h.worker).toHaveBeenCalledWith(
        expect.objectContaining({ method: "prepare", hostId }),
      );
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("prefers an exact machine ID over a matching name", async () => {
    const h = await setup();
    h.harness.sdk.stub("hosts.list", async () => [
      makeHostResponse({ id: "other-host", name: "local-host" }),
      makeHostResponse({ id: "local-host", name: "Lab workstation" }),
    ]);
    try {
      const result = await h.harness.behavior.runCli(
        ["open", "--machine", " local-host ", "--json"],
        { threadId: "thread-test" },
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ hostId: "local-host" });
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it.each([
    ["Shared lab", "ambiguous"],
    ["Missing lab", "not found"],
  ])(
    "rejects machine selector %s before creating a session",
    async (target, message) => {
      const h = await setup();
      h.harness.sdk.stub("hosts.list", async () => [
        makeHostResponse({ id: "host-a", name: "Shared lab" }),
        makeHostResponse({ id: "host-b", name: "Shared lab" }),
      ]);
      try {
        const result = await h.harness.behavior.runCli(
          ["open", "--machine", target, "--json"],
          { threadId: "thread-test" },
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(message);
        expect(h.worker).not.toHaveBeenCalled();
        expect(
          await h.harness.behavior.callRpc("list", { threadId: "thread-test" }),
        ).toEqual([]);
      } finally {
        await h.harness.lifecycle.dispose();
      }
    },
  );

  it("lists ready sessions before ended ones", async () => {
    const h = await setup();
    try {
      const older = await h.open();
      const newer = await h.open();
      await h.harness.behavior.callRpc("close", {
        threadId: "thread-test",
        sessionId: older.id,
      });
      const sessions = rpcContract.list.output.parse(
        await h.harness.behavior.callRpc("list", { threadId: "thread-test" }),
      );
      expect(sessions.map((entry) => [entry.id, entry.state])).toEqual([
        [newer.id, "ready"],
        [older.id, "closed"],
      ]);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("returns browser-host image paths through the CLI without registering tools", async () => {
    const h = await setup();
    try {
      const session = await h.open();
      const images = [
        {
          path: "/tmp/browser-session/tmp/capture.jpg",
          mimeType: "image/jpeg",
          width: 640,
          height: 400,
        },
      ];
      h.worker.mockResolvedValueOnce({ text: "captured", images, exitCode: 0 });
      const result = await h.harness.behavior.runCli(
        ["screenshot", session.id, "--json"],
        { threadId: "thread-test" },
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        text: "captured",
        images,
        exitCode: 0,
        hostId: "local-host",
      });
      expect(h.harness.registrations.agentTools).toEqual([]);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("denies cross-thread RPC and CLI access before calling the worker", async () => {
    const h = await setup();
    try {
      const session = await h.open();
      await expect(
        h.harness.behavior.callRpc("run", {
          threadId: "other",
          sessionId: session.id,
          script: "1",
        }),
      ).rejects.toThrow();
      const denied = await h.harness.behavior.runCli(
        ["run", session.id, "--thread", "thread-test", "--script", "1"],
        { threadId: "other" },
      );
      expect(denied.exitCode).toBe(1);
      expect(denied.stderr).toContain("another thread");
      expect(
        h.worker.mock.calls.filter(([call]) => call.method === "run"),
      ).toHaveLength(0);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it.each(["thread.archived", "thread.deleted", "thread.failed"] as const)(
    "%s closes only the owning thread's sessions",
    async (event) => {
      const h = await setup();
      try {
        const session = await h.open();
        const other = await h.open("other");
        await h.harness.behavior.emitThreadEvent("thread.idle", {
          thread: makeThreadResponse({ id: "thread-test" }),
          lastAssistantText: null,
        });
        expect(
          h.worker.mock.calls.filter(([call]) => call.method === "close"),
        ).toHaveLength(0);
        await h.harness.behavior.emitThreadEvent(event, {
          thread: makeThreadResponse({ id: "thread-test" }),
          error: null,
        });
        const own = rpcContract.list.output.parse(
          await h.harness.behavior.callRpc("list", { threadId: "thread-test" }),
        );
        const remaining = rpcContract.list.output.parse(
          await h.harness.behavior.callRpc("list", { threadId: "other" }),
        );
        expect(own.find((entry) => entry.id === session.id)?.state).toBe(
          "closed",
        );
        expect(remaining.find((entry) => entry.id === other.id)?.state).toBe(
          "ready",
        );
      } finally {
        await h.harness.lifecycle.dispose();
      }
    },
  );
  it("concurrent stop and close leave the session closed", async () => {
    const h = await setup();
    try {
      const session = await h.open();
      const input = { threadId: "thread-test", sessionId: session.id };
      await Promise.all([
        h.harness.behavior.callRpc("stop", input),
        h.harness.behavior.callRpc("close", input),
      ]);
      const sessions = rpcContract.list.output.parse(
        await h.harness.behavior.callRpc("list", { threadId: "thread-test" }),
      );
      expect(sessions.find((entry) => entry.id === session.id)?.state).toBe(
        "closed",
      );
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("waits for the browser host to finish installing the runtime before opening", async () => {
    const h = await setup();
    try {
      let polls = 0;
      h.worker.mockImplementation(async ({ method }) => {
        if (method === "prepare")
          return ++polls < 3
            ? { status: "installing", detail: `step ${polls}` }
            : { status: "ready", version: "1.0.0-test", source: "release" };
        return null;
      });
      await h.open();
      const methods = h.worker.mock.calls.map(([call]) => call.method);
      expect(methods.filter((method) => method === "prepare")).toHaveLength(3);
      expect(methods.indexOf("open")).toBeGreaterThan(
        methods.lastIndexOf("prepare"),
      );
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("closes the session when worker launch fails", async () => {
    const h = await setup();
    try {
      h.worker.mockImplementation(async ({ method }) => {
        if (method === "open") throw new Error("failed startup");
        if (method === "prepare")
          return { status: "ready", version: "1.0.0-test", source: "release" };
        return null;
      });
      await expect(h.open()).rejects.toThrow("failed startup");
      const [session] = rpcContract.list.output.parse(
        await h.harness.behavior.callRpc("list", { threadId: "thread-test" }),
      );
      expect(session?.state).toBe("closed");
      expect(
        h.worker.mock.calls.filter(([call]) => call.method === "close"),
      ).toHaveLength(1);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
});
describe("server session cleanup", () => {
  const ready = { status: "ready", version: "1.0.0-test", source: "release" };
  const ownedBy = (sessionId: string) => ({
    threadId: "thread-test",
    sessionId,
  });
  const openLocal = (h: Awaited<ReturnType<typeof setup>>, hostId?: string) =>
    h.open("thread-test", hostId);
  async function listed(h: Awaited<ReturnType<typeof setup>>, id: string) {
    const sessions = rpcContract.list.output.parse(
      await h.harness.behavior.callRpc("list", { threadId: "thread-test" }),
    );
    return sessions.find((entry) => entry.id === id);
  }
  const hostCalls = (h: Awaited<ReturnType<typeof setup>>, method: string) =>
    h.worker.mock.calls.filter(([call]) => call.method === method);

  it.each(["before", "after", "both"] as const)(
    "keeps a session usable when renewal persistence fails %s execution",
    async (failureAt) => {
      const h = await setup();
      const persist = vi.spyOn(h.bb.storage.kv, "set");
      try {
        const session = await openLocal(h);
        const storageError = new Error("renewal write unavailable");
        if (failureAt === "before") persist.mockRejectedValueOnce(storageError);
        if (failureAt === "both") persist.mockRejectedValue(storageError);
        if (failureAt === "after")
          h.worker.mockImplementationOnce(async () => {
            persist.mockRejectedValueOnce(storageError);
            return { text: "done", images: [], exitCode: 0 };
          });
        const input = { ...ownedBy(session.id), script: "1" };
        const outcome = await h.harness.behavior.callRpc("run", input).then(
          (result) => ({ result }),
          (error: unknown) => ({ error: String(error) }),
        );
        expect({ outcome, closes: hostCalls(h, "close").length }).toEqual({
          outcome: { result: { text: "done", images: [], exitCode: 0 } },
          closes: 0,
        });
        persist.mockRestore();
        await expect(h.harness.behavior.callRpc("run", input)).resolves.toEqual(
          {
            text: "done",
            images: [],
            exitCode: 0,
          },
        );
        expect((await listed(h, session.id))?.state).toBe("ready");
      } finally {
        persist.mockRestore();
        await h.harness.lifecycle.dispose();
      }
    },
  );

  it("renews real operations beyond 30 minutes and closes after 30 minutes idle", async () => {
    vi.useFakeTimers();
    const h = await setup();
    try {
      const session = await openLocal(h);
      expect(hostCalls(h, "open")[0]?.[0]).toMatchObject({
        input: {
          expiresAt: session.createdAt + 8 * 60 * 60_000,
          idleTimeoutMs: 30 * 60_000,
        },
      });
      for (const [index, method] of ["run", "pages", "screenshot"].entries()) {
        vi.setSystemTime(session.createdAt + (index + 1) * 20 * 60_000);
        await h.harness.behavior.callRpc(method, {
          ...ownedBy(session.id),
          ...(method === "run" ? { script: "1" } : {}),
        });
        expect((await listed(h, session.id))?.expiresAt).toBe(
          Date.now() + 30 * 60_000,
        );
      }
      await vi.advanceTimersByTimeAsync(29 * 60_000);
      expect((await listed(h, session.id))?.state).toBe("ready");
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await listed(h, session.id))?.state).toBe("closed");
      expect(hostCalls(h, "close")).toHaveLength(1);
    } finally {
      await h.harness.lifecycle.dispose();
      vi.useRealTimers();
    }
  });

  it("does not let list or automatic preview polling keep an abandoned session alive", async () => {
    vi.useFakeTimers();
    const h = await setup();
    try {
      const session = await openLocal(h);
      h.worker.mockResolvedValue({ frame: null });
      vi.setSystemTime(session.createdAt + 29 * 60_000);
      await h.harness.behavior.callRpc("preview", ownedBy(session.id));
      expect((await listed(h, session.id))?.expiresAt).toBe(session.expiresAt);
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await listed(h, session.id))?.state).toBe("closed");
    } finally {
      await h.harness.lifecycle.dispose();
      vi.useRealTimers();
    }
  });

  it("gives the host call a deadline longer than the script timeout", async () => {
    const h = await setup();
    try {
      const session = await openLocal(h);
      await h.harness.behavior.callRpc("run", {
        ...ownedBy(session.id),
        script: "1",
        timeoutMs: 120_000,
      });
      await h.harness.behavior.callRpc("run", {
        ...ownedBy(session.id),
        script: "1",
      });
      await h.harness.behavior.callRpc("pages", ownedBy(session.id));
      await h.harness.behavior.callRpc("screenshot", {
        ...ownedBy(session.id),
        page: "main",
      });
      expect(hostCalls(h, "run").map(([call]) => call)).toMatchObject([
        { input: { timeoutMs: 120_000 }, timeoutMs: 130_000 },
        { input: { timeoutMs: 30_000 }, timeoutMs: 40_000 },
        { input: { timeoutMs: 30_000 }, timeoutMs: 40_000 },
        { input: { timeoutMs: 30_000 }, timeoutMs: 40_000 },
      ]);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("caps renewal at eight hours and closes work still running at the cap", async () => {
    vi.useFakeTimers();
    const h = await setup();
    try {
      const session = await openLocal(h);
      const input = { ...ownedBy(session.id), script: "1" };
      for (let minute = 20; minute <= 460; minute += 20) {
        vi.setSystemTime(session.createdAt + minute * 60_000);
        await h.harness.behavior.callRpc("run", input);
      }
      const deadline = session.createdAt + 8 * 60 * 60_000;
      expect((await listed(h, session.id))?.expiresAt).toBe(deadline);
      vi.setSystemTime(deadline - 60_000);
      let finishRun!: () => void;
      const started = new Promise<void>((resolve) => {
        h.worker.mockImplementation(async ({ method }) => {
          if (method === "run") {
            resolve();
            await new Promise<void>((done) => (finishRun = done));
            return { text: "done", images: [], exitCode: 0 };
          }
          return null;
        });
      });
      const running = h.harness.behavior.callRpc("run", input);
      await started;
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await listed(h, session.id))?.state).toBe("closed");
      finishRun();
      await running;
      await expect(h.harness.behavior.callRpc("run", input)).rejects.toThrow(
        "stopped or expired",
      );
    } finally {
      await h.harness.lifecycle.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["run", "preview"])(
    "rejects expired %s before the cleanup timer runs",
    async (method) => {
      vi.useFakeTimers();
      const h = await setup();
      try {
        const session = await openLocal(h);
        vi.setSystemTime(session.expiresAt);
        const operation = h.harness.behavior.callRpc(method, {
          ...ownedBy(session.id),
          ...(method === "run" ? { script: "1" } : {}),
        });
        if (method === "run")
          await expect(operation).rejects.toThrow("expired");
        else expect(await operation).toMatchObject({ frame: null });
        expect(hostCalls(h, method)).toHaveLength(0);
        expect((await listed(h, session.id))?.expiresAt).toBe(
          session.expiresAt,
        );
      } finally {
        await h.harness.lifecycle.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("rejects close when the host cannot release the browser and retries on the next close", async () => {
    const h = await setup();
    try {
      const flaky = await openLocal(h, "flaky-host");
      const other = await openLocal(h);
      h.worker.mockImplementation(async ({ method, hostId }) => {
        if (method === "close" && hostId === "flaky-host")
          throw new Error("profile directory busy");
        return null;
      });
      await expect(
        h.harness.behavior.callRpc("close", ownedBy(flaky.id)),
      ).rejects.toThrow("profile directory busy");
      expect((await listed(h, flaky.id))?.state).toBe("closed");
      expect((await listed(h, other.id))?.state).toBe("ready");
      await expect(
        h.harness.behavior.callRpc("run", {
          ...ownedBy(flaky.id),
          script: "1",
        }),
      ).rejects.toThrow("stopped or expired");
      await expect(
        h.harness.behavior.callRpc("stop", ownedBy(flaky.id)),
      ).rejects.toThrow("Browser session closed");
      h.worker.mockImplementation(async () => null);
      expect(
        await h.harness.behavior.callRpc("close", ownedBy(flaky.id)),
      ).toMatchObject({ state: "closed" });
      await h.harness.behavior.callRpc("close", ownedBy(flaky.id));
      expect(hostCalls(h, "close")).toHaveLength(3);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("shares one cleanup outcome across concurrent closes", async () => {
    const h = await setup();
    try {
      const session = await openLocal(h);
      let failHost!: () => void;
      h.worker.mockImplementation(async ({ method }) => {
        if (method === "close")
          await new Promise<void>(
            (_resolve, reject) =>
              (failHost = () => reject(new Error("browser still running"))),
          );
        return null;
      });
      const outcomes = Promise.allSettled([
        h.harness.behavior.callRpc("close", ownedBy(session.id)),
        h.harness.behavior.callRpc("close", ownedBy(session.id)),
      ]);
      await vi.waitFor(() => expect(hostCalls(h, "close")).toHaveLength(1));
      failHost();
      expect(
        (await outcomes).map((outcome) =>
          outcome.status === "rejected" ? String(outcome.reason) : "resolved",
        ),
      ).toEqual([
        expect.stringContaining("browser still running"),
        expect.stringContaining("browser still running"),
      ]);
      expect(hostCalls(h, "close")).toHaveLength(1);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("aborts a host startup that completes after close", async () => {
    const h = await setup();
    try {
      let finishStartup!: () => void;
      h.worker.mockImplementation(async ({ method }) => {
        if (method === "prepare") return ready;
        if (method === "open")
          await new Promise<void>((resolve) => (finishStartup = resolve));
        return null;
      });
      const opening = h.harness.behavior.callRpc("open", {
        threadId: "thread-test",
        hostId: "local-host",
      });
      const rejected = expect(opening).rejects.toThrow();
      await vi.waitFor(() => expect(hostCalls(h, "open")).toHaveLength(1));
      const [session] = rpcContract.list.output.parse(
        await h.harness.behavior.callRpc("list", { threadId: "thread-test" }),
      );
      expect(
        await h.harness.behavior.callRpc("close", ownedBy(session!.id)),
      ).toMatchObject({ state: "closed" });
      expect(hostCalls(h, "open")[0]![0].signal?.aborted).toBe(true);
      finishStartup();
      await rejected;
      expect((await listed(h, session!.id))?.state).toBe("closed");
      expect(hostCalls(h, "close")).toHaveLength(1);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("finishes cleanup that was pending when the plugin restarted", async () => {
    const h = await setup();
    let current = h;
    try {
      const session = await openLocal(h);
      h.worker.mockImplementation(async ({ method }) =>
        method === "close" ? new Promise<null>(() => {}) : null,
      );
      void h.harness.behavior
        .callRpc("close", ownedBy(session.id))
        .catch(() => {});
      await vi.waitFor(() => expect(hostCalls(h, "close")).toHaveLength(1));
      h.worker.mockImplementation(async () => null);
      current = { ...h, ...(await h.harness.lifecycle.reload(plugin)) };
      expect(hostCalls(h, "close")).toHaveLength(1);
      await current.harness.behavior.runService("restart-cleanup").done;
      expect(hostCalls(h, "close")).toHaveLength(2);
      expect(
        await current.harness.behavior.callRpc("close", ownedBy(session.id)),
      ).toMatchObject({ state: "closed" });
      expect(hostCalls(h, "close")).toHaveLength(2);
    } finally {
      await current.harness.lifecycle.dispose();
    }
  });
});
describe("server live preview", () => {
  const frame = {
    sequence: 7,
    mimeType: "image/jpeg" as const,
    data: Buffer.from("jpeg-bytes").toString("base64"),
    width: 1280,
    height: 720,
    url: "https://example.test/cart",
    title: "Cart",
    tabs: [{ id: "tab-1", url: "https://example.test/cart", title: "Cart" }],
    activeTabId: "tab-1",
  };
  const openLocal = (h: Awaited<ReturnType<typeof setup>>) => h.open();
  const owned = (sessionId: string) => ({
    threadId: "thread-test",
    sessionId,
  });
  const hostCalls = (h: Awaited<ReturnType<typeof setup>>, method: string) =>
    h.worker.mock.calls.filter(([call]) => call.method === method);
  async function listed(h: Awaited<ReturnType<typeof setup>>, id: string) {
    return rpcContract.list.output
      .parse(
        await h.harness.behavior.callRpc("list", { threadId: "thread-test" }),
      )
      .find((entry) => entry.id === id);
  }
  function inThreadEnvironment(
    h: Awaited<ReturnType<typeof setup>>,
    environmentId: string | null,
  ) {
    h.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: "thread-test", environmentId }),
    );
    h.harness.sdk.stub("environments.get", async () => ({
      hostId: "env-host",
    }));
  }
  it("forwards viewer input to the browser host and counts it and full-size viewing as activity", async () => {
    vi.useFakeTimers();
    const h = await setup();
    try {
      const local = await openLocal(h);
      h.worker.mockImplementation(async ({ method }) =>
        method === "preview" ? { frame } : null,
      );
      const actions = [
        { type: "text" as const, text: "hi" },
        { type: "reload" as const },
      ];
      vi.setSystemTime(local.createdAt + 20 * 60_000);
      expect(
        await h.harness.behavior.callRpc("input", {
          ...owned(local.id),
          actions,
        }),
      ).toBeNull();
      expect(hostCalls(h, "input")[0]?.[0]).toMatchObject({
        hostId: "local-host",
        input: { sessionId: local.id, actions },
      });
      expect((await listed(h, local.id))?.expiresAt).toBe(
        Date.now() + 30 * 60_000,
      );
      vi.setSystemTime(local.createdAt + 40 * 60_000);
      await h.harness.behavior.callRpc("preview", {
        ...owned(local.id),
        size: "full",
      });
      expect((await listed(h, local.id))?.expiresAt).toBe(
        Date.now() + 30 * 60_000,
      );
      await vi.advanceTimersByTimeAsync(29 * 60_000);
      expect((await listed(h, local.id))?.state).toBe("ready");
    } finally {
      await h.harness.lifecycle.dispose();
      vi.useRealTimers();
    }
  });
  it("refuses viewer input from another thread and after close", async () => {
    const h = await setup();
    try {
      const local = await openLocal(h);
      const actions = [{ type: "reload" as const }];
      await expect(
        h.harness.behavior.callRpc("input", {
          threadId: "other",
          sessionId: local.id,
          actions,
        }),
      ).rejects.toThrow();
      await h.harness.behavior.callRpc("close", owned(local.id));
      await expect(
        h.harness.behavior.callRpc("input", { ...owned(local.id), actions }),
      ).rejects.toThrow("not ready");
      expect(hostCalls(h, "input")).toHaveLength(0);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("opens one default-profile browser on the thread's environment host and reuses it", async () => {
    const h = await setup();
    try {
      inThreadEnvironment(h, "env-1");
      const [first, second] = await Promise.all([
        h.harness.behavior.callRpc("openForThread", {
          threadId: "thread-test",
        }),
        h.harness.behavior.callRpc("openForThread", {
          threadId: "thread-test",
        }),
      ]);
      expect(second).toEqual(first);
      expect(first).toMatchObject({
        hostId: "env-host",
        profile: "default",
        state: "ready",
      });
      expect(hostCalls(h, "open")).toHaveLength(1);
      expect(hostCalls(h, "open")[0]?.[0]).toMatchObject({
        hostId: "env-host",
        input: { profile: "default" },
      });
      expect(h.harness.sdk.callsTo("environments.get")).toEqual([
        [expect.objectContaining({ environmentId: "env-1" })],
      ]);
      const session = rpcContract.openForThread.output.parse(first);
      expect(
        await h.harness.behavior.callRpc("openForThread", {
          threadId: "thread-test",
        }),
      ).toEqual(session);
      await h.harness.behavior.callRpc("close", owned(session.id));
      const reopened = rpcContract.openForThread.output.parse(
        await h.harness.behavior.callRpc("openForThread", {
          threadId: "thread-test",
        }),
      );
      expect(reopened.id).not.toBe(session.id);
      expect(hostCalls(h, "open")).toHaveLength(2);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("reuses a local session the agent already opened instead of starting another", async () => {
    const h = await setup();
    try {
      inThreadEnvironment(h, "env-1");
      const agent = await openLocal(h);
      expect(
        await h.harness.behavior.callRpc("openForThread", {
          threadId: "thread-test",
        }),
      ).toEqual(agent);
      expect(hostCalls(h, "open")).toHaveLength(1);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("explains that a thread without an environment needs the CLI", async () => {
    const h = await setup();
    try {
      inThreadEnvironment(h, null);
      await expect(
        h.harness.behavior.callRpc("openForThread", {
          threadId: "thread-test",
        }),
      ).rejects.toThrow("no environment host");
      inThreadEnvironment(h, "env-1");
      await expect(
        h.harness.behavior.callRpc("openForThread", {
          threadId: "thread-test",
        }),
      ).resolves.toMatchObject({ state: "ready" });
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("opens the default profile on the thread's environment host when no machine is given", async () => {
    const h = await setup();
    try {
      const result = await h.harness.behavior.runCli(["open", "--json"], {
        threadId: "thread-test",
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const opened = JSON.parse(result.stdout);
      expect(opened).toMatchObject({
        hostId: "env-host",
        profile: "default",
        previewDirective: `::browser-preview{session="${opened.id}"}`,
      });
      expect(hostCalls(h, "open")).toEqual([
        [
          expect.objectContaining({
            hostId: "env-host",
            input: expect.objectContaining({ profile: "default" }),
          }),
        ],
      ]);
      expect(h.harness.sdk.callsTo("hosts.list")).toEqual([]);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("records the chosen profile and opens temporary sessions without one", async () => {
    const h = await setup();
    try {
      const profiled = await h.harness.behavior.runCli(
        ["open", "--machine", "local-host", "--profile", "work", "--json"],
        { threadId: "thread-test" },
      );
      expect(JSON.parse(profiled.stdout)).toMatchObject({ profile: "work" });
      const temporary = await h.harness.behavior.runCli(
        ["open", "--temporary", "--json"],
        { threadId: "thread-test" },
      );
      expect(JSON.parse(temporary.stdout)).toMatchObject({ profile: null });
      expect(hostCalls(h, "open")).toEqual([
        [
          expect.objectContaining({
            input: expect.objectContaining({ profile: "work" }),
          }),
        ],
        [
          expect.objectContaining({
            input: expect.not.objectContaining({ profile: expect.anything() }),
          }),
        ],
      ]);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("drops stored desktop sessions at startup and keeps listing stored local ones", async () => {
    const h = await setup();
    let current = h;
    try {
      const createdAt = Date.now();
      const legacy = (id: string, extra: Record<string, unknown>) => ({
        id,
        threadId: "thread-test",
        hostId: "local-host",
        state: "closed",
        createdAt,
        expiresAt: createdAt + 30 * 60_000,
        ...extra,
      });
      const desktopId = "0b7d9a4e-2f1c-4c3a-9e8d-7f6a5b4c3d2e";
      const localId = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
      const profilelessId = "3c2b1a09-8f7e-4d6c-9b5a-4e3d2c1b0a9f";
      const stored = {
        [desktopId]: {
          session: legacy(desktopId, {
            backend: "desktop",
            profile: null,
            state: "ready",
          }),
          desktop: { leaseId: "lease", tabId: "tab" },
          lastUsed: createdAt,
          cleanupPending: true,
        },
        [localId]: {
          session: legacy(localId, { backend: "local", profile: "default" }),
          desktop: null,
          lastUsed: createdAt,
          cleanupPending: false,
        },
        [profilelessId]: {
          session: legacy(profilelessId, { backend: "local" }),
          desktop: null,
          lastUsed: createdAt,
          cleanupPending: false,
        },
      };
      for (const [id, record] of Object.entries(stored))
        await h.bb.storage.kv.set(`sessions/thread-test/${id}`, record);
      current = { ...h, ...(await h.harness.lifecycle.reload(plugin)) };
      await current.harness.behavior.runService("restart-cleanup").done;
      const sessions = rpcContract.list.output.parse(
        await current.harness.behavior.callRpc("list", {
          threadId: "thread-test",
        }),
      );
      expect(sessions.map((entry) => [entry.id, entry.profile]).sort()).toEqual(
        [
          [localId, "default"],
          [profilelessId, null],
        ].sort(),
      );
      expect(
        await current.bb.storage.kv.get(`sessions/thread-test/${desktopId}`),
      ).toBeUndefined();
      expect(
        await current.bb.storage.kv.get(`sessions/thread-test/${localId}`),
      ).toEqual({
        session: legacy(localId, { profile: "default" }),
        lastUsed: createdAt,
        cleanupPending: false,
      });
      expect(hostCalls(h, "close")).toEqual([]);
    } finally {
      await current.harness.lifecycle.dispose();
    }
  });
  it("long-polls the browser host for frames of ready sessions", async () => {
    const h = await setup();
    try {
      const local = await openLocal(h);
      h.worker.mockImplementation(async ({ method }) =>
        method === "preview" ? { frame } : null,
      );
      expect(
        await h.harness.behavior.callRpc("preview", {
          threadId: "thread-test",
          sessionId: local.id,
          afterSequence: 6,
          size: "full",
        }),
      ).toEqual({
        session: { ...local, expiresAt: expect.any(Number) },
        frame,
      });
      expect(h.worker).toHaveBeenCalledWith(
        expect.objectContaining({
          hostId: "local-host",
          method: "preview",
          input: {
            sessionId: local.id,
            afterSequence: 6,
            waitMs: 5_000,
            size: "full",
          },
        }),
      );
      await expect(
        h.harness.behavior.callRpc("preview", {
          threadId: "other",
          sessionId: local.id,
        }),
      ).rejects.toThrow();
      await h.harness.behavior.callRpc("close", {
        threadId: "thread-test",
        sessionId: local.id,
      });
      expect(
        await h.harness.behavior.callRpc("preview", {
          threadId: "thread-test",
          sessionId: local.id,
        }),
      ).toMatchObject({ session: { state: "closed" }, frame: null });
      expect(
        h.worker.mock.calls.filter(([call]) => call.method === "preview"),
      ).toHaveLength(1);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("points agents at the shared remote browser and its preview directive", async () => {
    const h = await setup();
    try {
      const agent = await h.harness.behavior.resolveAgentConfiguration(
        makePluginAgentConfigurationContext(),
      );
      expect(agent.skills).toEqual(["browser-automation"]);
      expect(agent.instructions).toMatch(/previewDirective.*exactly once/);
      expect(agent.instructions).toContain(
        "`bb browser-automation open --json`",
      );
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("describes the live frame through the CLI without image bytes", async () => {
    const h = await setup();
    try {
      const local = await openLocal(h);
      h.worker.mockImplementation(async ({ method }) =>
        method === "preview" ? { frame } : null,
      );
      const result = await h.harness.behavior.runCli(
        ["preview", local.id, "--after", "6", "--json"],
        { threadId: "thread-test" },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain(frame.data);
      expect(JSON.parse(result.stdout)).toEqual({
        session: local,
        frame: {
          sequence: 7,
          mimeType: "image/jpeg",
          width: 1280,
          height: 720,
          url: frame.url,
          title: "Cart",
          activeTabId: "tab-1",
          tabs: frame.tabs,
          bytes: 10,
        },
      });
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
});
