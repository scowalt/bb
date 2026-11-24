import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type {
  PreviewFrame,
  PreviewSize,
  PreviewTab,
  ViewerAction,
} from "./contracts.js";
import { experimental_sliceUtf16Head as sliceUtf16Head } from "@get-bb/plugin-sdk/host";

const messageSchema = z.object({
  id: z.number().int().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
  sessionId: z.string().optional(),
});
const targetInfoSchema = z.object({
  targetId: z.string(),
  type: z.string(),
  url: z.string(),
  title: z.string(),
});
const targetEventSchema = z.object({ targetInfo: targetInfoSchema });
const targetDestroyedSchema = z.object({ targetId: z.string() });
const detachedSchema = z.object({ sessionId: z.string() });
const attachedSchema = z.object({ sessionId: z.string() });
const createdTargetSchema = z.object({ targetId: z.string() });
const windowSchema = z.object({ windowId: z.number().int() });
const maxHiddenToolbarHeight = 400;
const hiddenToolbarSchema = z.object({
  result: z.object({
    value: z.number().int().min(0).max(maxHiddenToolbarHeight),
  }),
});
const historySchema = z.object({
  currentIndex: z.number().int(),
  entries: z.array(z.object({ id: z.number().int() })),
});
const screencastFrameSchema = z.object({
  data: z.string().min(1),
  sessionId: z.number().int(),
  metadata: z.object({
    deviceWidth: z.number().positive(),
    deviceHeight: z.number().positive(),
  }),
});

const maxFrameChars = 700_000;
const maxTabs = 20;
const frameEdge: Record<PreviewSize, number> = { thumbnail: 800, full: 2560 };
const startQuality = 60;
const qualityStep = 15;
const minQuality = 30;
const mouseEvents = {
  move: "mouseMoved",
  down: "mousePressed",
  up: "mouseReleased",
} as const;
const buttonBits = { none: 0, left: 1, right: 2, middle: 4 } as const;
const blankUrls = new Set(["", "about:blank"]);

const socketOpen = 1;

export interface PreviewSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "close" | "error",
    listener: () => void,
  ): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
}

export interface PreviewSource {
  next(
    afterSequence: number,
    waitMs: number,
    signal: AbortSignal,
    size: PreviewSize,
  ): Promise<PreviewFrame | null>;
  input(actions: ViewerAction[], signal: AbortSignal): Promise<void>;
  close(): void;
}

export function createPreview(
  connectionUrl: string,
  timing = {
    frameIntervalMs: { thumbnail: 250, full: 100 },
    idleMs: 15_000,
    reconnectMs: 1_000,
    fullSizeHoldMs: 10_000,
    settleMs: 1_000,
    inputWaitMs: 10_000,
  },
  openSocket: (url: string) => PreviewSocket = (url) => new WebSocket(url),
): PreviewSource {
  const targets = new Map<
    string,
    { url: string; title: string; activity: number }
  >();
  const calls = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  const waiters = new Set<{ check(): void; fail(error: Error): void }>();
  let socket: PreviewSocket | null = null;
  let cast: {
    targetId: string;
    sessionId: string;
    size: PreviewSize;
    quality: number;
  } | null = null;
  let focused: string | null = null;
  let viewport: { width: number; height: number } | null = null;
  let pressedButtons = 0;
  let fullSizeUntil = 0;
  let selection: Promise<void> = Promise.resolve();
  let latest: PreviewFrame | null = null;
  let sequence = 0;
  let nextCallId = 0;
  let activityClock = 0;
  let lastConnectAt = 0;
  let nextAckAt = 0;
  let idleTimer: NodeJS.Timeout | null = null;
  let settleTimer: NodeJS.Timeout | null = null;
  let closed = false;

  function send(
    connection: PreviewSocket,
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    if (connection !== socket || connection.readyState !== socketOpen)
      return Promise.reject(new Error("Browser preview connection closed"));
    const id = ++nextCallId;
    return new Promise((resolve, reject) => {
      calls.set(id, { resolve, reject });
      connection.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId === undefined ? {} : { sessionId }),
        }),
      );
    });
  }

  function disconnect() {
    const connection = socket;
    socket = null;
    cast = null;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
    targets.clear();
    for (const call of calls.values())
      call.reject(new Error("Browser preview connection closed"));
    calls.clear();
    if (connection && connection.readyState <= socketOpen) connection.close();
  }

  async function fitWindow(
    connection: PreviewSocket,
    targetId: string,
    sessionId: string,
  ) {
    if (viewport === null) return;
    const { width, height } = viewport;
    const { windowId } = windowSchema.parse(
      await send(connection, "Browser.getWindowForTarget", { targetId }),
    );
    const toolbar = hiddenToolbarSchema.safeParse(
      await send(
        connection,
        "Runtime.evaluate",
        { expression: "outerHeight - innerHeight", returnByValue: true },
        sessionId,
      ).catch(() => null),
    );
    await send(connection, "Browser.setWindowBounds", {
      windowId,
      bounds: {
        width,
        height: height + (toolbar.success ? toolbar.data.result.value : 0),
      },
    });
  }

  function bestTarget(): string | null {
    if (focused !== null && targets.has(focused)) return focused;
    let best: { targetId: string; rank: number; activity: number } | null =
      null;
    for (const [targetId, target] of targets) {
      const rank = blankUrls.has(target.url) ? 0 : 1;
      if (
        !best ||
        rank > best.rank ||
        (rank === best.rank && target.activity > best.activity)
      )
        best = { targetId, rank, activity: target.activity };
    }
    return best?.targetId ?? null;
  }

  function select(connection: PreviewSocket) {
    selection = selection
      .then(async () => {
        if (connection !== socket) return;
        const targetId = bestTarget();
        const size: PreviewSize =
          Date.now() < fullSizeUntil ? "full" : "thumbnail";
        if (
          targetId === (cast?.targetId ?? null) &&
          (cast === null || cast.size === size)
        )
          return;
        let sessionId: string;
        if (cast && cast.targetId === targetId) {
          sessionId = cast.sessionId;
          await send(connection, "Page.stopScreencast", {}, sessionId);
        } else {
          const previous = cast;
          cast = null;
          if (previous)
            await send(connection, "Target.detachFromTarget", {
              sessionId: previous.sessionId,
            }).catch(() => {});
          if (targetId === null) return;
          sessionId = attachedSchema.parse(
            await send(connection, "Target.attachToTarget", {
              targetId,
              flatten: true,
            }),
          ).sessionId;
          await fitWindow(connection, targetId, sessionId).catch(() => {});
        }
        cast = { targetId, sessionId, size, quality: startQuality };
        await startScreencast(connection, cast);
      })
      .catch(() => {
        if (connection === socket) disconnect();
      });
  }

  function startScreencast(
    connection: PreviewSocket,
    target: { sessionId: string; size: PreviewSize; quality: number },
  ) {
    return send(
      connection,
      "Page.startScreencast",
      {
        format: "jpeg",
        quality: target.quality,
        maxWidth: frameEdge[target.size],
        maxHeight: frameEdge[target.size],
        everyNthFrame: 1,
      },
      target.sessionId,
    );
  }

  function lowerQuality(connection: PreviewSocket) {
    const current = cast;
    if (current === null || current.quality <= minQuality) return;
    current.quality = Math.max(minQuality, current.quality - qualityStep);
    selection = selection
      .then(async () => {
        if (connection !== socket || cast !== current) return;
        await send(connection, "Page.stopScreencast", {}, current.sessionId);
        await startScreencast(connection, current);
      })
      .catch(() => {
        if (connection === socket) disconnect();
      });
  }

  function tabs(): PreviewTab[] {
    return [...targets].slice(0, maxTabs).map(([id, target]) => ({
      id,
      url: target.url.slice(0, 2_000),
      title: sliceUtf16Head(target.title, 300),
    }));
  }

  function publish(frame: Omit<PreviewFrame, "sequence">) {
    latest = { ...frame, sequence: ++sequence };
    for (const waiter of [...waiters]) waiter.check();
  }

  function frameContext(targetId: string) {
    const target = targets.get(targetId);
    return {
      url: (target?.url ?? "").slice(0, 2_000),
      title: sliceUtf16Head(target?.title ?? "", 300),
      tabs: tabs(),
      activeTabId: targetId,
    };
  }

  function republish() {
    if (!latest || !targets.has(latest.activeTabId)) return;
    const next = { ...latest, ...frameContext(latest.activeTabId) };
    if (JSON.stringify(next) !== JSON.stringify(latest)) publish(next);
  }

  function observe(
    connection: PreviewSocket,
    info: z.infer<typeof targetInfoSchema>,
  ) {
    if (info.type !== "page") return;
    const known = targets.get(info.targetId);
    if (known && known.url === info.url && known.title === info.title) return;
    targets.set(info.targetId, {
      url: info.url,
      title: info.title,
      activity:
        known && known.url === info.url ? known.activity : ++activityClock,
    });
    republish();
    select(connection);
  }

  function receive(connection: PreviewSocket, raw: string) {
    const message = messageSchema.parse(JSON.parse(raw));
    if (message.id !== undefined) {
      const call = calls.get(message.id);
      calls.delete(message.id);
      if (message.error) call?.reject(new Error(message.error.message));
      else call?.resolve(message.result);
      return;
    }
    if (
      message.method === "Target.targetCreated" ||
      message.method === "Target.targetInfoChanged" ||
      message.method === "Target.attachedToTarget"
    ) {
      observe(connection, targetEventSchema.parse(message.params).targetInfo);
    } else if (message.method === "Target.targetDestroyed") {
      const { targetId } = targetDestroyedSchema.parse(message.params);
      targets.delete(targetId);
      if (focused === targetId) focused = null;
      if (cast?.targetId === targetId) cast = null;
      republish();
      select(connection);
    } else if (message.method === "Target.detachedFromTarget") {
      const { sessionId } = detachedSchema.parse(message.params);
      if (cast?.sessionId !== sessionId) return;
      cast = null;
      select(connection);
    } else if (message.method === "Page.screencastFrame") {
      const sessionId = message.sessionId;
      if (sessionId === undefined || sessionId !== cast?.sessionId) return;
      const frame = screencastFrameSchema.parse(message.params);
      if (frame.data.length > maxFrameChars) lowerQuality(connection);
      else
        publish({
          mimeType: "image/jpeg",
          data: frame.data,
          width: frame.metadata.deviceWidth,
          height: frame.metadata.deviceHeight,
          ...frameContext(cast.targetId),
        });
      const targetId = cast.targetId;
      const refresh = () =>
        void send(connection, "Target.getTargetInfo", { targetId })
          .then((result) => {
            if (connection === socket)
              observe(connection, targetEventSchema.parse(result).targetInfo);
          })
          .catch(() => {});
      refresh();
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(refresh, timing.settleMs);
      settleTimer.unref();
      const ackAt =
        Math.max(Date.now(), nextAckAt) + timing.frameIntervalMs[cast.size];
      nextAckAt = ackAt;
      const ack = setTimeout(() => {
        void send(
          connection,
          "Page.screencastFrameAck",
          { sessionId: frame.sessionId },
          sessionId,
        ).catch(() => {});
      }, ackAt - Date.now());
      ack.unref();
    }
  }

  function connect() {
    if (closed || socket || Date.now() - lastConnectAt < timing.reconnectMs)
      return;
    lastConnectAt = Date.now();
    const connection = openSocket(connectionUrl);
    socket = connection;
    connection.addEventListener("open", () => {
      send(connection, "Target.setDiscoverTargets", { discover: true }).catch(
        () => {
          if (connection === socket) disconnect();
        },
      );
    });
    connection.addEventListener("message", (event) => {
      if (connection !== socket || typeof event.data !== "string") return;
      try {
        receive(connection, event.data);
      } catch {
        disconnect();
      }
    });
    const drop = () => {
      if (connection === socket) disconnect();
    };
    connection.addEventListener("close", drop);
    connection.addEventListener("error", drop);
  }

  async function until<T>(
    probe: () => Promise<T | null>,
    signal: AbortSignal,
  ): Promise<T> {
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(timing.inputWaitMs),
    ]);
    while (true) {
      if (closed)
        throw new Error("Browser session stopped; open a new session");
      connect();
      const value = await probe();
      if (value !== null) return value;
      try {
        await delay(25, undefined, { signal: deadline });
      } catch {
        throw new Error("The browser tab is not ready; try again");
      }
    }
  }

  function browserConnection(signal: AbortSignal) {
    return until(async () => {
      const connection = socket;
      return connection?.readyState === socketOpen ? connection : null;
    }, signal);
  }

  function page(signal: AbortSignal) {
    return until(async () => {
      const connection = socket;
      if (connection?.readyState !== socketOpen) return null;
      select(connection);
      await selection;
      const target = bestTarget();
      return connection === socket && cast && cast.targetId === target
        ? { connection, targetId: cast.targetId, sessionId: cast.sessionId }
        : null;
    }, signal);
  }

  async function perform(action: ViewerAction, signal: AbortSignal) {
    switch (action.type) {
      case "mouse": {
        const target = await page(signal);
        const bit = buttonBits[action.button];
        if (action.event === "down") pressedButtons |= bit;
        if (action.event === "up") pressedButtons &= ~bit;
        await send(
          target.connection,
          "Input.dispatchMouseEvent",
          {
            type: mouseEvents[action.event],
            x: action.x,
            y: action.y,
            button: action.button,
            buttons: pressedButtons,
            clickCount: action.clickCount,
            modifiers: action.modifiers,
          },
          target.sessionId,
        );
        return;
      }
      case "wheel": {
        const target = await page(signal);
        await send(
          target.connection,
          "Input.dispatchMouseEvent",
          {
            type: "mouseWheel",
            x: action.x,
            y: action.y,
            deltaX: action.deltaX,
            deltaY: action.deltaY,
            modifiers: action.modifiers,
          },
          target.sessionId,
        );
        return;
      }
      case "key": {
        const target = await page(signal);
        await send(
          target.connection,
          "Input.dispatchKeyEvent",
          {
            type:
              action.event === "up"
                ? "keyUp"
                : action.text === undefined
                  ? "rawKeyDown"
                  : "keyDown",
            key: action.key,
            code: action.code,
            ...(action.text === undefined || action.event === "up"
              ? {}
              : { text: action.text, unmodifiedText: action.text }),
            windowsVirtualKeyCode: action.keyCode,
            modifiers: action.modifiers,
          },
          target.sessionId,
        );
        return;
      }
      case "text": {
        const target = await page(signal);
        await send(
          target.connection,
          "Input.insertText",
          { text: action.text },
          target.sessionId,
        );
        return;
      }
      case "navigate": {
        const target = await page(signal);
        await send(
          target.connection,
          "Page.navigate",
          { url: action.url },
          target.sessionId,
        );
        return;
      }
      case "history": {
        const target = await page(signal);
        const history = historySchema.parse(
          await send(
            target.connection,
            "Page.getNavigationHistory",
            {},
            target.sessionId,
          ),
        );
        const entry = history.entries[history.currentIndex + action.delta];
        if (entry)
          await send(
            target.connection,
            "Page.navigateToHistoryEntry",
            { entryId: entry.id },
            target.sessionId,
          );
        return;
      }
      case "reload": {
        const target = await page(signal);
        await send(target.connection, "Page.reload", {}, target.sessionId);
        return;
      }
      case "resize": {
        viewport = { width: action.width, height: action.height };
        const target = await page(signal);
        await fitWindow(target.connection, target.targetId, target.sessionId);
        return;
      }
      case "selectTab": {
        const connection = await browserConnection(signal);
        await send(connection, "Target.activateTarget", {
          targetId: action.tabId,
        });
        focused = action.tabId;
        select(connection);
        await selection;
        return;
      }
      case "newTab": {
        const connection = await browserConnection(signal);
        focused = createdTargetSchema.parse(
          await send(connection, "Target.createTarget", {
            url: action.url ?? "about:blank",
          }),
        ).targetId;
        select(connection);
        await selection;
        return;
      }
      case "closeTab": {
        const connection = await browserConnection(signal);
        await send(connection, "Target.closeTarget", {
          targetId: action.tabId,
        });
        return;
      }
    }
  }

  function touch() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (waiters.size > 0) touch();
      else disconnect();
    }, timing.idleMs);
    idleTimer.unref();
  }

  return {
    next(afterSequence, waitMs, signal, size) {
      signal.throwIfAborted();
      if (closed)
        return Promise.reject(
          new Error("Browser session stopped; open a new session"),
        );
      touch();
      connect();
      if (size === "full") fullSizeUntil = Date.now() + timing.fullSizeHoldMs;
      if (socket) select(socket);
      const ready = () =>
        latest && (latest.sequence > afterSequence || afterSequence > sequence)
          ? latest
          : null;
      const immediate = ready();
      if (immediate) return Promise.resolve(immediate);
      return new Promise((resolve, reject) => {
        const settle = (finish: () => void) => {
          waiters.delete(waiter);
          clearTimeout(timeout);
          clearInterval(reconnect);
          signal.removeEventListener("abort", abort);
          finish();
        };
        const waiter = {
          check() {
            const frame = ready();
            if (frame) settle(() => resolve(frame));
          },
          fail(error: Error) {
            settle(() => reject(error));
          },
        };
        const abort = () => waiter.fail(new Error("Browser preview cancelled"));
        const timeout = setTimeout(() => settle(() => resolve(null)), waitMs);
        const reconnect = setInterval(connect, timing.reconnectMs);
        timeout.unref();
        reconnect.unref();
        waiters.add(waiter);
        signal.addEventListener("abort", abort, { once: true });
      });
    },
    async input(actions, signal) {
      signal.throwIfAborted();
      if (closed)
        throw new Error("Browser session stopped; open a new session");
      touch();
      for (const action of actions) await perform(action, signal);
    },
    close() {
      if (closed) return;
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      disconnect();
      for (const waiter of [...waiters])
        waiter.fail(new Error("Browser session stopped; open a new session"));
    },
  };
}
