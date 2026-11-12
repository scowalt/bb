import { describe, expect, it } from "vitest";
import { parseMeminfo, parsePressureSome } from "./load.js";

const MEMINFO = `MemTotal:       96260260 kB
MemFree:        33926004 kB
MemAvailable:   75370964 kB
Buffers:         6205412 kB
Cached:         21886896 kB
SwapCached:         7340 kB
Active:         10950940 kB
Inactive:       33815116 kB
HugePages_Total:       0
Hugepagesize:       2048 kB
DirectMap1G:    88080384 kB
`;

const CPU_PRESSURE = `some avg10=8.09 avg60=13.49 avg300=6.05 total=10483835777
full avg10=0.00 avg60=0.00 avg300=0.00 total=0
`;

const MEMORY_PRESSURE = `some avg10=0.00 avg60=0.00 avg300=0.00 total=17327774
full avg10=0.00 avg60=0.00 avg300=0.00 total=14981895
`;

describe("parseMeminfo", () => {
  it("reads MemTotal and MemAvailable from /proc/meminfo in bytes", () => {
    expect(parseMeminfo(MEMINFO)).toEqual({
      totalBytes: 96260260 * 1024,
      availableBytes: 75370964 * 1024,
    });
  });

  it.each([
    ["an empty file", ""],
    [
      "a kernel without MemAvailable",
      "MemTotal:       96260260 kB\nMemFree:        33926004 kB\n",
    ],
    ["garbage", "not a meminfo file"],
    ["a zero total", "MemTotal:       0 kB\nMemAvailable:   0 kB\n"],
  ])("returns null for %s", (_label, text) => {
    expect(parseMeminfo(text)).toBeNull();
  });
});

describe("parsePressureSome", () => {
  it("reads the some line of a PSI file", () => {
    expect(parsePressureSome(CPU_PRESSURE)).toEqual({
      avg10: 8.09,
      avg60: 13.49,
    });
    expect(parsePressureSome(MEMORY_PRESSURE)).toEqual({ avg10: 0, avg60: 0 });
  });

  it.each([
    ["an empty file", ""],
    ["only a full line", "full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"],
    ["garbage", "some avg10=lots avg60=more\n"],
    [
      "a value above 100 percent",
      "some avg10=150.00 avg60=0.00 avg300=0.00 total=1\n",
    ],
  ])("returns null for %s", (_label, text) => {
    expect(parsePressureSome(text)).toBeNull();
  });
});
