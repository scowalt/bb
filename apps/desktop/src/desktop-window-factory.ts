import { nextZoomFactor } from "./desktop-zoom.js";
import type { BbDesktopZoomCommand } from "@bb/desktop-contract";
import type { BrowserWindowConstructorOptions, Event } from "electron";
import {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  PRIMARY_WINDOW_STATE_KEY,
  type DisplayWorkArea,
  type WindowBounds,
  type PersistedWindowStateEntry,
  type WindowStateKey,
} from "./types.js";
import {
  createPersistedWindowStateEntry,
  readPersistedWindowStateFile,
  restoreBrowserWindowState,
  writePersistedWindowStateFile,
  type StatefulBrowserWindow,
} from "./window-state.js";
import { resolveDesktopExternalUrl } from "./desktop-external-url.js";
import type { DesktopContextMenuWebContents } from "./desktop-context-menu.js";
import {
  MACOS_TRAFFIC_LIGHT_INSET_PX,
  MACOS_TRAFFIC_LIGHT_SIZE_PX,
  MACOS_TRAFFIC_LIGHT_TOP_INSET_PX,
} from "@bb/desktop-contract";
import { BB_DESKTOP_ZOOM_CHANGED_CHANNEL } from "./desktop-update-ipc.js";

type DesktopWindowIcon = BrowserWindowConstructorOptions["icon"];

const MACOS_TRAFFIC_LIGHT_POSITION = {
  x: MACOS_TRAFFIC_LIGHT_INSET_PX,
  y: MACOS_TRAFFIC_LIGHT_TOP_INSET_PX,
};

function getMacosTrafficLightPosition(zoomFactor: number) {
  const halfSize = MACOS_TRAFFIC_LIGHT_SIZE_PX / 2;
  return {
    x: MACOS_TRAFFIC_LIGHT_INSET_PX,
    y: Math.round(
      (MACOS_TRAFFIC_LIGHT_TOP_INSET_PX + halfSize) * zoomFactor - halfSize,
    ),
  };
}

interface DesktopWindowOpenDetails {
  url: string;
}

interface DesktopWindowOpenHandlerResult {
  action: "deny";
}

export type DesktopWindowOpenHandler = (
  details: DesktopWindowOpenDetails,
) => DesktopWindowOpenHandlerResult;

export interface DesktopWindowWebContents extends DesktopContextMenuWebContents {
  id: number;
  on(...args: Parameters<DesktopContextMenuWebContents["on"]>): void;
  on(
    eventName: "did-change-theme-color",
    listener: (event: Event, color: string | null) => void,
  ): void;
  setWindowOpenHandler(handler: DesktopWindowOpenHandler): void;
  getZoomFactor(): number;
  setZoomFactor(factor: number): void;
  ipc: { on(channel: string, listener: () => void): void };
  on(eventName: "dom-ready", listener: () => void): void;
}

export interface DesktopBrowserWindow extends StatefulBrowserWindow {
  readonly id: number;
  focus(): void;
  isMinimized(): boolean;
  loadURL(url: string): Promise<void>;
  maximize(): void;
  on(
    eventName:
      | "close"
      | "closed"
      | "enter-full-screen"
      | "leave-full-screen"
      | "move"
      | "resize"
      | "maximize"
      | "unmaximize",
    listener: () => void,
  ): void;
  once(eventName: "ready-to-show", listener: () => void): void;
  restore(): void;
  setFullScreen(isFullScreen: boolean): void;
  setBackgroundColor(color: string): void;
  setWindowButtonPosition(position: { x: number; y: number }): void;
  show(): void;
  webContents: DesktopWindowWebContents;
}

export interface DesktopBrowserWindowCreator {
  create(options: BrowserWindowConstructorOptions): DesktopBrowserWindow;
}

interface OpenExternalUrlArgs {
  url: string;
}

interface CreateDesktopWindowFactoryArgs {
  browserWindowCreator: DesktopBrowserWindowCreator;
  createWindowStateKey(): WindowStateKey;
  displayWorkAreas: DisplayWorkArea[] | null;
  icon: DesktopWindowIcon;
  isLinuxTransparent: boolean;
  isMac: boolean;
  isLinuxFrameless: boolean;
  isQuitting(): boolean;
  shouldUseDarkColors(): boolean;
  openExternalUrl(args: OpenExternalUrlArgs): void;
  preloadPath: string;
  userDataPath: string;
}

interface CreateDesktopWindowArgs {
  stateKey: WindowStateKey | null;
}

export interface CreatedDesktopWindow {
  browserWindow: DesktopBrowserWindow;
  stateKey: WindowStateKey;
}

export interface DesktopWindowFactory {
  createWindow(args: CreateDesktopWindowArgs): Promise<CreatedDesktopWindow>;
  focusFirstWindow(): boolean;
  hasOpenWindows(): boolean;
  loadUrl(args: LoadUrlIntoWindowArgs): Promise<void>;
  persistOpenWindows(): Promise<void>;
  zoom(webContentsId: number, command: BbDesktopZoomCommand): boolean;
  restoreSavedWindows(): Promise<CreatedDesktopWindow[]>;
}

interface ResolveWindowStateKeyArgs {
  activeWindows: Map<WindowStateKey, DesktopBrowserWindow>;
  createWindowStateKey(): WindowStateKey;
  pendingStateKeys: Set<WindowStateKey>;
  requestedStateKey: WindowStateKey | null;
}

interface LoadUrlIntoWindowArgs {
  browserWindow: DesktopBrowserWindow;
  url: string;
}

interface CreateWindowOptionsArgs {
  backgroundColor: string;
  bounds: WindowBounds;
  icon: DesktopWindowIcon;
  isLinuxTransparent: boolean;
  isMac: boolean;
  isLinuxFrameless: boolean;
  preloadPath: string;
}

function resolveWindowStateKey(
  args: ResolveWindowStateKeyArgs,
): WindowStateKey {
  if (args.requestedStateKey !== null) {
    return args.requestedStateKey;
  }
  if (
    !args.activeWindows.has(PRIMARY_WINDOW_STATE_KEY) &&
    !args.pendingStateKeys.has(PRIMARY_WINDOW_STATE_KEY)
  ) {
    return PRIMARY_WINDOW_STATE_KEY;
  }

  let stateKey = args.createWindowStateKey();
  while (
    args.activeWindows.has(stateKey) ||
    args.pendingStateKeys.has(stateKey)
  ) {
    stateKey = args.createWindowStateKey();
  }
  return stateKey;
}

function createWindowOptions(
  args: CreateWindowOptionsArgs,
): BrowserWindowConstructorOptions {
  return {
    backgroundColor: args.backgroundColor,
    ...(args.isLinuxFrameless ? { frame: false } : {}),
    ...(args.isLinuxTransparent
      ? { backgroundColor: "#00000000", transparent: true }
      : {}),
    ...(args.isMac
      ? {
          frame: false,
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: MACOS_TRAFFIC_LIGHT_POSITION,
        }
      : { autoHideMenuBar: true }),
    height: args.bounds.height,
    icon: args.icon,
    minHeight: MIN_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    show: false,
    title: "bb",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: args.preloadPath,
      sandbox: true,
      spellcheck: true,
    },
    width: args.bounds.width,
    x: args.bounds.x,
    y: args.bounds.y,
  };
}

async function loadUrlIntoWindow(args: LoadUrlIntoWindowArgs): Promise<void> {
  try {
    await args.browserWindow.loadURL(args.url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ERR_ABORTED")) {
      return;
    }
    throw error;
  }
}

export function createDesktopWindowFactory(
  args: CreateDesktopWindowFactoryArgs,
): DesktopWindowFactory {
  const activeWindows = new Map<WindowStateKey, DesktopBrowserWindow>();
  const pendingStateKeys = new Set<WindowStateKey>();
  let zoomFactor: number | null = null;
  let pendingWrite = Promise.resolve();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSaveTimer(): void {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = null;
  }

  function snapshotWindows(): PersistedWindowStateEntry[] {
    return [...activeWindows]
      .filter(([, window]) => !window.isDestroyed())
      .map(([stateKey, browserWindow]) =>
        createPersistedWindowStateEntry({ browserWindow, stateKey }),
      );
  }

  function settledWrite(): Promise<void> {
    return pendingWrite.catch(() => {});
  }

  function writeEntries(windows: PersistedWindowStateEntry[]): Promise<void> {
    pendingWrite = settledWrite().then(() =>
      writePersistedWindowStateFile({
        file: { windows, zoomFactor: zoomFactor ?? 1 },
        userDataPath: args.userDataPath,
      }),
    );
    return pendingWrite;
  }

  function applyZoomFactor(browserWindow: DesktopBrowserWindow): void {
    browserWindow.webContents.setZoomFactor(zoomFactor ?? 1);
  }

  function scheduleSave(): void {
    if (args.isQuitting()) return;
    clearSaveTimer();
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persistOpenWindows().catch((error) =>
        console.error("Could not save desktop window state", error),
      );
    }, 500);
  }

  async function createWindow(
    createArgs: CreateDesktopWindowArgs,
  ): Promise<CreatedDesktopWindow> {
    const stateKey = resolveWindowStateKey({
      activeWindows,
      createWindowStateKey: args.createWindowStateKey,
      pendingStateKeys,
      requestedStateKey: createArgs.stateKey,
    });
    pendingStateKeys.add(stateKey);

    try {
      await settledWrite();
      const savedState = await readPersistedWindowStateFile({
        userDataPath: args.userDataPath,
      });
      zoomFactor ??= savedState.zoomFactor;
      const restoredState = restoreBrowserWindowState({
        displayWorkAreas: args.displayWorkAreas,
        stateKey,
        windows: savedState.windows,
      });
      const browserWindow = args.browserWindowCreator.create(
        createWindowOptions({
          backgroundColor: args.shouldUseDarkColors() ? "#151515" : "#ffffff",
          bounds: restoredState.bounds,
          icon: args.icon,
          isLinuxTransparent: args.isLinuxTransparent,
          isMac: args.isMac,
          isLinuxFrameless: args.isLinuxFrameless,
          preloadPath: args.preloadPath,
        }),
      );
      if (!args.isLinuxTransparent) {
        browserWindow.webContents.on(
          "did-change-theme-color",
          (_event, color) => {
            if (color !== null) {
              browserWindow.setBackgroundColor(color);
            }
          },
        );
      }
      if (args.isMac) {
        browserWindow.webContents.ipc.on(BB_DESKTOP_ZOOM_CHANGED_CHANNEL, () =>
          browserWindow.setWindowButtonPosition(
            getMacosTrafficLightPosition(
              browserWindow.webContents.getZoomFactor(),
            ),
          ),
        );
      }
      browserWindow.webContents.session.setSpellCheckerEnabled(true);

      activeWindows.set(stateKey, browserWindow);

      if (restoredState.isMaximized) {
        browserWindow.maximize();
      }
      if (restoredState.isFullScreen) {
        browserWindow.setFullScreen(true);
      }

      browserWindow.once("ready-to-show", () => {
        browserWindow.show();
      });
      let closing = false;
      const saveOnChange = () => {
        if (!closing) scheduleSave();
      };
      for (const event of [
        "move",
        "resize",
        "maximize",
        "unmaximize",
        "enter-full-screen",
        "leave-full-screen",
      ] as const) {
        browserWindow.on(event, saveOnChange);
      }
      browserWindow.on("close", () => {
        closing = true;
        if (args.isQuitting()) return;
        clearSaveTimer();
        const entries = snapshotWindows().filter(
          (entry) => entry.stateKey !== stateKey,
        );
        if (entries.length === 0) {
          entries.push(
            createPersistedWindowStateEntry({
              browserWindow,
              stateKey: PRIMARY_WINDOW_STATE_KEY,
            }),
          );
        }
        void writeEntries(entries).catch((error) =>
          console.error("Could not save desktop window state", error),
        );
      });
      browserWindow.on("closed", () => {
        activeWindows.delete(stateKey);
      });
      browserWindow.webContents.on("dom-ready", () => {
        applyZoomFactor(browserWindow);
      });
      browserWindow.webContents.setWindowOpenHandler((details) => {
        const url = resolveDesktopExternalUrl(details.url);
        if (url !== null) {
          args.openExternalUrl({ url });
        }
        return { action: "deny" };
      });

      return { browserWindow, stateKey };
    } finally {
      pendingStateKeys.delete(stateKey);
    }
  }

  async function restoreSavedWindows(): Promise<CreatedDesktopWindow[]> {
    const { windows: entries } = await readPersistedWindowStateFile({
      userDataPath: args.userDataPath,
    });
    if (entries.length === 0) {
      return [await createWindow({ stateKey: PRIMARY_WINDOW_STATE_KEY })];
    }

    const restoredWindows: CreatedDesktopWindow[] = [];
    for (const entry of entries) {
      restoredWindows.push(await createWindow({ stateKey: entry.stateKey }));
    }
    return restoredWindows;
  }

  function focusFirstWindow(): boolean {
    for (const browserWindow of activeWindows.values()) {
      if (browserWindow.isMinimized()) {
        browserWindow.restore();
      }
      browserWindow.focus();
      return true;
    }
    return false;
  }

  async function persistOpenWindows(): Promise<void> {
    clearSaveTimer();
    const entries = snapshotWindows();
    if (entries.length > 0) await writeEntries(entries);
    else await settledWrite();
  }

  return {
    createWindow,
    focusFirstWindow,
    hasOpenWindows() {
      return activeWindows.size > 0;
    },
    loadUrl: loadUrlIntoWindow,
    persistOpenWindows,
    zoom(webContentsId, command) {
      const windows = [...activeWindows.values()];
      if (!windows.some((window) => window.webContents.id === webContentsId))
        return false;
      zoomFactor = nextZoomFactor(zoomFactor ?? 1, command);
      for (const window of windows) applyZoomFactor(window);
      void persistOpenWindows().catch((error) =>
        console.error("Could not save desktop window state", error),
      );
      return true;
    },
    restoreSavedWindows,
  };
}
