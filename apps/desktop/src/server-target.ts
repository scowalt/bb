import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { WindowStateKey } from "./types.js";

export const SERVER_TARGET_FILE_NAME = "server-target.json";
export const MAX_SERVER_NAME_LENGTH = 64;

export interface CustomServer {
  url: string;
  name: string | null;
}

interface CustomServerNameOptions {
  name?: string | null;
}

interface RemoveCustomServerUrlOptions {
  availableConnectServers?: readonly ConnectServerRef[];
}

export function builtinServerName(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "This Mac" : "This Computer";
}

export const BUILTIN_SERVER_NAME = builtinServerName(process.platform);

export interface ConnectServerRef {
  handle: string;
  name: string;
  url: string;
}

export type DesktopServerTarget =
  | { kind: "builtin" }
  | { kind: "connect"; server: ConnectServerRef }
  | { kind: "custom"; url: string };

export type RemoteServerTarget = Exclude<
  DesktopServerTarget,
  { kind: "builtin" }
>;

export interface ServerTargetFs {
  mkdir(
    path: string,
    options: { recursive: true },
  ): Promise<string | undefined>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
}

interface CreateServerTargetStoreArgs {
  fs?: ServerTargetFs;
  storagePath: string;
}

export interface ServerTargetStore {
  addCustomServerUrl(
    url: string,
    options?: CustomServerNameOptions,
  ): Promise<string>;
  adoptConnectServers(
    servers: readonly ConnectServerRef[],
  ): Promise<WindowStateKey[]>;
  getConnectServerName(handle: string): string | null;
  getCustomServerUrls(): string[];
  getCustomServers(): CustomServer[];
  getDefaultTarget(): DesktopServerTarget;
  getShowBuiltinServer(): boolean;
  getWindowTarget(stateKey: WindowStateKey): DesktopServerTarget | null;
  listReferencedConnectServers(): ConnectServerRef[];
  load(): Promise<void>;
  pruneWindowTargets(keep: ReadonlySet<WindowStateKey>): Promise<void>;
  refreshConnectServer(server: ConnectServerRef): Promise<boolean>;
  removeCustomServerUrl(
    url: string,
    options?: RemoveCustomServerUrlOptions,
  ): Promise<WindowStateKey[]>;
  removeWindowTarget(stateKey: WindowStateKey): Promise<void>;
  replaceCustomServerUrl(
    previousUrl: string,
    url: string,
    options?: CustomServerNameOptions,
  ): Promise<WindowStateKey[]>;
  retargetBuiltin(target: RemoteServerTarget): Promise<WindowStateKey[]>;
  setConnectServerName(handle: string, name: string | null): Promise<void>;
  setCustomServerName(url: string, name: string | null): Promise<void>;
  setDefaultTarget(target: DesktopServerTarget): Promise<void>;
  setShowBuiltinServer(show: boolean): Promise<void>;
  setWindowTarget(
    stateKey: WindowStateKey,
    target: DesktopServerTarget,
  ): Promise<void>;
}

const persistedConnectServerSchema = z.object({
  handle: z.string().min(1),
  name: z.string().min(1),
  url: z.string().min(1),
});

const persistedWindowTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("builtin") }),
  z.object({
    kind: z.literal("connect"),
    server: persistedConnectServerSchema,
  }),
  z.object({ kind: z.literal("custom"), url: z.string().min(1) }),
]);

const persistedServerTargetSchema = z.looseObject({
  showBuiltinServer: z.boolean().default(true),
  connectServer: persistedConnectServerSchema.nullable().optional(),
  customServerUrl: z.string().min(1).nullable(),
  customServerUrls: z.array(z.string().min(1)).default([]),
  target: z.enum(["builtin", "connect", "custom"]),
  customServerNames: z.record(z.string(), z.unknown()).default({}).catch({}),
  connectServerNames: z.record(z.string(), z.unknown()).default({}).catch({}),
  windowTargets: z.record(z.string(), z.unknown()).default({}).catch({}),
});

type PersistedServerTarget = z.infer<typeof persistedServerTargetSchema>;

export function normalizeServerName(rawName: string): string | null {
  const name = rawName
    .trim()
    .replace(/\s+/gu, " ")
    .slice(0, MAX_SERVER_NAME_LENGTH)
    .trimEnd();
  return name.length === 0 ? null : name;
}

const defaultFs: ServerTargetFs = {
  mkdir,
  readFile,
  writeFile,
};

export function normalizeCustomServerUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  parsed.hash = "";
  return parsed.toString().replace(/\/$/u, "");
}

export function isSameServerTarget(
  first: DesktopServerTarget,
  second: DesktopServerTarget,
): boolean {
  if (first.kind === "connect" && second.kind === "connect") {
    return (
      first.server.handle === second.server.handle &&
      first.server.name === second.server.name &&
      first.server.url === second.server.url
    );
  }
  if (first.kind === "custom" && second.kind === "custom") {
    return first.url === second.url;
  }
  return first.kind === second.kind;
}

function cloneServerTarget(target: DesktopServerTarget): DesktopServerTarget {
  return target.kind === "connect"
    ? { kind: "connect", server: { ...target.server } }
    : { ...target };
}

function compareConnectServerHandles(
  first: ConnectServerRef,
  second: ConnectServerRef,
): number {
  if (first.handle < second.handle) {
    return -1;
  }
  return first.handle > second.handle ? 1 : 0;
}

function parsePersistedServerTarget(raw: string): PersistedServerTarget | null {
  try {
    const parsedJson: unknown = JSON.parse(raw);
    const parsed = persistedServerTargetSchema.safeParse(parsedJson);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parsePersistedWindowTarget(raw: unknown): DesktopServerTarget | null {
  const parsed = persistedWindowTargetSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  if (parsed.data.kind === "custom") {
    const url = normalizeCustomServerUrl(parsed.data.url);
    return url === null ? null : { kind: "custom", url };
  }
  if (parsed.data.kind === "connect") {
    return { kind: "connect", server: { ...parsed.data.server } };
  }
  return { kind: "builtin" };
}

function resolveServerName(name: string | null | undefined): string | null {
  return name === null || name === undefined ? null : normalizeServerName(name);
}

export function createServerTargetStore(
  args: CreateServerTargetStoreArgs,
): ServerTargetStore {
  const fsImpl = args.fs ?? defaultFs;
  let customServers: CustomServer[] = [];
  let connectServerNames = new Map<string, string>();
  let defaultTarget: DesktopServerTarget = { kind: "builtin" };
  let lastConnectServer: ConnectServerRef | null = null;
  let windowTargets = new Map<WindowStateKey, DesktopServerTarget>();
  let showBuiltinServer = true;
  let persistedSettings: PersistedServerTarget | null = null;
  let pendingPersist: Promise<void> = Promise.resolve();

  function persist(): Promise<void> {
    const customServerNames = Object.fromEntries(
      customServers
        .filter((server) => server.name !== null)
        .map((server) => [server.url, server.name]),
    );
    const payload = {
      ...persistedSettings,
      showBuiltinServer: showBuiltinServer ? undefined : false,
      connectServer:
        defaultTarget.kind === "connect"
          ? { ...defaultTarget.server }
          : lastConnectServer,
      customServerUrl:
        defaultTarget.kind === "custom" ? defaultTarget.url : null,
      customServerUrls: customServers.map((server) => server.url),
      customServerNames:
        Object.keys(customServerNames).length === 0
          ? undefined
          : customServerNames,
      connectServerNames:
        connectServerNames.size === 0
          ? undefined
          : Object.fromEntries(connectServerNames),
      target: defaultTarget.kind,
      windowTargets: Object.fromEntries(windowTargets),
    };
    const data = `${JSON.stringify(payload, null, 2)}\n`;
    const write = pendingPersist.then(async () => {
      await fsImpl.mkdir(dirname(args.storagePath), { recursive: true });
      await fsImpl.writeFile(args.storagePath, data, "utf8");
    });
    pendingPersist = write.catch(() => undefined);
    return write;
  }

  function hasCustomServer(url: string): boolean {
    return customServers.some((server) => server.url === url);
  }

  function rememberServer(target: DesktopServerTarget): void {
    if (target.kind === "connect") {
      lastConnectServer = { ...target.server };
    } else if (target.kind === "custom" && !hasCustomServer(target.url)) {
      customServers.push({ url: target.url, name: null });
    }
  }

  function rewriteTargets(
    rewrite: (target: DesktopServerTarget) => DesktopServerTarget | null,
  ): WindowStateKey[] {
    defaultTarget = rewrite(defaultTarget) ?? defaultTarget;
    const rewritten: WindowStateKey[] = [];
    for (const [stateKey, target] of windowTargets) {
      const next = rewrite(target);
      if (next !== null) {
        windowTargets.set(stateKey, next);
        rewritten.push(stateKey);
      }
    }
    return rewritten;
  }

  function requireCustomServerUrl(url: string): string {
    const normalized = normalizeCustomServerUrl(url);
    if (normalized === null) {
      throw new Error("Enter a valid http(s) URL.");
    }
    return normalized;
  }

  function removedCustomServerFallback(
    availableConnectServers: readonly ConnectServerRef[],
  ): DesktopServerTarget {
    if (showBuiltinServer) {
      return { kind: "builtin" };
    }
    const firstCustomServer = customServers[0];
    if (firstCustomServer !== undefined) {
      return { kind: "custom", url: firstCustomServer.url };
    }
    const connectServer =
      lastConnectServer ??
      [...availableConnectServers].sort(compareConnectServerHandles)[0] ??
      null;
    if (connectServer !== null) {
      return { kind: "connect", server: { ...connectServer } };
    }
    return { kind: "builtin" };
  }

  return {
    async addCustomServerUrl(url, options = {}) {
      const normalized = requireCustomServerUrl(url);
      const existing = customServers.find(
        (server) => server.url === normalized,
      );
      if (existing === undefined) {
        customServers.push({
          url: normalized,
          name: resolveServerName(options.name),
        });
      } else if (options.name !== undefined) {
        existing.name = resolveServerName(options.name);
      } else {
        return normalized;
      }
      await persist();
      return normalized;
    },
    async adoptConnectServers(servers) {
      const serversByUrl = new Map<string, ConnectServerRef>();
      for (const server of servers) {
        const url = normalizeCustomServerUrl(server.url);
        if (url !== null) serversByUrl.set(url, server);
      }
      const remaining = customServers.filter(
        (server) => !serversByUrl.has(server.url),
      );
      if (remaining.length === customServers.length) {
        return [];
      }
      for (const custom of customServers) {
        const server = serversByUrl.get(custom.url);
        if (
          server !== undefined &&
          custom.name !== null &&
          !connectServerNames.has(server.handle)
        ) {
          connectServerNames.set(server.handle, custom.name);
        }
      }
      customServers = remaining;
      const adopted = rewriteTargets((target) => {
        if (target.kind !== "custom") {
          return null;
        }
        const server = serversByUrl.get(target.url);
        return server === undefined
          ? null
          : { kind: "connect", server: { ...server } };
      });
      await persist();
      return adopted;
    },
    getConnectServerName(handle) {
      return connectServerNames.get(handle) ?? null;
    },
    getCustomServerUrls() {
      return customServers.map((server) => server.url);
    },
    getCustomServers() {
      return customServers.map((server) => ({ ...server }));
    },
    getDefaultTarget() {
      return cloneServerTarget(defaultTarget);
    },
    getShowBuiltinServer() {
      return showBuiltinServer;
    },
    getWindowTarget(stateKey) {
      const target = windowTargets.get(stateKey);
      return target === undefined ? null : cloneServerTarget(target);
    },
    listReferencedConnectServers() {
      const servers = new Map<string, ConnectServerRef>();
      for (const target of [defaultTarget, ...windowTargets.values()]) {
        if (target.kind === "connect" && !servers.has(target.server.handle)) {
          servers.set(target.server.handle, { ...target.server });
        }
      }
      if (
        lastConnectServer !== null &&
        !servers.has(lastConnectServer.handle)
      ) {
        servers.set(lastConnectServer.handle, { ...lastConnectServer });
      }
      return [...servers.values()];
    },
    async load() {
      let persisted: PersistedServerTarget | null = null;
      try {
        persisted = parsePersistedServerTarget(
          await fsImpl.readFile(args.storagePath, "utf8"),
        );
      } catch {
        persisted = null;
      }
      persistedSettings = persisted;
      showBuiltinServer = persisted?.showBuiltinServer ?? true;
      customServers = [];
      connectServerNames = new Map();
      defaultTarget = { kind: "builtin" };
      lastConnectServer = null;
      windowTargets = new Map();
      if (persisted === null) {
        return;
      }
      lastConnectServer = persisted.connectServer ?? null;
      const customServerUrl =
        persisted.customServerUrl === null
          ? null
          : normalizeCustomServerUrl(persisted.customServerUrl);
      const customServerUrls = [
        ...new Set(
          [
            ...persisted.customServerUrls,
            ...(customServerUrl === null ? [] : [customServerUrl]),
          ]
            .map(normalizeCustomServerUrl)
            .filter((url): url is string => url !== null),
        ),
      ];
      const names = new Map(
        Object.entries(persisted.customServerNames).flatMap(
          ([rawUrl, rawName]) => {
            const url = normalizeCustomServerUrl(rawUrl);
            const name =
              typeof rawName === "string" ? normalizeServerName(rawName) : null;
            return url === null || name === null ? [] : [[url, name] as const];
          },
        ),
      );
      customServers = customServerUrls.map((url) => ({
        url,
        name: names.get(url) ?? null,
      }));
      connectServerNames = new Map(
        Object.entries(persisted.connectServerNames).flatMap(
          ([handle, rawName]) => {
            const name =
              typeof rawName === "string" ? normalizeServerName(rawName) : null;
            return handle.length === 0 || name === null
              ? []
              : [[handle, name] as const];
          },
        ),
      );
      if (persisted.target === "custom" && customServerUrl !== null) {
        defaultTarget = { kind: "custom", url: customServerUrl };
      } else if (persisted.target === "connect" && lastConnectServer !== null) {
        defaultTarget = { kind: "connect", server: { ...lastConnectServer } };
      }
      for (const [stateKey, raw] of Object.entries(persisted.windowTargets)) {
        const target = parsePersistedWindowTarget(raw);
        if (stateKey.length === 0 || target === null) {
          continue;
        }
        if (target.kind === "custom" && !hasCustomServer(target.url)) {
          customServers.push({ url: target.url, name: null });
        }
        windowTargets.set(stateKey, target);
      }
    },
    async pruneWindowTargets(keep) {
      let pruned = false;
      for (const stateKey of [...windowTargets.keys()]) {
        if (!keep.has(stateKey)) {
          windowTargets.delete(stateKey);
          pruned = true;
        }
      }
      if (pruned) {
        await persist();
      }
    },
    async refreshConnectServer(server) {
      const isStale = (current: ConnectServerRef): boolean =>
        current.handle === server.handle &&
        (current.name !== server.name || current.url !== server.url);
      const lastStale =
        lastConnectServer !== null && isStale(lastConnectServer);
      const defaultStale =
        defaultTarget.kind === "connect" && isStale(defaultTarget.server);
      if (lastStale) {
        lastConnectServer = { ...server };
      }
      const refreshedWindows = rewriteTargets((target) =>
        target.kind === "connect" && isStale(target.server)
          ? { kind: "connect", server: { ...server } }
          : null,
      );
      if (!lastStale && !defaultStale && refreshedWindows.length === 0) {
        return false;
      }
      await persist();
      return true;
    },
    async removeCustomServerUrl(url, options = {}) {
      customServers = customServers.filter((server) => server.url !== url);
      const fallback = removedCustomServerFallback(
        options.availableConnectServers ?? [],
      );
      const defaultMoved =
        defaultTarget.kind === "custom" && defaultTarget.url === url;
      const moved = rewriteTargets((target) =>
        target.kind === "custom" && target.url === url
          ? cloneServerTarget(fallback)
          : null,
      );
      if (defaultMoved || moved.length > 0) {
        rememberServer(fallback);
      }
      await persist();
      return moved;
    },
    async removeWindowTarget(stateKey) {
      if (windowTargets.delete(stateKey)) {
        await persist();
      }
    },
    async replaceCustomServerUrl(previousUrl, url, options = {}) {
      const normalized = requireCustomServerUrl(url);
      const removedIndex = customServers.findIndex(
        (server) => server.url === previousUrl,
      );
      const carriedName = customServers[removedIndex]?.name ?? null;
      customServers = customServers.filter(
        (server) => server.url !== previousUrl,
      );
      if (!hasCustomServer(normalized)) {
        customServers.splice(
          removedIndex === -1 ? customServers.length : removedIndex,
          0,
          {
            url: normalized,
            name:
              options.name === undefined
                ? carriedName
                : resolveServerName(options.name),
          },
        );
      }
      const moved = rewriteTargets((target) =>
        target.kind === "custom" && target.url === previousUrl
          ? { kind: "custom", url: normalized }
          : null,
      );
      await persist();
      return moved;
    },
    async retargetBuiltin(target) {
      rememberServer(target);
      const moved = rewriteTargets((current) =>
        current.kind === "builtin" ? cloneServerTarget(target) : null,
      );
      await persist();
      return moved;
    },
    async setConnectServerName(handle, name) {
      const normalized = resolveServerName(name);
      if (normalized === null) {
        connectServerNames.delete(handle);
      } else {
        connectServerNames.set(handle, normalized);
      }
      await persist();
    },
    async setCustomServerName(url, name) {
      const server = customServers.find((saved) => saved.url === url);
      if (server === undefined) {
        throw new Error("That server is no longer saved.");
      }
      server.name = resolveServerName(name);
      await persist();
    },
    async setDefaultTarget(target) {
      if (isSameServerTarget(defaultTarget, target)) {
        return;
      }
      defaultTarget = cloneServerTarget(target);
      rememberServer(target);
      await persist();
    },
    async setShowBuiltinServer(show) {
      showBuiltinServer = show;
      await persist();
    },
    async setWindowTarget(stateKey, target) {
      const current = windowTargets.get(stateKey);
      if (current !== undefined && isSameServerTarget(current, target)) {
        return;
      }
      windowTargets.set(stateKey, cloneServerTarget(target));
      rememberServer(target);
      await persist();
    },
  };
}
