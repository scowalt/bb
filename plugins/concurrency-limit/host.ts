import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { concurrencyLimitHostContract, type HostLoad } from "./contract.js";
import { parseMeminfo, parsePressureSome } from "./load.js";

async function readProc(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function readLoad(): Promise<HostLoad | null> {
  const [meminfo, cpu, memory] = await Promise.all([
    readProc("/proc/meminfo"),
    readProc("/proc/pressure/cpu"),
    readProc("/proc/pressure/memory"),
  ]);
  if (meminfo === null || cpu === null || memory === null) return null;
  const memoryInfo = parseMeminfo(meminfo);
  const cpuPressure = parsePressureSome(cpu);
  const memoryPressure = parsePressureSome(memory);
  if (memoryInfo === null || cpuPressure === null || memoryPressure === null) {
    return null;
  }
  return {
    memoryAvailableBytes: memoryInfo.availableBytes,
    memoryTotalBytes: memoryInfo.totalBytes,
    cpuPressure,
    memoryPressure,
  };
}

export default experimental_defineHostEntry({
  contract: concurrencyLimitHostContract,
  handlers: {
    async getCapacity() {
      return {
        availableParallelism: availableParallelism(),
        load: await readLoad(),
      };
    },
  },
});
