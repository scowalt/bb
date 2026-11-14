import { describe, expect, it } from "vitest";
import {
  commitGlobalLimitDraft,
  commitHostLimitDraft,
  headroomVerdict,
  memoryReserveBytes,
  resolveHostPolicy,
  type HostLoadSample,
} from "./limits.js";

const GIBIBYTE = 2 ** 30;
const NOW = 1_000_000;

function sample(overrides: Partial<HostLoadSample> = {}): HostLoadSample {
  return {
    memoryTotalBytes: 92 * GIBIBYTE,
    memoryAvailableBytes: 70 * GIBIBYTE,
    cpuPressure: { avg10: 1, avg60: 1 },
    memoryPressure: { avg10: 0, avg60: 0 },
    sampledAt: NOW,
    ...overrides,
  };
}

describe("resolveHostPolicy", () => {
  const configuration = {
    globalLimit: null,
    hostOverrides: [{ hostId: "host-b", limit: 3 }],
  };

  it("uses headroom while the host has a fresh load sample", () => {
    expect(
      resolveHostPolicy(
        configuration,
        "host-a",
        { availableParallelism: 20, load: sample() },
        NOW + 30_000,
      ),
    ).toEqual({ mode: "headroom", sample: sample() });
  });

  it("falls back to processors for a stale sample, no sample, or no capacity", () => {
    expect(
      resolveHostPolicy(
        configuration,
        "host-a",
        { availableParallelism: 20, load: sample() },
        NOW + 30_001,
      ),
    ).toEqual({ mode: "processors", limit: 20 });
    expect(
      resolveHostPolicy(
        configuration,
        "host-a",
        { availableParallelism: 20, load: null },
        NOW,
      ),
    ).toEqual({ mode: "processors", limit: 20 });
    expect(resolveHostPolicy(configuration, "host-a", undefined, NOW)).toEqual({
      mode: "processors",
      limit: 1,
    });
  });

  it("lets an override win over a fresh sample", () => {
    expect(
      resolveHostPolicy(
        configuration,
        "host-b",
        { availableParallelism: 20, load: sample() },
        NOW,
      ),
    ).toEqual({ mode: "override", limit: 3 });
  });
});

describe("headroomVerdict", () => {
  it("keeps at least 2 GB or a tenth of memory in reserve", () => {
    expect(memoryReserveBytes(8 * GIBIBYTE)).toBe(2 * GIBIBYTE);
    expect(memoryReserveBytes(92 * GIBIBYTE)).toBe(Math.round(9.2 * GIBIBYTE));
  });

  it("admits a healthy sample", () => {
    expect(headroomVerdict(sample(), 0)).toEqual({ kind: "admit" });
  });

  it("holds on memory pressure before CPU pressure before free memory", () => {
    expect(
      headroomVerdict(
        sample({
          memoryPressure: { avg10: 10, avg60: 0 },
          cpuPressure: { avg10: 99, avg60: 99 },
          memoryAvailableBytes: 0,
        }),
        0,
      ),
    ).toEqual({
      kind: "hold",
      signal: "memory-pressure",
      detail: "Memory pressure 10% (limit 10%)",
    });
    expect(
      headroomVerdict(
        sample({
          cpuPressure: { avg10: 99, avg60: 50 },
          memoryAvailableBytes: 0,
        }),
        0,
      ),
    ).toEqual({
      kind: "hold",
      signal: "cpu-pressure",
      detail: "CPU pressure 50% (limit 50%)",
    });
    expect(
      headroomVerdict(sample({ memoryAvailableBytes: 10 * GIBIBYTE }), 0),
    ).toEqual({
      kind: "hold",
      signal: "memory",
      detail: "10.0 GB free, 9.2 GB kept in reserve",
    });
  });

  it("judges pressure on the 60 second CPU average and the 10 second memory average", () => {
    expect(
      headroomVerdict(sample({ cpuPressure: { avg10: 95, avg60: 20 } }), 0),
    ).toEqual({ kind: "admit" });
    expect(
      headroomVerdict(sample({ memoryPressure: { avg10: 2, avg60: 40 } }), 0),
    ).toEqual({ kind: "admit" });
  });

  it("charges 1 GB for each thread that just started", () => {
    const free = sample({ memoryAvailableBytes: Math.round(12.2 * GIBIBYTE) });
    expect(headroomVerdict(free, 2)).toEqual({ kind: "admit" });
    expect(headroomVerdict(free, 3)).toEqual({
      kind: "hold",
      signal: "memory",
      detail: "12.2 GB free, 9.2 GB kept in reserve, 3 threads just started",
    });
  });
});

describe("commitGlobalLimitDraft", () => {
  const configuration = { globalLimit: null, hostOverrides: [] };

  it.each(["1.5", "-1", "10001", "abc"])("rejects %j", (draft) => {
    expect(commitGlobalLimitDraft(configuration, draft)).toEqual({
      kind: "invalid",
    });
  });

  it("saves a whole-number limit", () => {
    expect(commitGlobalLimitDraft(configuration, " 3 ")).toEqual({
      kind: "changed",
      configuration: { globalLimit: 3, hostOverrides: [] },
    });
  });

  it("skips a save when the limit did not change", () => {
    expect(commitGlobalLimitDraft(configuration, "")).toEqual({
      kind: "unchanged",
    });
    expect(
      commitGlobalLimitDraft({ globalLimit: 4, hostOverrides: [] }, "4"),
    ).toEqual({ kind: "unchanged" });
  });
});

describe("commitHostLimitDraft", () => {
  const configuration = {
    globalLimit: 3,
    hostOverrides: [
      { hostId: "host-a", limit: 2 },
      { hostId: "host-b", limit: 5 },
    ],
  };

  it("rejects an invalid number", () => {
    expect(commitHostLimitDraft(configuration, "host-a", "2.5")).toEqual({
      kind: "invalid",
    });
  });

  it("adds an override for a host on Auto", () => {
    expect(commitHostLimitDraft(configuration, "host-c", "1")).toEqual({
      kind: "changed",
      configuration: {
        globalLimit: 3,
        hostOverrides: [
          { hostId: "host-a", limit: 2 },
          { hostId: "host-b", limit: 5 },
          { hostId: "host-c", limit: 1 },
        ],
      },
    });
  });

  it("replaces a host's existing override", () => {
    expect(commitHostLimitDraft(configuration, "host-a", "6")).toEqual({
      kind: "changed",
      configuration: {
        globalLimit: 3,
        hostOverrides: [
          { hostId: "host-b", limit: 5 },
          { hostId: "host-a", limit: 6 },
        ],
      },
    });
  });

  it("returns a host to Auto when its override is cleared", () => {
    expect(commitHostLimitDraft(configuration, "host-a", "")).toEqual({
      kind: "changed",
      configuration: {
        globalLimit: 3,
        hostOverrides: [{ hostId: "host-b", limit: 5 }],
      },
    });
  });

  it("skips a save when the override did not change", () => {
    expect(commitHostLimitDraft(configuration, "host-a", "2")).toEqual({
      kind: "unchanged",
    });
    expect(commitHostLimitDraft(configuration, "host-c", "")).toEqual({
      kind: "unchanged",
    });
  });
});
