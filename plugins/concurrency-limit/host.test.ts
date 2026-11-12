import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { describe, expect, it } from "vitest";
import hostEntry from "./host.js";

async function readable(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

describe("Concurrency limit host entry", () => {
  it("reports the host's available parallelism", async () => {
    const harness = experimental_createHostEntryHarness(hostEntry);

    await expect(
      harness.experimental_call("getCapacity", null),
    ).resolves.toMatchObject({ availableParallelism: availableParallelism() });
    await harness.experimental_dispose();
  });

  it("reports free memory and pressure stall information where /proc exposes them, and no load otherwise", async () => {
    const harness = experimental_createHostEntryHarness(hostEntry);
    const procReadable = (
      await Promise.all(
        ["/proc/meminfo", "/proc/pressure/cpu", "/proc/pressure/memory"].map(
          readable,
        ),
      )
    ).every(Boolean);

    const { load } = await harness.experimental_call("getCapacity", null);
    if (!procReadable) {
      expect(load).toBeNull();
      await harness.experimental_dispose();
      return;
    }
    expect(load).not.toBeNull();
    if (load === null) return;
    expect(load.memoryTotalBytes).toBeGreaterThan(0);
    expect(load.memoryAvailableBytes).toBeGreaterThan(0);
    expect(load.memoryAvailableBytes).toBeLessThanOrEqual(
      load.memoryTotalBytes,
    );
    for (const pressure of [load.cpuPressure, load.memoryPressure]) {
      expect(pressure.avg10).toBeGreaterThanOrEqual(0);
      expect(pressure.avg10).toBeLessThanOrEqual(100);
      expect(pressure.avg60).toBeGreaterThanOrEqual(0);
      expect(pressure.avg60).toBeLessThanOrEqual(100);
    }
    await harness.experimental_dispose();
  });
});
