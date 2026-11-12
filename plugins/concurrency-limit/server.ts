import {
  defineRpcContract,
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
  type MessageDispatchHookDecision,
  type PluginThreadEventName,
  type PluginThreadEventPayloads,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { concurrencyLimitHostContract } from "./contract.js";
import {
  automaticHostLimit,
  formatGigabytes,
  HEADROOM_POLICY,
  headroomVerdict,
  MAX_LIMIT_VALUE,
  memoryReserveBytes,
  parseLimitValue,
  resolveHostPolicy,
  type HostCapacity,
  type HostLoadSample,
  type HostPolicy,
  type LimitConfiguration,
} from "./limits.js";

const CONFIGURATION_KEY = "configuration";
const CAPACITIES_KEY = "host-capacities";
const CONFIGURATION_CHANGED_CHANNEL = "configuration-changed";
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const LOAD_POLL_MS = 5_000;
const CAPACITY_CALL_TIMEOUT_MS = 10_000;
export const MAX_REASON_LENGTH = 200;

const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

const limitSchema = z.number().int().min(0).max(MAX_LIMIT_VALUE);
const hostOverrideSchema = z
  .object({
    hostId: z.string().min(1).max(256),
    limit: limitSchema,
  })
  .strict();
const configurationShape = {
  globalLimit: limitSchema.nullable(),
  hostOverrides: z.array(hostOverrideSchema).max(256),
};
const configurationSchema = z
  .object(configurationShape)
  .strict()
  .superRefine((configuration, context) => {
    const seen = new Set<string>();
    for (const override of configuration.hostOverrides) {
      if (seen.has(override.hostId)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate host override for ${override.hostId}`,
          path: ["hostOverrides"],
        });
      }
      seen.add(override.hostId);
    }
  });
const capacityRecordSchema = z
  .object({
    hostId: z.string().min(1).max(256),
    availableParallelism: z.number().int().positive(),
  })
  .strict();
const capacityRecordsSchema = z.array(capacityRecordSchema).max(256);
const percentSchema = z.number().min(0).max(100);
const headroomViewSchema = z
  .object({
    memoryAvailableBytes: z.number().int().nonnegative(),
    memoryReserveBytes: z.number().int().positive(),
    cpuPressure: percentSchema,
    memoryPressure: percentSchema,
    admitting: z.boolean(),
    reason: z.string().nullable(),
  })
  .strict();
const hostViewSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    status: z.enum(["connected", "disconnected"]),
    availableParallelism: z.number().int().positive().nullable(),
    automaticLimit: limitSchema,
    effectiveLimit: limitSchema.nullable(),
    override: limitSchema.nullable(),
    headroom: headroomViewSchema.nullable(),
  })
  .strict();
const hostConfigurationSchema = z
  .object({
    ...configurationShape,
    hosts: z.array(hostViewSchema),
  })
  .strict();

export const concurrencyLimitRpcContract = defineRpcContract({
  getConfiguration: {
    input: z.null(),
    output: hostConfigurationSchema,
  },
  setConfiguration: {
    input: configurationSchema,
    output: hostConfigurationSchema,
  },
});

type Configuration = z.infer<typeof configurationSchema>;
type CapacityRecord = z.infer<typeof capacityRecordSchema>;
type HostView = z.infer<typeof hostViewSchema>;
type HeadroomView = z.infer<typeof headroomViewSchema>;
type RefreshOutcome = "settled" | "retry";
type WakeReason = "requested" | "retry" | "poll" | "aborted";
interface Admission {
  readonly hostId: string;
  readonly admittedAt: number;
}
type QueuedWait =
  PluginThreadEventPayloads["message.queued"]["entry"]["waitingOn"];

const DEFAULT_CONFIGURATION: Configuration = {
  globalLimit: null,
  hostOverrides: [],
};

const CAPACITY_FREED_EVENTS = [
  "thread.idle",
  "thread.failed",
  "thread.archived",
  "thread.deleted",
] as const satisfies readonly PluginThreadEventName[];

function normalizeConfiguration(
  configuration: LimitConfiguration,
): Configuration {
  return {
    globalLimit: configuration.globalLimit,
    hostOverrides: [...configuration.hostOverrides].sort((left, right) =>
      left.hostId.localeCompare(right.hostId),
    ),
  };
}

function fullDecision(
  limit: number,
  scopeLabel: string,
): MessageDispatchHookDecision {
  return waitDecision(`${limit} of ${limit} running on ${scopeLabel}`);
}

function waitDecision(reason: string): MessageDispatchHookDecision {
  return {
    action: "wait",
    reason:
      reason.length <= MAX_REASON_LENGTH
        ? reason
        : `${reason.slice(0, MAX_REASON_LENGTH - 1)}…`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function turnKeptRunning(waitingOn: QueuedWait): boolean {
  return (
    waitingOn === null ||
    waitingOn.kind === "thread-busy" ||
    waitingOn.kind === "turn-starting"
  );
}

function parseLimitArgument(
  raw: string,
  automaticKeyword: "auto" | "unlimited",
): number | null {
  if (raw === automaticKeyword) return null;
  const value = parseLimitValue(raw);
  if (value === null) {
    throw new PluginCliError(
      `Limit must be ${automaticKeyword} or a whole number from 0 to ${MAX_LIMIT_VALUE}`,
      { code: "invalid_limit" },
    );
  }
  return value;
}

function setHostOverride(
  configuration: Configuration,
  hostId: string,
  limit: number | null,
): Configuration {
  const hostOverrides = configuration.hostOverrides.filter(
    (override) => override.hostId !== hostId,
  );
  if (limit !== null) hostOverrides.push({ hostId, limit });
  return normalizeConfiguration({
    globalLimit: configuration.globalLimit,
    hostOverrides,
  });
}

function headroomView(
  sample: HostLoadSample,
  startingThreads: number,
): HeadroomView {
  const verdict = headroomVerdict(sample, startingThreads);
  return {
    memoryAvailableBytes: sample.memoryAvailableBytes,
    memoryReserveBytes: memoryReserveBytes(sample.memoryTotalBytes),
    cpuPressure: sample.cpuPressure.avg60,
    memoryPressure: sample.memoryPressure.avg10,
    admitting: verdict.kind === "admit",
    reason: verdict.kind === "admit" ? null : verdict.detail,
  };
}

function formatHostLine(host: HostView): string {
  const processors =
    host.availableParallelism === null
      ? "processors unknown"
      : `${host.availableParallelism} processors`;
  if (host.override !== null) {
    return `${host.name}: ${host.override} (${processors}, ${host.status})`;
  }
  if (host.headroom === null) {
    return `${host.name}: auto, ${host.automaticLimit} (${processors}, ${host.status})`;
  }
  const state = host.headroom.admitting
    ? "admitting"
    : `holding, ${host.headroom.reason}`;
  return [
    `${host.name}: auto, by headroom: ${state} (${processors}`,
    `${formatGigabytes(host.headroom.memoryAvailableBytes)} free`,
    `${formatGigabytes(host.headroom.memoryReserveBytes)} reserve`,
    `CPU pressure ${Math.round(host.headroom.cpuPressure)}%`,
    `memory pressure ${Math.round(host.headroom.memoryPressure)}%`,
    `${host.status})`,
  ].join(", ");
}

export default async function concurrencyLimitPlugin(
  bb: BbPluginApi,
): Promise<void> {
  const hostClient = bb.hosts.experimental_client({
    contract: concurrencyLimitHostContract,
  });
  const storedConfiguration = configurationSchema.safeParse(
    await bb.storage.kv.get<unknown>(CONFIGURATION_KEY),
  );
  let configuration = storedConfiguration.success
    ? normalizeConfiguration(storedConfiguration.data)
    : DEFAULT_CONFIGURATION;
  const storedCapacities = capacityRecordsSchema.safeParse(
    await bb.storage.kv.get<unknown>(CAPACITIES_KEY),
  );
  const capacities = new Map<string, HostCapacity>(
    (storedCapacities.success ? storedCapacities.data : []).map((record) => [
      record.hostId,
      { availableParallelism: record.availableParallelism, load: null },
    ]),
  );
  const admissions = new Map<string, Admission>();
  const heldOnHeadroom = new Set<string>();

  function startingCount(hostId: string, now: number): number {
    let count = 0;
    for (const [threadId, admission] of admissions) {
      if (now - admission.admittedAt >= HEADROOM_POLICY.startingWindowMs) {
        admissions.delete(threadId);
      } else if (admission.hostId === hostId) {
        count += 1;
      }
    }
    return count;
  }

  function policyModes(now: number): Map<string, HostPolicy["mode"]> {
    return new Map(
      [...capacities].map(([hostId, capacity]) => [
        hostId,
        resolveHostPolicy(configuration, hostId, capacity, now).mode,
      ]),
    );
  }

  function loadHostIds(): string[] {
    return [...capacities]
      .filter(([, capacity]) => capacity.load !== null)
      .map(([hostId]) => hostId);
  }

  async function readConfiguration() {
    const availableHosts = await bb.sdk.hosts.list();
    const now = Date.now();
    return {
      ...configuration,
      hosts: availableHosts.map(({ id, name, status }): HostView => {
        const capacity = capacities.get(id);
        const availableParallelism = capacity?.availableParallelism ?? null;
        const policy = resolveHostPolicy(configuration, id, capacity, now);
        return {
          id,
          name,
          status,
          availableParallelism,
          automaticLimit: automaticHostLimit(availableParallelism),
          effectiveLimit: policy.mode === "headroom" ? null : policy.limit,
          override: policy.mode === "override" ? policy.limit : null,
          headroom:
            policy.mode === "headroom"
              ? headroomView(policy.sample, startingCount(id, now))
              : null,
        };
      }),
    };
  }

  async function saveConfiguration(next: Configuration): Promise<void> {
    const normalized = normalizeConfiguration(next);
    await bb.storage.kv.set(CONFIGURATION_KEY, normalized);
    configuration = normalized;
    bb.realtime.publish(CONFIGURATION_CHANGED_CHANNEL, {});
    await bb.experimental_hooks.recheck("message.dispatch");
  }

  async function persistCapacities(): Promise<void> {
    const records: CapacityRecord[] = [...capacities]
      .map(([hostId, capacity]) => ({
        hostId,
        availableParallelism: capacity.availableParallelism,
      }))
      .sort((left, right) => left.hostId.localeCompare(right.hostId));
    await bb.storage.kv.set(CAPACITIES_KEY, records);
  }

  bb.rpc.register(concurrencyLimitRpcContract, {
    getConfiguration: readConfiguration,
    async setConfiguration(next) {
      await saveConfiguration(next);
      return readConfiguration();
    },
  });

  function unknownHost(hostId: string): PluginCliError {
    return new PluginCliError(`Unknown host: ${hostId}`, {
      code: "unknown_host",
      hint: "Run `bb machine list` for the enrolled host ids.",
    });
  }

  bb.cli.register(
    defineCli({
      name: "concurrency-limit",
      summary: "Configure global and per-host thread limits",
      description:
        "A limit holds new turns in line until a running thread goes idle. The automatic host limit starts threads while the host has free memory and low CPU and memory pressure; a host that does not report pressure allows one thread per processor.",
      commands: {
        status: cliCommand({
          summary: "Show effective concurrency limits",
          options: { json: JSON_OPTION },
          async run(input) {
            const view = await readConfiguration();
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(view)
                : [
                    `Overall: ${view.globalLimit === null ? "unlimited" : view.globalLimit}`,
                    "Automatic host limit: starts threads while the host has free memory and low CPU and memory pressure; hosts that do not report pressure allow one thread per processor",
                    ...view.hosts.map(formatHostLine),
                  ].join("\n"),
            };
          },
        }),
        global: cliCommand({
          summary: "Show or set the overall limit",
          positionals: [
            {
              name: "limit",
              description: `unlimited, or a whole number from 0 to ${MAX_LIMIT_VALUE} (0 holds every new turn); omit it to print the current limit`,
            },
          ],
          options: { json: JSON_OPTION },
          async run(input) {
            const requested = input.positionals.limit;
            if (requested !== undefined) {
              await saveConfiguration({
                ...configuration,
                globalLimit: parseLimitArgument(requested, "unlimited"),
              });
            }
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({ globalLimit: configuration.globalLimit })
                : configuration.globalLimit === null
                  ? "Unlimited"
                  : String(configuration.globalLimit),
            };
          },
        }),
        host: cliCommand({
          summary: "Show or set one host limit",
          positionals: [
            {
              name: "host-id",
              description: "Enrolled host id, as `bb machine list` prints it",
              required: true,
            },
            {
              name: "limit",
              description: `auto, or a whole number from 0 to ${MAX_LIMIT_VALUE} (0 holds every new turn on that host); omit it to print the host's limit`,
            },
          ],
          options: { json: JSON_OPTION },
          async run(input) {
            const hostId = input.positionals["host-id"];
            const view = await readConfiguration();
            if (!view.hosts.some((candidate) => candidate.id === hostId)) {
              throw unknownHost(hostId);
            }
            const requested = input.positionals.limit;
            if (requested !== undefined) {
              await saveConfiguration(
                setHostOverride(
                  configuration,
                  hostId,
                  parseLimitArgument(requested, "auto"),
                ),
              );
            }
            const updated = (await readConfiguration()).hosts.find(
              (candidate) => candidate.id === hostId,
            );
            if (updated === undefined) throw unknownHost(hostId);
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(updated)
                : formatHostLine(updated),
            };
          },
        }),
      },
    }),
  );

  let refreshAllRequested = true;
  const requestedHostIds = new Set<string>();
  let wakeWaiter: (() => void) | null = null;

  function requestRefresh(hostId?: string): void {
    if (hostId === undefined) refreshAllRequested = true;
    else requestedHostIds.add(hostId);
    wakeWaiter?.();
  }

  async function refreshCapacities(
    signal: AbortSignal,
    refreshAll: boolean,
    hostIds: ReadonlySet<string>,
  ): Promise<RefreshOutcome> {
    try {
      const modesBefore = policyModes(Date.now());
      const availableHosts = await bb.sdk.hosts.list({ signal });
      let changed = false;
      if (refreshAll) {
        const availableHostIds = new Set(availableHosts.map((host) => host.id));
        for (const hostId of capacities.keys()) {
          if (!availableHostIds.has(hostId)) {
            capacities.delete(hostId);
            changed = true;
          }
        }
      }
      let retry = false;
      const requested = availableHosts.filter(
        (availableHost) => refreshAll || hostIds.has(availableHost.id),
      );
      for (const offlineHost of requested) {
        if (offlineHost.status === "connected") continue;
        const previous = capacities.get(offlineHost.id);
        if (previous === undefined || previous.load === null) continue;
        capacities.set(offlineHost.id, { ...previous, load: null });
        changed = true;
      }
      await Promise.all(
        requested
          .filter((availableHost) => availableHost.status === "connected")
          .map(async (availableHost) => {
            try {
              const result = await hostClient.call("getCapacity", null, {
                hostId: availableHost.id,
                signal,
                timeoutMs: CAPACITY_CALL_TIMEOUT_MS,
              });
              const previous = capacities.get(availableHost.id);
              const load =
                result.load === null
                  ? null
                  : { ...result.load, sampledAt: Date.now() };
              capacities.set(availableHost.id, {
                availableParallelism: result.availableParallelism,
                load,
              });
              if (
                previous === undefined ||
                previous.availableParallelism !== result.availableParallelism ||
                (previous.load === null) !== (load === null)
              ) {
                changed = true;
              }
            } catch (error) {
              if (signal.aborted) return;
              retry = true;
              bb.log.warn(
                `Could not detect capacity for host ${availableHost.id}: ${errorMessage(error)}`,
              );
            }
          }),
      );
      const released = releaseHeldHosts();
      const policyChanged = [...policyModes(Date.now())].some(
        ([hostId, mode]) => modesBefore.get(hostId) !== mode,
      );
      if (changed) {
        await persistCapacities();
        bb.realtime.publish(CONFIGURATION_CHANGED_CHANNEL, {});
      }
      if (changed || released || policyChanged) {
        await bb.experimental_hooks.recheck("message.dispatch");
      }
      return retry ? "retry" : "settled";
    } catch (error) {
      if (!signal.aborted) {
        bb.log.warn(
          `Could not load hosts for capacity detection: ${errorMessage(error)}`,
        );
      }
      return signal.aborted ? "settled" : "retry";
    }
  }

  function releaseHeldHosts(): boolean {
    const now = Date.now();
    let released = false;
    for (const hostId of [...heldOnHeadroom]) {
      const policy = resolveHostPolicy(
        configuration,
        hostId,
        capacities.get(hostId),
        now,
      );
      if (
        policy.mode === "headroom" &&
        headroomVerdict(policy.sample, startingCount(hostId, now)).kind ===
          "hold"
      ) {
        continue;
      }
      heldOnHeadroom.delete(hostId);
      released = true;
    }
    return released;
  }

  function waitForRefresh(
    signal: AbortSignal,
    retryDelayMs: number | null,
    pollDelayMs: number | null,
  ): Promise<WakeReason> {
    if (signal.aborted) return Promise.resolve("aborted");
    if (refreshAllRequested || requestedHostIds.size > 0) {
      return Promise.resolve("requested");
    }
    return new Promise((resolve) => {
      const timers: ReturnType<typeof setTimeout>[] = [];
      let settled = false;
      const finish = (reason: WakeReason): void => {
        if (settled) return;
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        if (wakeWaiter === wake) wakeWaiter = null;
        signal.removeEventListener("abort", abort);
        resolve(reason);
      };
      const wake = (): void => finish("requested");
      const abort = (): void => finish("aborted");
      wakeWaiter = wake;
      signal.addEventListener("abort", abort, { once: true });
      if (retryDelayMs !== null) {
        timers.push(setTimeout(() => finish("retry"), retryDelayMs));
      }
      if (pollDelayMs !== null) {
        timers.push(setTimeout(() => finish("poll"), pollDelayMs));
      }
    });
  }

  bb.background.service("capacity-detector", {
    async start(signal) {
      const unsubscribeHost = bb.sdk.subscribe({
        event: "host:changed",
        callback: (event) => {
          if (
            event.changes.some(
              (change) =>
                change === "host-connected" || change === "host-disconnected",
            )
          )
            bb.realtime.publish(CONFIGURATION_CHANGED_CHANNEL, {});
          if (event.changes.includes("host-connected"))
            requestRefresh(event.id);
        },
      });
      const unsubscribeRealtime = bb.sdk.subscribe({
        event: "realtime:connection",
        callback: (event) => {
          if (event.state === "connected" && event.reconnected)
            requestRefresh();
        },
      });
      let retryMs = RETRY_MIN_MS;
      let retryDueAt: number | null = null;
      try {
        while (!signal.aborted) {
          const refreshAll = refreshAllRequested;
          const hostIds = new Set(requestedHostIds);
          refreshAllRequested = false;
          requestedHostIds.clear();
          const outcome = await refreshCapacities(signal, refreshAll, hostIds);
          if (signal.aborted) break;
          if (outcome === "retry") {
            retryDueAt ??= Date.now() + retryMs;
          } else if (refreshAll) {
            retryMs = RETRY_MIN_MS;
            retryDueAt = null;
          }
          if (refreshAllRequested || requestedHostIds.size > 0) continue;
          const pollHostIds = loadHostIds();
          const wakeReason = await waitForRefresh(
            signal,
            retryDueAt === null ? null : Math.max(0, retryDueAt - Date.now()),
            pollHostIds.length === 0 ? null : LOAD_POLL_MS,
          );
          if (wakeReason === "retry") {
            retryDueAt = null;
            refreshAllRequested = true;
            retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
          } else if (wakeReason === "poll") {
            for (const hostId of pollHostIds) requestedHostIds.add(hostId);
          }
        }
      } finally {
        unsubscribeRealtime();
        unsubscribeHost();
        wakeWaiter?.();
        wakeWaiter = null;
      }
    },
  });

  for (const event of CAPACITY_FREED_EVENTS) {
    bb.events.on(event, async () => {
      await bb.experimental_hooks.recheck("message.dispatch");
    });
  }

  bb.events.on("message.queued", ({ entry }) => {
    if (!turnKeptRunning(entry.waitingOn)) admissions.delete(entry.threadId);
  });

  bb.experimental_hooks.on("message.dispatch", async (context) => {
    if (
      context.attempt === "join-turn" ||
      context.thread.status === "active" ||
      context.thread.status === "starting"
    ) {
      return { action: "proceed" };
    }

    const host = context.host;
    if (configuration.globalLimit === null && host === null) {
      return { action: "proceed" };
    }
    const running = await bb.sdk.threads.listRunning();

    if (
      configuration.globalLimit !== null &&
      running.length >= configuration.globalLimit
    ) {
      return fullDecision(configuration.globalLimit, "all hosts");
    }

    if (host !== null) {
      const label = host.name.trim() === "" ? host.id : host.name;
      const now = Date.now();
      const policy = resolveHostPolicy(
        configuration,
        host.id,
        capacities.get(host.id),
        now,
      );
      if (policy.mode === "headroom") {
        const verdict = headroomVerdict(
          policy.sample,
          startingCount(host.id, now),
        );
        if (verdict.kind === "hold") {
          heldOnHeadroom.add(host.id);
          return waitDecision(`${verdict.detail} on host ${label}`);
        }
        admissions.set(context.thread.id, { hostId: host.id, admittedAt: now });
      } else {
        const onHost = running.filter((thread) => thread.hostId === host.id);
        if (onHost.length >= policy.limit) {
          return fullDecision(policy.limit, `host ${label}`);
        }
      }
    }

    return { action: "proceed" };
  });
}
