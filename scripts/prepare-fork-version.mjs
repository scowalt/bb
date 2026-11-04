import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bumpVersion, readMaxTargetVersion } from "./bump-version.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(scriptPath), "..");
const semverCorePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/u;
const positiveIntegerPattern = /^[1-9]\d*$/u;

export function deriveForkVersion(currentVersion, runNumber) {
  const coreMatch = semverCorePattern.exec(currentVersion);
  if (coreMatch === null) {
    throw new Error(`Invalid current version: ${currentVersion}`);
  }
  if (!positiveIntegerPattern.test(runNumber)) {
    throw new Error(
      `GITHUB_RUN_NUMBER must be a positive integer, got ${runNumber}.`,
    );
  }

  const [, major, minor, patch] = coreMatch;
  return `${major}.${minor}.${BigInt(patch) + 1n}-fork.${BigInt(runNumber)}`;
}

export async function prepareForkVersion(options) {
  const forkVersion = deriveForkVersion(
    await readMaxTargetVersion({ repoRoot: options.repoRoot }),
    options.runNumber,
  );
  await bumpVersion({
    args: [forkVersion],
    log: () => {},
    repoRoot: options.repoRoot,
  });
  return forkVersion;
}

async function main() {
  const forkVersion = await prepareForkVersion({
    repoRoot: process.env.BB_FORK_VERSION_REPO_ROOT ?? defaultRepoRoot,
    runNumber: process.env.GITHUB_RUN_NUMBER ?? "",
  });
  process.stdout.write(`${forkVersion}\n`);
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
