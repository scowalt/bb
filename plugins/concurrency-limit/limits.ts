import type { HostLoad } from "./contract.js";

export const MAX_LIMIT_VALUE = 10_000;

const GIBIBYTE = 2 ** 30;

export const HEADROOM_POLICY = {
  minimumReserveBytes: 2 * GIBIBYTE,
  reserveFraction: 0.1,
  startingThreadBytes: GIBIBYTE,
  startingWindowMs: 30_000,
  cpuPressureLimit: 50,
  memoryPressureLimit: 10,
  sampleMaxAgeMs: 30_000,
} as const;

export interface HostLimitOverride {
  readonly hostId: string;
  readonly limit: number;
}

export interface LimitConfiguration {
  readonly globalLimit: number | null;
  readonly hostOverrides: readonly HostLimitOverride[];
}

export interface HostLoadSample extends HostLoad {
  readonly sampledAt: number;
}

export interface HostCapacity {
  readonly availableParallelism: number;
  readonly load: HostLoadSample | null;
}

export type HostPolicy =
  | { readonly mode: "override"; readonly limit: number }
  | { readonly mode: "processors"; readonly limit: number }
  | { readonly mode: "headroom"; readonly sample: HostLoadSample };

export type HeadroomVerdict =
  | { readonly kind: "admit" }
  | {
      readonly kind: "hold";
      readonly signal: "memory" | "cpu-pressure" | "memory-pressure";
      readonly detail: string;
    };

export function parseLimitValue(raw: string): number | null {
  if (!/^\d+$/u.test(raw)) return null;
  const value = Number(raw);
  return value <= MAX_LIMIT_VALUE ? value : null;
}

export function automaticHostLimit(
  availableParallelism: number | null,
): number {
  if (availableParallelism === null) return 1;
  return availableParallelism;
}

export function resolveHostPolicy(
  configuration: LimitConfiguration,
  hostId: string,
  capacity: HostCapacity | undefined,
  now: number,
): HostPolicy {
  const override = configuration.hostOverrides.find(
    (candidate) => candidate.hostId === hostId,
  );
  if (override !== undefined) {
    return { mode: "override", limit: override.limit };
  }
  const sample = capacity?.load ?? null;
  if (
    sample !== null &&
    now - sample.sampledAt <= HEADROOM_POLICY.sampleMaxAgeMs
  ) {
    return { mode: "headroom", sample };
  }
  return {
    mode: "processors",
    limit: automaticHostLimit(capacity?.availableParallelism ?? null),
  };
}

export function memoryReserveBytes(memoryTotalBytes: number): number {
  return Math.max(
    HEADROOM_POLICY.minimumReserveBytes,
    Math.round(memoryTotalBytes * HEADROOM_POLICY.reserveFraction),
  );
}

export function formatGigabytes(bytes: number): string {
  return `${(bytes / GIBIBYTE).toFixed(1)} GB`;
}

export function headroomVerdict(
  sample: HostLoadSample,
  startingThreads: number,
): HeadroomVerdict {
  const memoryPressure = Math.round(sample.memoryPressure.avg10);
  if (memoryPressure >= HEADROOM_POLICY.memoryPressureLimit) {
    return {
      kind: "hold",
      signal: "memory-pressure",
      detail: `Memory pressure ${memoryPressure}% (limit ${HEADROOM_POLICY.memoryPressureLimit}%)`,
    };
  }
  const cpuPressure = Math.round(sample.cpuPressure.avg60);
  if (cpuPressure >= HEADROOM_POLICY.cpuPressureLimit) {
    return {
      kind: "hold",
      signal: "cpu-pressure",
      detail: `CPU pressure ${cpuPressure}% (limit ${HEADROOM_POLICY.cpuPressureLimit}%)`,
    };
  }
  const reserve = memoryReserveBytes(sample.memoryTotalBytes);
  const charged = (startingThreads + 1) * HEADROOM_POLICY.startingThreadBytes;
  if (sample.memoryAvailableBytes - charged < reserve) {
    const starting =
      startingThreads === 0
        ? ""
        : `, ${startingThreads} ${startingThreads === 1 ? "thread" : "threads"} just started`;
    return {
      kind: "hold",
      signal: "memory",
      detail: `${formatGigabytes(sample.memoryAvailableBytes)} free, ${formatGigabytes(reserve)} kept in reserve${starting}`,
    };
  }
  return { kind: "admit" };
}

interface LimitConfigurationInput {
  globalLimit: number | null;
  hostOverrides: HostLimitOverride[];
}

export type LimitDraftCommit =
  | { readonly kind: "invalid" }
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "changed";
      readonly configuration: LimitConfigurationInput;
    };

function parseLimitDraft(
  raw: string,
): { ok: true; value: number | null } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  const value = parseLimitValue(trimmed);
  return value === null ? { ok: false } : { ok: true, value };
}

export function commitGlobalLimitDraft(
  configuration: LimitConfiguration,
  draft: string,
): LimitDraftCommit {
  const parsed = parseLimitDraft(draft);
  if (!parsed.ok) return { kind: "invalid" };
  if (parsed.value === configuration.globalLimit) return { kind: "unchanged" };
  return {
    kind: "changed",
    configuration: {
      globalLimit: parsed.value,
      hostOverrides: [...configuration.hostOverrides],
    },
  };
}

export function commitHostLimitDraft(
  configuration: LimitConfiguration,
  hostId: string,
  draft: string,
): LimitDraftCommit {
  const parsed = parseLimitDraft(draft);
  if (!parsed.ok) return { kind: "invalid" };
  const existing = configuration.hostOverrides.find(
    (override) => override.hostId === hostId,
  );
  if (parsed.value === (existing?.limit ?? null)) return { kind: "unchanged" };
  const hostOverrides = configuration.hostOverrides.filter(
    (override) => override.hostId !== hostId,
  );
  if (parsed.value !== null)
    hostOverrides.push({ hostId, limit: parsed.value });
  return {
    kind: "changed",
    configuration: { globalLimit: configuration.globalLimit, hostOverrides },
  };
}
