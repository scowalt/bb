import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { experimental_nativeRootsResolveOutputSchema } from "@get-bb/plugin-sdk/host";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resolvePiNativeRoots } from "./native-roots.js";

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "bb-pi-native-roots-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

function writeSettings(agentDir: string, settings: unknown): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
}

async function resolvedSkillPaths(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string[]> {
  const answer = await resolvePiNativeRoots({ homeDir, env });
  const parsed = experimental_nativeRootsResolveOutputSchema.parse(answer);
  expect(parsed.commands).toEqual([]);
  for (const root of parsed.skills) {
    expect(root).toMatchObject({
      origin: "user",
      recursive: true,
      shape: "skills",
      namePrefix: "",
    });
  }
  return parsed.skills.map((root) => root.path);
}

it("answers empty without a settings file or with an unreadable one", async () => {
  await expect(resolvedSkillPaths({})).resolves.toEqual([]);
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  writeFileSync(join(homeDir, ".pi", "agent", "settings.json"), "{not json");
  await expect(resolvedSkillPaths({})).resolves.toEqual([]);
});

it("resolves plain skill entries against home, the agent dir, or as given, and drops the rest", async () => {
  writeSettings(join(homeDir, ".pi", "agent"), {
    skills: [
      "/opt/team-skills",
      "~/shared/skills",
      "local-skills/",
      "team/one-skill/SKILL.md",
      "notes/single-skill.md",
      "!disabled-pattern",
      "npm:@acme/pi-skills",
      "git:github.com/acme/skills",
      "https://example.invalid/skills",
      "  ",
      "/opt/team-skills",
    ],
  });
  await expect(resolvedSkillPaths({})).resolves.toEqual(
    [
      resolve("/opt/team-skills"),
      join(homeDir, ".pi", "agent", "local-skills"),
      join(homeDir, "shared", "skills"),
    ].sort(),
  );
});

it("adds the moved agent dir's skills directory when PI_CODING_AGENT_DIR points elsewhere", async () => {
  const agentDir = join(homeDir, "custom-agent");
  writeSettings(agentDir, { skills: [] });
  await expect(
    resolvedSkillPaths({ PI_CODING_AGENT_DIR: agentDir }),
  ).resolves.toEqual([join(agentDir, "skills")]);
  await expect(
    resolvedSkillPaths({ PI_CODING_AGENT_DIR: "~/custom-agent" }),
  ).resolves.toEqual([join(agentDir, "skills")]);
});

it("never answers a root the contract would refuse", async () => {
  writeSettings(join(homeDir, ".pi", "agent"), {
    skills: [
      "/opt/../etc/skills",
      "/opt//skills",
      "relative/../escape",
      "/srv/skills/",
      "~/team-skills//",
    ],
  });
  await expect(resolvedSkillPaths({})).resolves.toEqual(
    [
      resolve("/etc/skills"),
      resolve("/opt/skills"),
      join(homeDir, ".pi", "agent", "escape"),
      resolve("/srv/skills"),
      join(homeDir, "team-skills"),
    ].sort(),
  );
});

function writeFile(filePath: string, content = ""): void {
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, content);
}

function writePackage(packageRoot: string, pi?: unknown): void {
  writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify(pi === undefined ? { name: "pack" } : { name: "pack", pi }),
  );
}

async function resolvedSkillRoots(): Promise<
  { path: string; shape: string; recursive: boolean }[]
> {
  const parsed = experimental_nativeRootsResolveOutputSchema.parse(
    await resolvePiNativeRoots({ homeDir, env: {} }),
  );
  return parsed.skills.map(({ path, shape, recursive }) => ({
    path,
    shape,
    recursive,
  }));
}

it("adds the skills that installed Pi packages declare, the way Pi loads them", async () => {
  const agentDir = join(homeDir, ".pi", "agent");
  const manifestPack = join(agentDir, "npm", "node_modules", "@acme", "pack");
  writePackage(manifestPack, {
    extensions: ["./index.ts"],
    skills: [
      "./plugins/acme/skills",
      "./single",
      "./notes/one.md",
      "./plugins/*/more",
      "!./plugins/acme/skills/hidden",
      "../outside",
      "./missing",
    ],
  });
  writeFile(join(manifestPack, "plugins", "acme", "skills", "a", "SKILL.md"));
  writeFile(join(manifestPack, "single", "SKILL.md"));
  writeFile(join(manifestPack, "notes", "one.md"));
  const conventionPack = join(agentDir, "git", "github.com", "acme", "pack");
  writePackage(conventionPack);
  writeFile(join(conventionPack, "skills", "b", "SKILL.md"));
  const extensionsOnly = join(agentDir, "npm", "node_modules", "ext-only");
  writePackage(extensionsOnly, { extensions: ["./index.ts"] });
  writeFile(join(extensionsOnly, "skills", "c", "SKILL.md"));
  const localPack = join(agentDir, "local-pack");
  writePackage(localPack, { video: "demo.mp4" });
  writeFile(join(localPack, "skills", "d", "SKILL.md"));
  const filtered = join(agentDir, "npm", "node_modules", "filtered");
  writePackage(filtered);
  writeFile(join(filtered, "skills", "e", "SKILL.md"));
  const paused = join(agentDir, "npm", "node_modules", "paused");
  writePackage(paused);
  writeFile(join(paused, "skills", "f", "SKILL.md"));
  writeSettings(agentDir, {
    skills: ["~/plain-skills"],
    packages: [
      "npm:@acme/pack@^1.2.0",
      "git:github.com/acme/pack@v1",
      "npm:ext-only",
      "./local-pack",
      { source: "npm:filtered", skills: [] },
      { source: "npm:paused", autoload: false },
      "npm:not-installed",
      42,
    ],
  });
  await expect(resolvedSkillRoots()).resolves.toEqual(
    [
      {
        path: join(conventionPack, "skills"),
        shape: "skills",
        recursive: true,
      },
      { path: join(localPack, "skills"), shape: "skills", recursive: true },
      {
        path: join(manifestPack, "notes", "one.md"),
        shape: "skill-file",
        recursive: false,
      },
      {
        path: join(manifestPack, "plugins", "acme", "skills"),
        shape: "skills",
        recursive: true,
      },
      { path: join(manifestPack, "single"), shape: "skill", recursive: false },
      { path: join(homeDir, "plain-skills"), shape: "skills", recursive: true },
    ].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
  );
});

it("finds a git package's checkout from each source form Pi accepts", async () => {
  const agentDir = join(homeDir, ".pi", "agent");
  const checkout = join(agentDir, "git", "github.com", "acme", "pack");
  writePackage(checkout);
  writeFile(join(checkout, "skills", "a", "SKILL.md"));
  writeFile(
    join(agentDir, "git", "github.com", "escape", "skills", "x", "SKILL.md"),
  );
  for (const source of [
    "git:github.com/acme/pack",
    "git:github.com/acme/pack@v1.0.0",
    "https://github.com/acme/pack.git",
    "ssh://git@github.com/acme/pack",
    "git:git@github.com:acme/pack@main",
  ]) {
    writeSettings(agentDir, { packages: [source] });
    await expect(resolvedSkillPaths({}), source).resolves.toEqual([
      join(checkout, "skills"),
    ]);
  }
  for (const source of [
    "git:github.com/acme/../escape",
    "git:github.com/acme%2F..%2F..%2Fescape/x",
    "github.com/acme/pack",
    "npm:../escape",
  ]) {
    writeSettings(agentDir, { packages: [source] });
    await expect(resolvedSkillPaths({}), source).resolves.toEqual([]);
  }
});
