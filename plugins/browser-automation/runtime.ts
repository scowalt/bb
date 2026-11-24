import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { outputSchema, type RunOutput } from "./contracts.js";
import { createPreview, type PreviewSource } from "./preview.js";
import {
  hostBrowsers,
  type BrowserRegistry,
  type HostBrowser,
} from "./chrome.js";
import {
  baseEnvironment,
  execute,
  OutputLimitError,
  supervise,
} from "./process.js";
import type { ResolvedRuntime } from "./runtime-pin.js";
import { experimental_sliceUtf16Head as sliceUtf16Head } from "@get-bb/plugin-sdk/host";

const frameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocol: z.literal(1),
    version: z.string(),
    pid: z.number().int().positive(),
  }),
  z.object({ type: z.literal("stdout"), data: z.string() }),
  z.object({ type: z.literal("stderr"), data: z.string() }),
  z.object({ type: z.literal("result"), value: z.string() }),
  z.object({
    type: z.literal("error"),
    kind: z.string(),
    name: z.string(),
    message: z.string(),
  }),
  z.object({
    type: z.literal("image"),
    path: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("done"),
    exitCode: z.number().int(),
    durationMs: z.number().nonnegative(),
  }),
]);

export function runtimeEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    ...baseEnvironment(),
    DEV_BROWSER_HOME: home,
    DEV_BROWSER_SOCKET: join(home, "daemon.sock"),
  };
}

export async function decodeOutput(
  stdout: string,
  home: string,
  connectionUrl: string,
  version: string,
): Promise<RunOutput> {
  const text: string[] = [];
  const images: RunOutput["images"] = [];
  let imageBytes = 0;
  let exitCode: number | null = null;
  for (const line of stdout.split("\n").filter(Boolean)) {
    if (exitCode !== null)
      throw new Error("DevBrowser emitted data after completion");
    const frame = frameSchema.parse(JSON.parse(line));
    if (frame.type === "done") exitCode = frame.exitCode;
    else if (frame.type === "hello") {
      if (frame.version !== version)
        throw new Error(
          `DevBrowser daemon reports version ${frame.version}, expected ${version}`,
        );
    } else if (frame.type === "stdout" || frame.type === "stderr")
      text.push(frame.data);
    else if (frame.type === "result") text.push(frame.value);
    else if (frame.type === "error")
      text.push(`${frame.name}: ${frame.message}`);
    else if (frame.type === "image") {
      if (images.length >= 4)
        throw new Error("At most four screenshots may be returned per script");
      const root = await realpath(join(home, "tmp"));
      const path = await realpath(frame.path);
      const rel = relative(root, path);
      if (!rel || rel.startsWith("..") || isAbsolute(rel))
        throw new Error("Screenshot escaped the session capture directory");
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 500_000)
          throw new Error("Screenshot must be a JPEG smaller than 500 KB");
        const bytes = await file.readFile();
        if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
          throw new Error("Only JPEG screenshots are supported");
        imageBytes += bytes.length;
        if (imageBytes > 500_000)
          throw new Error(
            "Combined screenshots exceed the 500 KB output budget",
          );
        images.push({
          path,
          mimeType: "image/jpeg",
          width: frame.width,
          height: frame.height,
        });
      } finally {
        await file.close();
      }
    }
  }
  if (exitCode === null)
    throw new Error("DevBrowser did not return a completion frame");
  const endpoint = new URL(connectionUrl);
  let safeText = text
    .join("\n")
    .split(connectionUrl)
    .join("[browser connection]")
    .split(home)
    .join("[session storage]");
  const pathCredential = endpoint.pathname.match(
    /^\/devtools\/browser\/([^/]+)$/,
  )?.[1];
  if (pathCredential) {
    safeText = safeText
      .split(endpoint.pathname)
      .join("[browser connection]")
      .split(pathCredential)
      .join("[credential]");
  }
  for (const value of endpoint.searchParams.values())
    if (value) safeText = safeText.split(value).join("[credential]");
  return outputSchema.parse({
    text: sliceUtf16Head(safeText, 160_000),
    images,
    exitCode,
  });
}

export interface RuntimeSession {
  run(
    script: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<RunOutput>;
  preview: PreviewSource;
  close(): Promise<void>;
}

const closeNamedPages =
  "for (const page of await browser.listPages()) if (page.name) await browser.closePage(page.name)";

export async function createRuntime(
  args: {
    runtime: ResolvedRuntime;
    dataDir: string;
    tempDir: string;
    profile?: string;
    signal: AbortSignal;
  },
  browsers: Pick<BrowserRegistry, "acquire"> = hostBrowsers,
): Promise<RuntimeSession> {
  const binary = args.runtime.binary;
  await mkdir(args.tempDir, { recursive: true, mode: 0o700 });
  const home = await mkdtemp(join(args.tempDir, "db-"));
  const env = runtimeEnvironment(home);
  const processes: ReturnType<typeof supervise>[] = [];
  let browser: HostBrowser | null = null;
  let closed = false;
  let closing: Promise<void> | null = null;
  let preview: PreviewSource | null = null;
  const stopped = new AbortController();
  let queue = Promise.resolve();
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    stopped.abort();
    preview?.close();
    const attempt = (async () => {
      const shared = browser;
      if (
        shared?.persistent &&
        processes.length > 0 &&
        processes.every((child) => child.alive())
      )
        await execute(
          binary,
          [
            "--json",
            "--connect",
            shared.connectionUrl,
            "--timeout",
            "5",
            "-e",
            closeNamedPages,
          ],
          env,
          AbortSignal.timeout(5_000),
        ).catch(() => {});
      await Promise.all(processes.map((child) => child.close()));
      await shared?.release();
      await rm(home, { recursive: true, force: true });
    })().catch((error: unknown) => {
      if (closing === attempt) closing = null;
      throw error;
    });
    closing = attempt;
    return attempt;
  };
  const startup = AbortSignal.any([args.signal, AbortSignal.timeout(30_000)]);
  async function waitForFile(path: string): Promise<string> {
    while (true) {
      startup.throwIfAborted();
      if (processes.some((child) => !child.alive()))
        throw new Error(
          "Browser runtime exited during startup; check the DevBrowser runtime dependencies.",
        );
      try {
        return await readFile(path, "utf8");
      } catch {
        await delay(25, undefined, { signal: startup });
      }
    }
  }
  try {
    browser = await browsers.acquire({
      dataDir: args.dataDir,
      tempDir: args.tempDir,
      profile: args.profile ?? null,
      signal: startup,
    });
    const url = browser.connectionUrl;
    processes.push(supervise(binary, ["daemon"], env));
    await waitForFile(join(home, "daemon.pid"));
    const run = (
      script: string,
      timeoutMs: number,
      signal: AbortSignal,
    ): Promise<RunOutput> => {
      const result = queue.then(async () => {
        const deadline = AbortSignal.any([
          signal,
          stopped.signal,
          AbortSignal.timeout(timeoutMs),
        ]);
        deadline.throwIfAborted();
        if (closed || processes.some((child) => !child.alive()))
          throw new Error("Browser session stopped; open a new session");
        try {
          const stdout = await execute(
            binary,
            [
              "--json",
              "--connect",
              url,
              "--timeout",
              String(Math.ceil(timeoutMs / 1000)),
              "--quiet-page",
              "-e",
              script,
            ],
            env,
            deadline,
          );
          const output = await decodeOutput(
            stdout,
            home,
            url,
            args.runtime.version,
          );
          if (output.exitCode === 124) await close();
          return output;
        } catch (error) {
          if (error instanceof OutputLimitError)
            return {
              text: `${error.message}, so the run was stopped. The session is still open; return or print less output.`,
              images: [],
              exitCode: 1,
            };
          await close();
          throw error;
        }
      });
      queue = result.then(
        () => {},
        () => {},
      );
      return result;
    };
    await run("await browser.listPages()", 30_000, startup);
    preview = createPreview(url);
    return { run, preview, close };
  } catch (error) {
    await close();
    throw error;
  }
}
