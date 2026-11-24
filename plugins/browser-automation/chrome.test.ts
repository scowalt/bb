import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBrowserRegistry,
  userAgentFor,
  type BrowserLauncher,
} from "./chrome.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function fakeLauncher(pages: string[] = []) {
  const log: string[] = [];
  const launches: { userDataDir: string; urls: string[] }[] = [];
  let count = 0;
  const launcher: BrowserLauncher = {
    async launch({ userDataDir, urls }) {
      const id = ++count;
      launches.push({ userDataDir, urls });
      log.push(`launch ${id}`);
      let exit!: () => void;
      const exited = new Promise<void>((resolve) => (exit = resolve));
      running.set(`ws://127.0.0.1:1/devtools/browser/${id}`, () => {
        log.push(`exit ${id}`);
        exit();
      });
      return {
        connectionUrl: `ws://127.0.0.1:1/devtools/browser/${id}`,
        exited,
        async stop() {
          log.push(`stop ${id}`);
          exit();
        },
      };
    },
    async call(connectionUrl, method) {
      log.push(`${method} ${connectionUrl.split("/").pop()}`);
      if (method === "Target.getTargets")
        return {
          targetInfos: [
            ...pages.map((url) => ({ type: "page", url })),
            { type: "service_worker", url: "https://sw.test/" },
          ],
        };
      if (method === "Browser.close") running.get(connectionUrl)?.();
      return {};
    },
  };
  const running = new Map<string, () => void>();
  return { launcher, log, launches };
}

async function dataDir() {
  const dir = await mkdtemp(join(tmpdir(), "bb-chrome-test-"));
  dirs.push(dir);
  return dir;
}

const never = new AbortController().signal;

describe("host browser registry", () => {
  it("shares one browser per profile and closes it gracefully after the last release", async () => {
    const fake = fakeLauncher(["https://mail.test/inbox", "about:blank"]);
    const registry = createBrowserRegistry(fake.launcher);
    const dir = await dataDir();
    const args = { dataDir: dir, tempDir: join(dir, "tmp"), signal: never };
    const [first, second] = await Promise.all([
      registry.acquire({ ...args, profile: "default" }),
      registry.acquire({ ...args, profile: "default" }),
    ]);
    const other = await registry.acquire({ ...args, profile: "work" });
    expect(second.connectionUrl).toBe(first.connectionUrl);
    expect(other.connectionUrl).not.toBe(first.connectionUrl);
    expect(fake.launches.map((launch) => launch.userDataDir)).toEqual([
      join(dir, "profiles", "default"),
      join(dir, "profiles", "work"),
    ]);
    await first.release();
    await first.release();
    expect(fake.log).not.toContain("Browser.close 1");
    await second.release();
    expect(fake.log.slice(2)).toEqual([
      "Target.getTargets 1",
      "Browser.close 1",
      "exit 1",
      "stop 1",
    ]);
    expect(
      JSON.parse(
        await readFile(
          join(dir, "profiles", "default", "bb-tabs.json"),
          "utf8",
        ),
      ),
    ).toEqual(["https://mail.test/inbox"]);
    await other.release();
  });

  it("reopens saved tabs on the next launch, after the previous browser has exited", async () => {
    const fake = fakeLauncher(["https://mail.test/inbox"]);
    const registry = createBrowserRegistry(fake.launcher);
    const dir = await dataDir();
    const args = {
      dataDir: dir,
      tempDir: join(dir, "tmp"),
      profile: "default",
      signal: never,
    };
    const first = await registry.acquire(args);
    const releasing = first.release();
    const next = await registry.acquire(args);
    await releasing;
    expect(fake.log.indexOf("stop 1")).toBeLessThan(
      fake.log.indexOf("launch 2"),
    );
    expect(next.connectionUrl).not.toBe(first.connectionUrl);
    expect(fake.launches[1]!.urls).toEqual(["https://mail.test/inbox"]);
    await next.release();
    await writeFile(
      join(dir, "profiles", "default", "bb-tabs.json"),
      JSON.stringify(["chrome://settings", "https://a.test/", 3]),
    );
    const corrupt = await registry.acquire(args);
    expect(fake.launches[2]!.urls).toEqual([]);
    await corrupt.release();
  });

  it("gives each ephemeral browser its own profile and deletes it on release", async () => {
    const fake = fakeLauncher(["https://a.test/"]);
    const registry = createBrowserRegistry(fake.launcher);
    const dir = await dataDir();
    const args = {
      dataDir: dir,
      tempDir: join(dir, "tmp"),
      profile: null,
      signal: never,
    };
    const [a, b] = await Promise.all([
      registry.acquire(args),
      registry.acquire(args),
    ]);
    expect(a.connectionUrl).not.toBe(b.connectionUrl);
    expect(a.persistent).toBe(false);
    expect(fake.launches.every((launch) => launch.urls.length === 0)).toBe(
      true,
    );
    expect(await readdir(join(dir, "tmp"))).toHaveLength(2);
    await a.release();
    await b.release();
    expect(fake.log).not.toContain("Target.getTargets 1");
    expect(fake.log).toContain("Browser.close 1");
    expect(await readdir(join(dir, "tmp"))).toHaveLength(0);
  });

  it("stops a browser that ignores Browser.close after the grace period", async () => {
    const fake = fakeLauncher();
    const launcher: BrowserLauncher = {
      ...fake.launcher,
      call: async (url, method) =>
        method === "Browser.close" ? {} : fake.launcher.call(url, method),
    };
    const registry = createBrowserRegistry(launcher, { closeGraceMs: 20 });
    const dir = await dataDir();
    const browser = await registry.acquire({
      dataDir: dir,
      tempDir: join(dir, "tmp"),
      profile: "default",
      signal: never,
    });
    await browser.release();
    expect(fake.log).toEqual(["launch 1", "Target.getTargets 1", "stop 1"]);
  });

  it("relaunches a profile whose browser exited on its own", async () => {
    const fake = fakeLauncher();
    const registry = createBrowserRegistry(fake.launcher);
    const dir = await dataDir();
    const args = {
      dataDir: dir,
      tempDir: join(dir, "tmp"),
      profile: "default",
      signal: never,
    };
    const first = await registry.acquire(args);
    await fake.launcher.call(first.connectionUrl, "Browser.close");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await registry.acquire(args);
    expect(second.connectionUrl).not.toBe(first.connectionUrl);
    await first.release();
    await second.release();
  });

  it("lets a waiting acquirer cancel without leaking a reference", async () => {
    const fake = fakeLauncher();
    let launched!: () => void;
    const gate = new Promise<void>((resolve) => (launched = resolve));
    const launcher: BrowserLauncher = {
      ...fake.launcher,
      launch: async (args) => {
        await gate;
        return fake.launcher.launch(args);
      },
    };
    const registry = createBrowserRegistry(launcher);
    const dir = await dataDir();
    const args = {
      dataDir: dir,
      tempDir: join(dir, "tmp"),
      profile: "default",
    };
    const controller = new AbortController();
    const cancelled = registry.acquire({ ...args, signal: controller.signal });
    const kept = registry.acquire({ ...args, signal: never });
    controller.abort();
    await expect(cancelled).rejects.toThrow("cancelled");
    launched();
    const browser = await kept;
    expect(fake.log).toEqual(["launch 1"]);
    await browser.release();
    expect(fake.log).toContain("Browser.close 1");
  });
});

describe("user agent", () => {
  it("reports a regular Chrome of the installed major version", () => {
    expect(userAgentFor("Google Chrome 158.0.8127.88 \n")).toMatch(
      /Chrome\/158\.0\.0\.0 Safari\/537\.36$/,
    );
    expect(userAgentFor("Google Chrome 158.0.8127.88")).not.toContain(
      "Headless",
    );
    expect(userAgentFor("garbage")).toBeNull();
  });
});
