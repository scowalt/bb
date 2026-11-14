const KIBIBYTE = 1024;

function meminfoBytes(text: string, field: string): number | null {
  const match = new RegExp(`^${field}:\\s+(\\d+) kB$`, "mu").exec(text);
  return match === null ? null : Number(match[1]) * KIBIBYTE;
}

export function parseMeminfo(
  text: string,
): { availableBytes: number; totalBytes: number } | null {
  const totalBytes = meminfoBytes(text, "MemTotal");
  const availableBytes = meminfoBytes(text, "MemAvailable");
  if (totalBytes === null || availableBytes === null || totalBytes === 0) {
    return null;
  }
  return { availableBytes, totalBytes };
}

const PRESSURE_SOME_LINE =
  /^some avg10=(\d+(?:\.\d+)?) avg60=(\d+(?:\.\d+)?) avg300=\d+(?:\.\d+)? total=\d+$/mu;

export function parsePressureSome(
  text: string,
): { avg10: number; avg60: number } | null {
  const match = PRESSURE_SOME_LINE.exec(text);
  if (match === null) return null;
  const avg10 = Number(match[1]);
  const avg60 = Number(match[2]);
  if (avg10 > 100 || avg60 > 100) return null;
  return { avg10, avg60 };
}
