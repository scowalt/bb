import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import {
  experimental_filterResolvedNativeRoots,
  type ExperimentalNativeRootsResolveAnswer,
} from "@get-bb/plugin-sdk/host";
import { z } from "zod";

export const PI_NATIVE_ROOTS_DECLARATION: Pick<
  PluginProviderDeclaration,
  "experimental_nativeSkillRoots" | "experimental_resolvesNativeRoots"
> = {
  experimental_nativeSkillRoots: {
    user: [
      { path: ".pi/agent/skills", recursive: true },
      { path: ".agents/skills", recursive: true },
    ],
    project: [
      { path: ".pi/skills", recursive: true },
      { path: ".agents/skills", recursive: true, ancestors: true },
    ],
  },
  experimental_resolvesNativeRoots: true,
};

const piSettingsSchema = z
  .object({
    skills: z.array(z.string()).optional(),
    packages: z.array(z.unknown()).optional(),
  })
  .passthrough();

const piPackageEntrySchema = z.union([
  z.string(),
  z
    .object({
      source: z.string(),
      skills: z.array(z.string()).optional(),
      autoload: z.boolean().optional(),
    })
    .passthrough(),
]);

const PI_MANIFEST_RESOURCE_FIELDS = [
  "extensions",
  "skills",
  "prompts",
  "themes",
] as const;

const piManifestSchema = z
  .object({ pi: z.record(z.string(), z.unknown()) })
  .passthrough();

type PiSkillRootShape = "skills" | "skill" | "skill-file";

interface PiSkillRoot {
  path: string;
  shape: PiSkillRootShape;
}

const DEFAULT_AGENT_DIR_SEGMENTS = [".pi", "agent"] as const;

export interface ResolvePiNativeRootsArgs {
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
}

function resolvePiAgentDir(args: ResolvePiNativeRootsArgs): string {
  const configured = args.env.PI_CODING_AGENT_DIR?.trim();
  return configured
    ? resolveStoredPath(args.homeDir, configured, args.homeDir)
    : path.join(args.homeDir, ...DEFAULT_AGENT_DIR_SEGMENTS);
}

function resolveStoredPath(
  homeDir: string,
  value: string,
  baseDir: string,
): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function isPlainSkillSource(value: string): boolean {
  return !/^(?:npm:|git:|https?:\/\/|git@)/u.test(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isInsideOrSame(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function isSafeInstallPart(value: string, allowSlash: boolean): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }
  return [value, decoded].every(
    (candidate) =>
      candidate.length > 0 &&
      !candidate.includes("\0") &&
      !candidate.includes("\\") &&
      !candidate.startsWith("/") &&
      (allowSlash || !candidate.includes("/")) &&
      !candidate.split("/").some((part) => part === ".." || part === "."),
  );
}

function gitInstallParts(
  source: string,
): { host: string; repoPath: string } | null {
  const hasPrefix = source.startsWith("git:");
  const url = hasPrefix ? source.slice("git:".length).trim() : source;
  if (!hasPrefix && !/^(?:https?|ssh|git):\/\//iu.test(url)) return null;
  let host: string;
  let pathWithRef: string;
  const scpLike = /^git@([^:]+):(.+)$/u.exec(url);
  if (scpLike) {
    host = scpLike[1] ?? "";
    pathWithRef = scpLike[2] ?? "";
  } else if (/^[a-z]+:\/\//iu.test(url)) {
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      pathWithRef = parsed.pathname;
    } catch {
      return null;
    }
  } else {
    const slash = url.indexOf("/");
    if (slash < 0) return null;
    host = url.slice(0, slash);
    pathWithRef = url.slice(slash + 1);
    if (!host.includes(".") && host !== "localhost") return null;
  }
  const repoPath = (pathWithRef.split("@")[0] ?? "")
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "");
  if (
    repoPath.split("/").length < 2 ||
    !isSafeInstallPart(host, false) ||
    !isSafeInstallPart(repoPath, true)
  ) {
    return null;
  }
  return { host, repoPath };
}

function npmPackageName(spec: string): string | null {
  const name = /^(@?[^@]+(?:\/[^@]+)?)(?:@.+)?$/u.exec(spec)?.[1];
  if (!name) return null;
  const parts = name.split("/");
  const scoped = name.startsWith("@");
  if (parts.length !== (scoped ? 2 : 1)) return null;
  return isSafeInstallPart(name, scoped) && !name.startsWith(".") ? name : null;
}

function resolvePackageRoot(
  homeDir: string,
  agentDir: string,
  source: string,
): string | null {
  if (source.startsWith("npm:")) {
    const name = npmPackageName(source.slice("npm:".length).trim());
    return name === null
      ? null
      : path.join(agentDir, "npm", "node_modules", name);
  }
  const git = gitInstallParts(source);
  if (git !== null) {
    const gitRoot = path.join(agentDir, "git");
    const installPath = path.resolve(gitRoot, git.host, git.repoPath);
    return isInsideOrSame(gitRoot, installPath) && installPath !== gitRoot
      ? installPath
      : null;
  }
  if (/^(?:git|github|https?|ssh|builtin):/u.test(source)) return null;
  return path.resolve(resolveStoredPath(homeDir, source, agentDir));
}

async function readPackageSkillEntries(packageRoot: string): Promise<string[]> {
  let manifest: Record<string, unknown> | null = null;
  try {
    manifest = piManifestSchema.parse(
      JSON.parse(
        (
          await readFile(path.join(packageRoot, "package.json"), "utf8")
        ).replace(/^\ufeff/u, ""),
      ),
    ).pi;
  } catch {
    manifest = null;
  }
  if (
    !PI_MANIFEST_RESOURCE_FIELDS.some((field) =>
      isStringArray(manifest?.[field]),
    )
  ) {
    return ["skills"];
  }
  const skills = manifest?.skills;
  return isStringArray(skills) ? skills : [];
}

async function skillRootAt(target: string): Promise<PiSkillRoot | null> {
  try {
    const stats = await stat(target);
    if (stats.isFile()) {
      return target.endsWith(".md")
        ? { path: target, shape: "skill-file" }
        : null;
    }
    if (!stats.isDirectory()) return null;
  } catch {
    return null;
  }
  const isSkill = await stat(path.join(target, "SKILL.md")).then(
    (stats) => stats.isFile(),
    () => false,
  );
  return { path: target, shape: isSkill ? "skill" : "skills" };
}

async function resolvePackageSkillRoots(
  homeDir: string,
  agentDir: string,
  rawEntry: unknown,
): Promise<PiSkillRoot[]> {
  const parsed = piPackageEntrySchema.safeParse(rawEntry);
  if (!parsed.success) return [];
  const entry = parsed.data;
  if (
    typeof entry !== "string" &&
    (entry.skills !== undefined || entry.autoload === false)
  ) {
    return [];
  }
  const source = (typeof entry === "string" ? entry : entry.source).trim();
  if (source.length === 0) return [];
  const packageRoot = resolvePackageRoot(homeDir, agentDir, source);
  if (packageRoot === null) return [];
  const roots: PiSkillRoot[] = [];
  for (const skillEntry of await readPackageSkillEntries(packageRoot)) {
    if (/^[!+-]/u.test(skillEntry) || /[*?]/u.test(skillEntry)) continue;
    const target = path.resolve(packageRoot, skillEntry);
    if (!isInsideOrSame(packageRoot, target)) continue;
    const root = await skillRootAt(target);
    if (root !== null) roots.push(root);
  }
  return roots;
}

export async function resolvePiNativeRoots(
  args: ResolvePiNativeRootsArgs,
): Promise<ExperimentalNativeRootsResolveAnswer> {
  const agentDir = resolvePiAgentDir(args);
  const roots = new Map<string, PiSkillRootShape>();
  if (agentDir !== path.join(args.homeDir, ...DEFAULT_AGENT_DIR_SEGMENTS)) {
    roots.set(path.resolve(agentDir, "skills"), "skills");
  }
  let settings: z.infer<typeof piSettingsSchema> | null = null;
  try {
    settings = piSettingsSchema.parse(
      JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8")),
    );
  } catch {
    settings = null;
  }
  for (const raw of settings?.skills ?? []) {
    const value = raw.trim();
    if (
      value.length === 0 ||
      value.startsWith("!") ||
      !isPlainSkillSource(value)
    ) {
      continue;
    }
    if (path.extname(value).toLowerCase() === ".md") {
      continue;
    }
    roots.set(
      path.resolve(resolveStoredPath(args.homeDir, value, agentDir)),
      "skills",
    );
  }
  for (const rawEntry of settings?.packages ?? []) {
    for (const root of await resolvePackageSkillRoots(
      args.homeDir,
      agentDir,
      rawEntry,
    )) {
      if (!roots.has(root.path)) roots.set(root.path, root.shape);
    }
  }
  return {
    skills: experimental_filterResolvedNativeRoots(
      {
        skills: [...roots]
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([rootPath, shape]) => ({
            path: rootPath,
            origin: "user" as const,
            recursive: shape === "skills",
            shape,
          })),
      },
      { warn: console.warn },
    ).answer.skills,
  };
}
