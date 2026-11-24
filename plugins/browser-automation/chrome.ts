import { experimental_hostToolchain as hostToolchain } from "@get-bb/plugin-sdk/process";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { baseEnvironment, execute, supervise } from "./process.js";

export interface ChromeProcess {
  readonly connectionUrl: string;
  readonly exited: Promise<void>;
  stop(): Promise<void>;
}

export interface BrowserLauncher {
  launch(args: {
    dataDir: string;
    userDataDir: string;
    urls: string[];
    scale: number;
    signal: AbortSignal;
  }): Promise<ChromeProcess>;
  call(connectionUrl: string, method: string): Promise<unknown>;
}

export interface HostBrowser {
  readonly connectionUrl: string;
  readonly persistent: boolean;
  release(): Promise<void>;
}

export type BrowserRegistry = ReturnType<typeof createBrowserRegistry>;

const tabsFile = "bb-tabs.json";
const maxSavedTabs = 20;
const launchTimeoutMs = 30_000;
const profileScale = 2;
const targetsSchema = z.object({
  targetInfos: z.array(z.object({ type: z.string(), url: z.string() })),
});
const restorable = (url: string) => /^https?:\/\//i.test(url);

async function savedTabs(userDataDir: string): Promise<string[]> {
  try {
    const urls = z
      .array(z.string())
      .parse(JSON.parse(await readFile(join(userDataDir, tabsFile), "utf8")));
    return urls.filter(restorable).slice(0, maxSavedTabs);
  } catch {
    return [];
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(new Error("Browser launch cancelled or timed out"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    promise
      .finally(() => signal.removeEventListener("abort", abort))
      .then(resolve, reject);
  });
}

export function createBrowserRegistry(
  launcher: BrowserLauncher,
  timing = { closeGraceMs: 5_000 },
) {
  interface Entry {
    refs: number;
    persistent: boolean;
    userDataDir: string;
    launched: Promise<ChromeProcess>;
  }
  const profiles = new Map<string, Entry>();
  const closing = new Map<string, Promise<void>>();

  async function saveTabs(chrome: ChromeProcess, userDataDir: string) {
    const { targetInfos } = targetsSchema.parse(
      await launcher.call(chrome.connectionUrl, "Target.getTargets"),
    );
    const urls = targetInfos
      .filter((target) => target.type === "page" && restorable(target.url))
      .map((target) => target.url)
      .slice(0, maxSavedTabs);
    await writeFile(join(userDataDir, tabsFile), JSON.stringify(urls), {
      mode: 0o600,
    });
  }

  async function shutdown(entry: Entry) {
    const chrome = await entry.launched.catch(() => null);
    if (chrome) {
      if (entry.persistent)
        await saveTabs(chrome, entry.userDataDir).catch(() => {});
      await launcher
        .call(chrome.connectionUrl, "Browser.close")
        .catch(() => {});
      const grace = new AbortController();
      await Promise.race([
        chrome.exited,
        delay(timing.closeGraceMs, undefined, { signal: grace.signal }).catch(
          () => {},
        ),
      ]);
      grace.abort();
      await chrome.stop();
    }
    if (!entry.persistent)
      await rm(entry.userDataDir, { recursive: true, force: true });
  }

  function start(dataDir: string, userDataDir: string, persistent: boolean) {
    const previous = closing.get(userDataDir) ?? Promise.resolve();
    const entry: Entry = {
      refs: 0,
      persistent,
      userDataDir,
      launched: previous.then(async () => {
        await mkdir(userDataDir, { recursive: true, mode: 0o700 });
        return launcher.launch({
          dataDir,
          userDataDir,
          urls: persistent ? await savedTabs(userDataDir) : [],
          scale: persistent ? profileScale : 1,
          signal: AbortSignal.timeout(launchTimeoutMs),
        });
      }),
    };
    const forget = () => {
      if (profiles.get(userDataDir) === entry) profiles.delete(userDataDir);
    };
    entry.launched.then((chrome) => chrome.exited.then(forget), forget);
    if (persistent) profiles.set(userDataDir, entry);
    return entry;
  }

  function releaser(entry: Entry) {
    let released: Promise<void> | null = null;
    return () => {
      released ??= (async () => {
        entry.refs--;
        if (entry.refs > 0) return;
        if (profiles.get(entry.userDataDir) === entry)
          profiles.delete(entry.userDataDir);
        const work = shutdown(entry);
        const settled = work.catch(() => {});
        closing.set(entry.userDataDir, settled);
        try {
          await work;
        } finally {
          if (closing.get(entry.userDataDir) === settled)
            closing.delete(entry.userDataDir);
        }
      })();
      return released;
    };
  }

  return {
    async acquire(args: {
      dataDir: string;
      tempDir: string;
      profile: string | null;
      signal: AbortSignal;
    }): Promise<HostBrowser> {
      let entry: Entry;
      if (args.profile === null) {
        await mkdir(args.tempDir, { recursive: true, mode: 0o700 });
        entry = start(
          args.dataDir,
          await mkdtemp(join(args.tempDir, "chrome-")),
          false,
        );
      } else {
        const userDataDir = join(args.dataDir, "profiles", args.profile);
        entry =
          profiles.get(userDataDir) ?? start(args.dataDir, userDataDir, true);
      }
      entry.refs++;
      const release = releaser(entry);
      try {
        const chrome = await abortable(entry.launched, args.signal);
        return {
          connectionUrl: chrome.connectionUrl,
          persistent: entry.persistent,
          release,
        };
      } catch (error) {
        await release().catch(() => {});
        throw error;
      }
    },
  };
}

async function findChrome(dataDir: string): Promise<string> {
  const candidates = [
    join(dataDir, "runtime", "chrome"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const name of [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ]) {
    const executable = hostToolchain.resolve(name);
    if (executable !== null) candidates.push(executable);
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {}
  }
  throw new Error(
    "Install Chrome/Chromium on this host or link its executable at the plugin data runtime/chrome path.",
  );
}

export function userAgentFor(versionOutput: string): string | null {
  const major = versionOutput.match(/\b(\d+)\.\d+\.\d+\.\d+\b/)?.[1];
  if (major === undefined) return null;
  const platform =
    process.platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : `X11; Linux ${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

const userAgents = new Map<string, Promise<string | null>>();
function userAgent(chrome: string): Promise<string | null> {
  let agent = userAgents.get(chrome);
  if (!agent) {
    agent = execute(
      chrome,
      ["--version"],
      baseEnvironment(),
      AbortSignal.timeout(10_000),
    ).then(userAgentFor, () => null);
    userAgents.set(chrome, agent);
  }
  return agent;
}

const portFileSchema = z.tuple([
  z.coerce.number().int().min(1).max(65535),
  z.string().regex(/^\/devtools\/browser\/[a-zA-Z0-9-]+$/),
]);
const responseSchema = z.object({
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

export const chromeLauncher: BrowserLauncher = {
  async launch({ dataDir, userDataDir, urls, scale, signal }) {
    const chrome = await findChrome(dataDir);
    const agent = await userAgent(chrome);
    const portFile = join(userDataDir, "DevToolsActivePort");
    await rm(portFile, { force: true });
    const child = supervise(
      chrome,
      [
        "--headless=new",
        "--no-sandbox",
        "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--password-store=basic",
        "--use-mock-keychain",
        "--window-size=1280,720",
        `--force-device-scale-factor=${scale}`,
        ...(agent === null ? [] : [`--user-agent=${agent}`]),
        ...(urls.length > 0 ? urls : ["about:blank"]),
      ],
      baseEnvironment(),
    );
    try {
      while (true) {
        signal.throwIfAborted();
        if (!child.alive())
          throw new Error(
            "Chrome exited during startup; check its installation, or close another Chrome using the same profile.",
          );
        const parsed = portFileSchema.safeParse(
          (await readFile(portFile, "utf8").catch(() => "")).trim().split("\n"),
        );
        if (parsed.success)
          return {
            connectionUrl: `ws://127.0.0.1:${parsed.data[0]}${parsed.data[1]}`,
            exited: child.exited,
            stop: child.close,
          };
        await delay(25, undefined, { signal });
      }
    } catch (error) {
      await child.close();
      throw error;
    }
  },
  async call(connectionUrl, method) {
    const socket = new WebSocket(connectionUrl);
    try {
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`${method} timed out`)),
          5_000,
        );
        const fail = () => {
          clearTimeout(timeout);
          reject(new Error("Browser connection closed"));
        };
        socket.addEventListener("open", () =>
          socket.send(JSON.stringify({ id: 1, method, params: {} })),
        );
        socket.addEventListener("message", (event) => {
          const message = responseSchema.parse(JSON.parse(String(event.data)));
          if (message.id !== 1) return;
          clearTimeout(timeout);
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        });
        socket.addEventListener("error", fail);
        socket.addEventListener("close", fail);
      });
    } finally {
      socket.close();
    }
  },
};

export const hostBrowsers = createBrowserRegistry(chromeLauncher);
