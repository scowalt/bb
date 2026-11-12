import type {
  BbPluginApi,
  MessageDispatchHookContext,
  PluginDispatchAttemptKind,
} from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeHostResponse,
  makeMessageDispatchHookContext,
  makeQueueEntry,
  makeThreadResponse,
  type ExperimentalFakeHostRpcCall,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostLoad } from "./contract.js";
import plugin from "./server.js";

type RunningThread = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["listRunning"]>
>[number];
type HostResponse = ReturnType<typeof makeHostResponse>;
type SdkSubscription = Parameters<BbPluginApi["sdk"]["subscribe"]>[0];
type HostChangedSubscription = Extract<
  SdkSubscription,
  { event: "host:changed" }
>;

function isHostChangedSubscription(
  subscription: SdkSubscription,
): subscription is HostChangedSubscription {
  return subscription.event === "host:changed";
}

const PLUGIN_ID = "concurrency-limit";
const GIBIBYTE = 2 ** 30;

function hostLoad(overrides: Partial<HostLoad> = {}): HostLoad {
  return {
    memoryTotalBytes: 92 * GIBIBYTE,
    memoryAvailableBytes: 70 * GIBIBYTE,
    cpuPressure: { avg10: 8.09, avg60: 13.49 },
    memoryPressure: { avg10: 0, avg60: 0 },
    ...overrides,
  };
}
function hostRecord(
  id: string,
  status: "connected" | "disconnected" = "connected",
  name = id,
): HostResponse {
  return makeHostResponse({ id, name, status });
}

function running(overrides: Partial<RunningThread> = {}): RunningThread {
  return { id: "thr_running", hostId: "host-a", ...overrides };
}

function hangUntilTimeout(call: ExperimentalFakeHostRpcCall): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(new Error("Host plugin call timed out"));
    setTimeout(fail, call.timeoutMs ?? 30_000);
    call.signal?.addEventListener("abort", fail, { once: true });
  });
}

interface GateContextOverrides {
  hostId?: string | null;
  hostName?: string;
  thread?: Partial<MessageDispatchHookContext["thread"]>;
  attempt?: PluginDispatchAttemptKind;
}

function dispatchContext(overrides: GateContextOverrides = {}) {
  const hostId = overrides.hostId === undefined ? "host-a" : overrides.hostId;
  return makeMessageDispatchHookContext({
    thread: {
      id: "thr_1",
      status: "pending",
      ...overrides.thread,
    },
    attempt: overrides.attempt ?? "start-turn",
    host:
      hostId === null
        ? null
        : { id: hostId, name: overrides.hostName ?? hostId },
  });
}

interface SetupOptions {
  configuration?: {
    globalLimit: number | null;
    hostOverrides: Array<{ hostId: string; limit: number }>;
  };
  capacities?: Array<{ hostId: string; availableParallelism: number }>;
  hosts?: HostResponse[] | (() => HostResponse[]);
  running?: RunningThread[];
  detectedParallelism?: number;
  detectedLoad?: HostLoad | null | (() => HostLoad | null);
  callHostRpc?: (call: ExperimentalFakeHostRpcCall) => unknown;
  subscribe?: BbPluginApi["sdk"]["subscribe"];
}

async function setup(options: SetupOptions = {}) {
  const subscribe: BbPluginApi["sdk"]["subscribe"] = () => () => {};
  const fake = createFakePluginHost({
    pluginId: PLUGIN_ID,
    sdk: {
      subscribe: options.subscribe ?? subscribe,
      hosts: {
        list: async () =>
          typeof options.hosts === "function"
            ? options.hosts()
            : (options.hosts ?? []),
      },
      threads: { listRunning: async () => options.running ?? [] },
    },
    experimental_callHostRpc:
      options.callHostRpc ??
      (() => ({
        availableParallelism: options.detectedParallelism ?? 8,
        load:
          typeof options.detectedLoad === "function"
            ? options.detectedLoad()
            : (options.detectedLoad ?? null),
      })),
  });
  if (options.configuration !== undefined) {
    await fake.bb.storage.kv.set("configuration", options.configuration);
  }
  if (options.capacities !== undefined) {
    await fake.bb.storage.kv.set("host-capacities", options.capacities);
  }
  await plugin(fake.bb);
  const hook = fake.harness.registrations.hooks["message.dispatch"];
  if (hook === null) throw new Error("message.dispatch was not registered");
  return { ...fake, hook };
}

function hostChanges(): {
  emitHostChanges(
    hostId: string,
    changes: Parameters<HostChangedSubscription["callback"]>[0]["changes"],
  ): void;
  subscribe: BbPluginApi["sdk"]["subscribe"];
} {
  let callback: HostChangedSubscription["callback"] | null = null;
  return {
    emitHostChanges(hostId, changes) {
      callback?.({
        type: "changed",
        entity: "host",
        id: hostId,
        changes,
      });
    },
    subscribe(subscription) {
      if (isHostChangedSubscription(subscription)) {
        callback = subscription.callback;
      }
      return () => {
        if (isHostChangedSubscription(subscription)) callback = null;
      };
    },
  };
}

describe("configuration", () => {
  it("uses a custom settings section rather than generic setting descriptors", async () => {
    const { harness } = await setup();

    expect(harness.registrations.settingsDescriptors).toEqual({});
  });

  it("returns each host's detected automatic limit and retained offline capacity", async () => {
    const { harness } = await setup({
      hosts: [
        hostRecord("host-a", "connected", "Laptop"),
        hostRecord("host-b", "disconnected", "Studio"),
      ],
      capacities: [
        { hostId: "host-a", availableParallelism: 8 },
        { hostId: "host-b", availableParallelism: 16 },
      ],
    });

    await expect(harness.behavior.callRpc("getConfiguration")).resolves.toEqual(
      {
        globalLimit: null,
        hostOverrides: [],
        hosts: [
          {
            id: "host-a",
            name: "Laptop",
            status: "connected",
            availableParallelism: 8,
            automaticLimit: 8,
            effectiveLimit: 8,
            override: null,
            headroom: null,
          },
          {
            id: "host-b",
            name: "Studio",
            status: "disconnected",
            availableParallelism: 16,
            automaticLimit: 16,
            effectiveLimit: 16,
            override: null,
            headroom: null,
          },
        ],
      },
    );
  });

  it("rejects invalid and duplicate limits at the RPC boundary", async () => {
    const { harness } = await setup();

    await expect(
      harness.behavior.callRpc("setConfiguration", {
        globalLimit: 1.5,
        hostOverrides: [],
      }),
    ).rejects.toThrow();
    await expect(
      harness.behavior.callRpc("setConfiguration", {
        globalLimit: null,
        hostOverrides: [
          { hostId: "host-a", limit: 1 },
          { hostId: "host-a", limit: 2 },
        ],
      }),
    ).rejects.toThrow(/rpc input validation failed/u);
  });

  it("persists validated configuration and rechecks waiting dispatches", async () => {
    const { bb, harness } = await setup({ hosts: [hostRecord("host-a")] });

    await harness.behavior.callRpc("setConfiguration", {
      globalLimit: 3,
      hostOverrides: [{ hostId: "host-a", limit: 0 }],
    });

    await expect(bb.storage.kv.get("configuration")).resolves.toEqual({
      globalLimit: 3,
      hostOverrides: [{ hostId: "host-a", limit: 0 }],
    });
    expect(harness.recheckCount).toBe(1);
  });

  it("detects connected host capacity in the background", async () => {
    const { bb, harness } = await setup({
      hosts: [hostRecord("host-a")],
      detectedParallelism: 12,
    });
    const service = harness.behavior.runService("capacity-detector");

    await vi.waitFor(() => {
      expect(harness.experimental_hostRpcCalls).toHaveLength(1);
    });
    await expect(bb.storage.kv.get("host-capacities")).resolves.toEqual([
      { hostId: "host-a", availableParallelism: 12 },
    ]);
    await expect(
      harness.behavior.callRpc("getConfiguration"),
    ).resolves.toMatchObject({
      hosts: [
        {
          id: "host-a",
          availableParallelism: 12,
          automaticLimit: 12,
          effectiveLimit: 12,
        },
      ],
    });

    service.controller.abort();
    await service.done;
  });

  it("detects a host when it connects after startup", async () => {
    const changes = hostChanges();
    let status: HostResponse["status"] = "disconnected";
    const { harness } = await setup({
      hosts: () => [hostRecord("host-a", status)],
      subscribe: changes.subscribe,
    });
    const service = harness.behavior.runService("capacity-detector");
    await vi.waitFor(() => {
      expect(harness.inspection.sdk.callsTo("hosts.list")).toHaveLength(1);
    });
    expect(harness.experimental_hostRpcCalls).toHaveLength(0);

    status = "connected";
    changes.emitHostChanges("host-a", ["host-connected"]);
    await vi.waitFor(() => {
      expect(harness.experimental_hostRpcCalls).toHaveLength(1);
    });

    service.controller.abort();
    await service.done;
  });

  it("ignores host messages that only report a provider model catalog change", async () => {
    const changes = hostChanges();
    const { harness } = await setup({
      hosts: [hostRecord("host-a")],
      subscribe: changes.subscribe,
    });
    const service = harness.behavior.runService("capacity-detector");
    await vi.waitFor(() => {
      expect(harness.experimental_hostRpcCalls).toHaveLength(1);
      expect(harness.realtimeSignals).toHaveLength(1);
    });
    const hostListCalls = harness.inspection.sdk.callsTo("hosts.list").length;

    changes.emitHostChanges("host-a", ["provider-model-catalog-changed"]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.realtimeSignals).toHaveLength(1);
    expect(harness.experimental_hostRpcCalls).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("hosts.list")).toHaveLength(
      hostListCalls,
    );

    changes.emitHostChanges("host-a", ["host-disconnected"]);
    expect(harness.realtimeSignals).toHaveLength(2);

    service.controller.abort();
    await service.done;
  });

  it("provides CLI parity for global and host overrides", async () => {
    const { harness } = await setup({
      hosts: [hostRecord("host-a", "connected", "Laptop")],
      capacities: [{ hostId: "host-a", availableParallelism: 8 }],
    });

    await expect(
      harness.behavior.runCli(["global", "3"]),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "3",
    });
    await expect(
      harness.behavior.runCli(["host", "host-a", "0"]),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "Laptop: 0 (8 processors, connected)",
    });
    await expect(
      harness.behavior.runCli(["host", "host-a", "auto"]),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "Laptop: auto, 8 (8 processors, connected)",
    });
    await expect(
      harness.behavior.runCli(["global", "1.5"]),
    ).resolves.toMatchObject({ exitCode: 1 });
  });

  it("documents the limit range in help and reports errors as JSON", async () => {
    const { harness } = await setup({
      hosts: [hostRecord("host-a", "connected", "Laptop")],
      capacities: [{ hostId: "host-a", availableParallelism: 8 }],
    });

    const help = (await harness.behavior.runCli(["host", "--help"])).stdout;
    expect(help).toContain("bb concurrency-limit host");
    expect(help).toContain("0 to 10000");

    const envelope = await harness.behavior.runCli([
      "host",
      "host-b",
      "--json",
    ]);
    expect(envelope.exitCode).toBe(1);
    expect(JSON.parse(envelope.stdout)).toEqual({
      ok: false,
      error: {
        code: "unknown_host",
        message: "Unknown host: host-b",
        hint: "Run `bb machine list` for the enrolled host ids.",
      },
    });
    expect(envelope.stderr).toContain("Unknown host: host-b");

    const badLimit = await harness.behavior.runCli(["host", "host-a", "many"]);
    expect(badLimit.exitCode).toBe(1);
    expect(badLimit.stderr).toContain(
      "Limit must be auto or a whole number from 0 to 10000",
    );
  });
});

describe("message.dispatch", () => {
  it("uses a conservative limit of one until a host is detected", async () => {
    const { hook } = await setup({ running: [running()] });

    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason: "1 of 1 running on host host-a",
    });
  });

  it("uses each host's detected automatic limit", async () => {
    const { hook } = await setup({
      capacities: [{ hostId: "host-a", availableParallelism: 8 }],
      running: [
        running({ id: "a" }),
        running({ id: "b" }),
        running({ id: "c" }),
        running({ id: "d" }),
        running({ id: "e" }),
        running({ id: "f" }),
        running({ id: "g" }),
        running({ id: "h" }),
      ],
    });

    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason: "8 of 8 running on host host-a",
    });
  });

  it("keeps host pools separate and honors explicit overrides", async () => {
    const { hook } = await setup({
      configuration: {
        globalLimit: null,
        hostOverrides: [{ hostId: "host-a", limit: 1 }],
      },
      running: [running({ hostId: "host-a" })],
    });

    await expect(hook(dispatchContext({ hostId: "host-a" }))).resolves.toEqual({
      action: "wait",
      reason: "1 of 1 running on host host-a",
    });
    await expect(hook(dispatchContext({ hostId: "host-b" }))).resolves.toEqual({
      action: "proceed",
    });
  });

  it("applies the overall limit before a host limit", async () => {
    const { hook } = await setup({
      configuration: { globalLimit: 1, hostOverrides: [] },
      running: [running()],
    });

    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason: "1 of 1 running on all hosts",
    });
  });

  it("treats zero as a pause rather than as unlimited", async () => {
    const global = await setup({
      configuration: { globalLimit: 0, hostOverrides: [] },
    });
    await expect(
      global.hook(dispatchContext({ hostId: null })),
    ).resolves.toEqual({
      action: "wait",
      reason: "0 of 0 running on all hosts",
    });

    const host = await setup({
      configuration: {
        globalLimit: null,
        hostOverrides: [{ hostId: "host-a", limit: 0 }],
      },
    });
    await expect(host.hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason: "0 of 0 running on host host-a",
    });
  });

  it("skips host enforcement when no host has been selected", async () => {
    const { harness, hook } = await setup({ running: [running()] });

    await expect(hook(dispatchContext({ hostId: null }))).resolves.toEqual({
      action: "proceed",
    });
    expect(harness.inspection.sdk.callsTo("threads.listRunning")).toHaveLength(
      0,
    );
  });

  it("does not re-admit running threads or join-turn attempts", async () => {
    const { hook } = await setup({
      configuration: { globalLimit: 0, hostOverrides: [] },
    });

    await expect(
      hook(dispatchContext({ thread: { status: "active" } })),
    ).resolves.toEqual({ action: "proceed" });
    await expect(
      hook(
        dispatchContext({
          attempt: "join-turn",
          thread: { status: "idle" },
        }),
      ),
    ).resolves.toEqual({ action: "proceed" });
  });
});

describe("headroom", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function sampledSetup(options: SetupOptions) {
    const context = await setup({
      hosts: [hostRecord("host-a")],
      detectedParallelism: 2,
      ...options,
    });
    const service = context.harness.behavior.runService("capacity-detector");
    await vi.waitFor(() => {
      expect(context.harness.experimental_hostRpcCalls.length).toBeGreaterThan(
        0,
      );
    });
    return { ...context, service };
  }

  async function stopService(service: {
    controller: AbortController;
    done: Promise<void>;
  }) {
    service.controller.abort();
    await service.done;
  }

  it("admits a turn while the host has headroom, even past one thread per processor", async () => {
    const { hook, service } = await sampledSetup({
      detectedLoad: hostLoad(),
      running: [
        running({ id: "a" }),
        running({ id: "b" }),
        running({ id: "c" }),
      ],
    });

    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "proceed",
    });
    await stopService(service);
  });

  it.each([
    [
      "CPU pressure",
      hostLoad({ cpuPressure: { avg10: 70, avg60: 63.2 } }),
      "CPU pressure 63% (limit 50%) on host host-a",
    ],
    [
      "memory pressure",
      hostLoad({ memoryPressure: { avg10: 14.4, avg60: 3 } }),
      "Memory pressure 14% (limit 10%) on host host-a",
    ],
    [
      "low free memory",
      hostLoad({ memoryAvailableBytes: Math.round(8.2 * GIBIBYTE) }),
      "8.2 GB free, 9.2 GB kept in reserve on host host-a",
    ],
  ])("holds a turn on %s", async (_signal, load, reason) => {
    const { hook, service } = await sampledSetup({ detectedLoad: load });

    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason,
    });
    await stopService(service);
  });

  it("charges each admitted turn against free memory until the window passes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
    const { hook, service } = await sampledSetup({
      detectedLoad: hostLoad({
        memoryAvailableBytes: Math.round(12.2 * GIBIBYTE),
      }),
    });

    for (const id of ["thr_1", "thr_2", "thr_3"]) {
      await expect(hook(dispatchContext({ thread: { id } }))).resolves.toEqual({
        action: "proceed",
      });
    }
    await expect(
      hook(dispatchContext({ thread: { id: "thr_4" } })),
    ).resolves.toEqual({
      action: "wait",
      reason:
        "12.2 GB free, 9.2 GB kept in reserve, 3 threads just started on host host-a",
    });

    await vi.advanceTimersByTimeAsync(31_000);
    await expect(
      hook(dispatchContext({ thread: { id: "thr_4" } })),
    ).resolves.toEqual({
      action: "proceed",
    });
    await stopService(service);
  });

  it("charges a thread once however many passes admit it, and not at all once another plugin holds it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
    const { harness, hook, service } = await sampledSetup({
      detectedLoad: hostLoad({
        memoryAvailableBytes: Math.round(12.2 * GIBIBYTE),
      }),
    });
    const held = {
      action: "wait",
      reason:
        "12.2 GB free, 9.2 GB kept in reserve, 3 threads just started on host host-a",
    };

    for (const id of [
      "thr_draft",
      "thr_draft",
      "thr_draft",
      "thr_2",
      "thr_3",
    ]) {
      await expect(hook(dispatchContext({ thread: { id } }))).resolves.toEqual({
        action: "proceed",
      });
    }
    await expect(
      hook(dispatchContext({ thread: { id: "thr_4" } })),
    ).resolves.toEqual(held);

    await harness.behavior.emitThreadEvent("message.queued", {
      entry: makeQueueEntry({
        threadId: "thr_draft",
        waitingOn: { kind: "plugin", pluginId: "drafts", reason: "Draft" },
      }),
    });
    await expect(
      hook(dispatchContext({ thread: { id: "thr_4" } })),
    ).resolves.toEqual({ action: "proceed" });

    await harness.behavior.emitThreadEvent("message.queued", {
      entry: makeQueueEntry({
        threadId: "thr_2",
        waitingOn: { kind: "thread-busy" },
      }),
    });
    await expect(
      hook(dispatchContext({ thread: { id: "thr_5" } })),
    ).resolves.toEqual(held);
    await stopService(service);
  });

  it("falls back to one thread per processor when the sample is stale", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
    const { hook, service } = await sampledSetup({
      detectedLoad: hostLoad(),
      running: [running({ id: "a" }), running({ id: "b" })],
    });
    await stopService(service);

    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "proceed",
    });
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason: "2 of 2 running on host host-a",
    });
  });

  it("falls back to one thread per processor when the host reports no load", async () => {
    const { hook, service } = await sampledSetup({
      detectedLoad: null,
      running: [running({ id: "a" }), running({ id: "b" })],
    });

    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason: "2 of 2 running on host host-a",
    });
    await stopService(service);
  });

  it("lets a host override win over headroom", async () => {
    const { hook, service } = await sampledSetup({
      configuration: {
        globalLimit: null,
        hostOverrides: [{ hostId: "host-a", limit: 1 }],
      },
      detectedLoad: hostLoad(),
      running: [running({ id: "a" })],
    });

    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason: "1 of 1 running on host host-a",
    });
    await stopService(service);
  });

  it("rechecks held turns when a later sample shows headroom and stays quiet otherwise", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
    let load = hostLoad({ cpuPressure: { avg10: 90, avg60: 80 } });
    const { harness, hook, service } = await sampledSetup({
      detectedLoad: () => load,
    });
    const rechecksAfterSampling = harness.recheckCount;
    const signalsAfterSampling = harness.realtimeSignals.length;

    await expect(hook(dispatchContext())).resolves.toMatchObject({
      action: "wait",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.experimental_hostRpcCalls).toHaveLength(2);
    expect(harness.recheckCount).toBe(rechecksAfterSampling);

    load = hostLoad();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.experimental_hostRpcCalls).toHaveLength(3);
    expect(harness.recheckCount).toBe(rechecksAfterSampling + 1);
    expect(harness.realtimeSignals).toHaveLength(signalsAfterSampling);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.recheckCount).toBe(rechecksAfterSampling + 1);
    await stopService(service);
  });

  it("rechecks turns held at one per processor once a fresh sample returns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
    let sampling = true;
    const { harness, hook, service } = await sampledSetup({
      detectedLoad: () => {
        if (!sampling) throw new Error("Host plugin call timed out");
        return hostLoad();
      },
      running: [running({ id: "a" }), running({ id: "b" })],
    });

    sampling = false;
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason: "2 of 2 running on host host-a",
    });
    const rechecksWhileStale = harness.recheckCount;

    sampling = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.recheckCount).toBe(rechecksWhileStale + 1);
    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "proceed",
    });
    await stopService(service);
  });

  it("keeps a healthy host's sample fresh while another host's worker hangs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
    const { hook, service } = await sampledSetup({
      hosts: [hostRecord("host-a"), hostRecord("host-b")],
      callHostRpc: (call) =>
        call.hostId === "host-b"
          ? hangUntilTimeout(call)
          : { availableParallelism: 2, load: hostLoad() },
      running: [running({ id: "a" }), running({ id: "b" })],
    });

    for (let elapsed = 0; elapsed < 120_000; elapsed += 5_000) {
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(hook(dispatchContext())).resolves.toEqual({
        action: "proceed",
      });
    }
    await stopService(service);
  });

  it("does not poll a host that reports no load", async () => {
    vi.useFakeTimers();
    const { harness, service } = await sampledSetup({ detectedLoad: null });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.experimental_hostRpcCalls).toHaveLength(1);
    await stopService(service);
  });

  it("shows the headroom verdict in the configuration view and the CLI", async () => {
    const { harness, service } = await sampledSetup({
      hosts: [hostRecord("host-a", "connected", "Beelink")],
      detectedParallelism: 20,
      detectedLoad: hostLoad(),
    });

    await expect(
      harness.behavior.callRpc("getConfiguration"),
    ).resolves.toMatchObject({
      hosts: [
        {
          id: "host-a",
          availableParallelism: 20,
          automaticLimit: 20,
          effectiveLimit: null,
          override: null,
          headroom: {
            memoryAvailableBytes: 70 * GIBIBYTE,
            memoryReserveBytes: Math.round(9.2 * GIBIBYTE),
            cpuPressure: 13.49,
            memoryPressure: 0,
            admitting: true,
            reason: null,
          },
        },
      ],
    });
    const status = await harness.behavior.runCli(["status"]);
    expect(status.stdout.split("\n")).toEqual([
      "Overall: unlimited",
      "Automatic host limit: starts threads while the host has free memory and low CPU and memory pressure; hosts that do not report pressure allow one thread per processor",
      "Beelink: auto, by headroom: admitting (20 processors, 70.0 GB free, 9.2 GB reserve, CPU pressure 13%, memory pressure 0%, connected)",
    ]);
    await stopService(service);
  });
});

describe("capacity wake events", () => {
  it("rechecks queued work when a running thread stops occupying capacity", async () => {
    const { harness } = await setup();
    const thread = makeThreadResponse({ id: "thr_freed", status: "idle" });

    await harness.behavior.emitThreadEvent("thread.idle", {
      thread,
      lastAssistantText: null,
    });
    await harness.behavior.emitThreadEvent("thread.failed", {
      thread,
      error: null,
    });
    await harness.behavior.emitThreadEvent("thread.archived", { thread });
    await harness.behavior.emitThreadEvent("thread.deleted", { thread });

    expect(harness.recheckCount).toBe(4);
  });
});
