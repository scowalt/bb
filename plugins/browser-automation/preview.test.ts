import { describe, expect, it, vi } from "vitest";
import { createPreview, type PreviewSocket } from "./preview.js";

interface FakePage {
  targetId: string;
  type: string;
  url: string;
  title: string;
}

function createFakeBrowser(initial: FakePage[]) {
  const pages = new Map(initial.map((page) => [page.targetId, page]));
  const sessions = new Map<string, string>();
  const acks: number[] = [];
  const casts: {
    targetId: string;
    session: string;
    maxWidth: number;
    quality: number;
  }[] = [];
  const connections: FakeSocket[] = [];
  const toolbarHeights = new Map<string, unknown>();
  const commands: {
    method: string;
    params: Record<string, unknown>;
    target: string | null;
  }[] = [];
  let nextSession = 0;
  let nextTarget = 0;
  let nextFrame = 0;

  class FakeSocket implements PreviewSocket {
    readyState = 0;
    private listeners = new Map<
      string,
      ((event: { data: unknown }) => void)[]
    >();
    addEventListener(
      type: string,
      listener: (event: { data: unknown }) => void,
    ): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    emit(type: string, data: unknown = null) {
      for (const listener of this.listeners.get(type) ?? []) listener({ data });
    }
    event(method: string, params: unknown, sessionId?: string) {
      if (this.readyState !== 1) return;
      this.emit("message", JSON.stringify({ method, params, sessionId }));
    }
    send(raw: string) {
      const message = JSON.parse(raw) as {
        id: number;
        method: string;
        params: {
          targetId?: string;
          sessionId?: string | number;
          maxWidth?: number;
          quality?: number;
          url?: string;
        };
        sessionId?: string;
      };
      if (
        message.method.startsWith("Input.") ||
        message.method.startsWith("Browser.") ||
        [
          "Page.navigate",
          "Page.reload",
          "Page.navigateToHistoryEntry",
          "Target.activateTarget",
          "Target.createTarget",
          "Target.closeTarget",
        ].includes(message.method)
      )
        commands.push({
          method: message.method,
          params: message.params,
          target:
            message.sessionId === undefined
              ? null
              : (sessions.get(message.sessionId) ?? "detached"),
        });
      queueMicrotask(() => {
        let result: unknown = {};
        if (message.method === "Target.createTarget") {
          const page = {
            targetId: `new-${++nextTarget}`,
            type: "page",
            url: message.params.url!,
            title: "",
          };
          result = { targetId: page.targetId };
          browser.update(page, "Target.targetCreated");
        } else if (message.method === "Target.closeTarget") {
          browser.destroy(message.params.targetId!);
        } else if (message.method === "Browser.getWindowForTarget") {
          result = { windowId: 7 };
        } else if (message.method === "Runtime.evaluate") {
          const target = sessions.get(message.sessionId!)!;
          result = {
            result: { type: "number", value: toolbarHeights.get(target) ?? 0 },
          };
        } else if (message.method === "Page.getNavigationHistory") {
          result = {
            currentIndex: 1,
            entries: [{ id: 10 }, { id: 11 }],
          };
        } else if (message.method === "Target.setDiscoverTargets") {
          for (const page of pages.values())
            this.event("Target.targetCreated", { targetInfo: page });
        } else if (message.method === "Target.attachToTarget") {
          const sessionId = `session-${++nextSession}`;
          sessions.set(sessionId, message.params.targetId!);
          result = { sessionId };
        } else if (message.method === "Target.getTargetInfo") {
          result = { targetInfo: pages.get(message.params.targetId!) };
        } else if (message.method === "Target.detachFromTarget") {
          sessions.delete(String(message.params.sessionId));
        } else if (message.method === "Page.screencastFrameAck") {
          acks.push(Number(message.params.sessionId));
        }
        if (this.readyState !== 1) return;
        this.emit("message", JSON.stringify({ id: message.id, result }));
        if (message.method === "Page.startScreencast") {
          casts.push({
            targetId: sessions.get(message.sessionId!)!,
            session: message.sessionId!,
            maxWidth: message.params.maxWidth!,
            quality: message.params.quality!,
          });
          browser.frame(sessions.get(message.sessionId!)!);
        }
      });
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit("close");
    }
  }

  const browser = {
    acks,
    commands,
    toolbarHeights,
    casts,
    connections,
    open(): PreviewSocket {
      const socket = new FakeSocket();
      connections.push(socket);
      queueMicrotask(() => {
        socket.readyState = 1;
        socket.emit("open");
      });
      return socket;
    },
    live: () => connections.filter((socket) => socket.readyState === 1),
    castTargets: () => [...sessions.values()],
    frame(targetId: string, data = `frame-${++nextFrame}`) {
      for (const [sessionId, target] of sessions)
        if (target === targetId)
          for (const socket of browser.live())
            socket.event(
              "Page.screencastFrame",
              {
                data,
                sessionId: nextFrame,
                metadata: { deviceWidth: 1280, deviceHeight: 720 },
              },
              sessionId,
            );
    },
    update(page: FakePage, method: string | null = "Target.targetInfoChanged") {
      pages.set(page.targetId, page);
      if (method === null) return;
      for (const socket of browser.live())
        socket.event(method, { targetInfo: page });
    },
    destroy(targetId: string) {
      pages.delete(targetId);
      for (const [sessionId, target] of sessions)
        if (target === targetId) sessions.delete(sessionId);
      for (const socket of browser.live())
        socket.event("Target.targetDestroyed", { targetId });
    },
  };
  return browser;
}

const blank: FakePage = {
  targetId: "blank",
  type: "page",
  url: "about:blank",
  title: "",
};
const shop: FakePage = {
  targetId: "shop",
  type: "page",
  url: "https://shop.test/cart",
  title: "Cart",
};
const timing = {
  frameIntervalMs: { thumbnail: 5, full: 5 },
  idleMs: 60,
  reconnectMs: 5,
  fullSizeHoldMs: 40,
  settleMs: 40,
  inputWaitMs: 1_000,
};
const never = new AbortController().signal;

describe("live preview", () => {
  it("streams frames of the navigated page, long-polls, and throttles acks", async () => {
    const browser = createFakeBrowser([
      blank,
      shop,
      { ...shop, targetId: "worker", type: "service_worker" },
    ]);
    const preview = createPreview("ws://127.0.0.1:1/x", timing, browser.open);
    const first = await preview.next(0, 1_000, never, "thumbnail");
    expect(first).toMatchObject({
      sequence: 1,
      mimeType: "image/jpeg",
      data: "frame-1",
      width: 1280,
      height: 720,
      url: shop.url,
      title: "Cart",
    });
    expect(browser.castTargets()).toEqual(["shop"]);
    expect(
      await preview.next(first!.sequence, 20, never, "thumbnail"),
    ).toBeNull();
    const pending = preview.next(first!.sequence, 1_000, never, "thumbnail");
    browser.frame("shop");
    expect(await pending).toMatchObject({ sequence: 2, data: "frame-2" });
    expect(await preview.next(0, 1_000, never, "thumbnail")).toMatchObject({
      sequence: 2,
    });
    await vi.waitFor(() => expect(browser.acks).toEqual([1, 2]));
    preview.close();
  });

  it("follows the most recently navigated page and refreshes its title", async () => {
    const browser = createFakeBrowser([blank]);
    const preview = createPreview("ws://127.0.0.1:1/x", timing, browser.open);
    const initial = await preview.next(0, 1_000, never, "thumbnail");
    expect(initial).toMatchObject({ url: "about:blank" });
    browser.update(
      { ...shop, url: "about:blank", title: "" },
      "Target.targetCreated",
    );
    browser.update({ ...shop, title: "" });
    let navigated = await preview.next(
      initial!.sequence,
      1_000,
      never,
      "thumbnail",
    );
    while (navigated!.activeTabId !== "shop")
      navigated = await preview.next(
        navigated!.sequence,
        1_000,
        never,
        "thumbnail",
      );
    expect(navigated).toMatchObject({ url: shop.url, title: "" });
    expect(browser.castTargets()).toEqual(["shop"]);
    browser.update(shop);
    const titled = await preview.next(
      navigated!.sequence,
      1_000,
      never,
      "thumbnail",
    );
    expect(titled).toMatchObject({ title: "Cart", data: navigated!.data });
    browser.update({ ...shop, title: "Checkout" }, null);
    browser.frame("shop");
    let silent = await preview.next(
      titled!.sequence,
      1_000,
      never,
      "thumbnail",
    );
    if (silent!.title !== "Checkout")
      silent = await preview.next(silent!.sequence, 1_000, never, "thumbnail");
    expect(silent).toMatchObject({ url: shop.url, title: "Checkout" });
    browser.destroy("shop");
    await vi.waitFor(() => expect(browser.castTargets()).toEqual(["blank"]));
    const fallback = await preview.next(
      silent!.sequence,
      1_000,
      never,
      "thumbnail",
    );
    expect(fallback).toMatchObject({ url: "about:blank" });
    preview.close();
  });

  it("picks up a title that settles after the last frame of a static page", async () => {
    const browser = createFakeBrowser([{ ...shop, title: "shop.test/cart" }]);
    const preview = createPreview(
      "ws://127.0.0.1:1/x",
      { ...timing, idleMs: 5_000 },
      browser.open,
    );
    const loading = await preview.next(0, 1_000, never, "thumbnail");
    expect(loading).toMatchObject({ title: "shop.test/cart" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    browser.update(shop, null);
    const settled = await preview.next(
      loading!.sequence,
      1_000,
      never,
      "thumbnail",
    );
    expect(settled).toMatchObject({ title: "Cart", data: loading!.data });
    preview.close();
  });

  it("recasts the same page at full size on request, then returns to thumbnails", async () => {
    const browser = createFakeBrowser([shop]);
    const preview = createPreview(
      "ws://127.0.0.1:1/x",
      { ...timing, idleMs: 5_000 },
      browser.open,
    );
    const thumbnail = await preview.next(0, 1_000, never, "thumbnail");
    const full = await preview.next(thumbnail!.sequence, 1_000, never, "full");
    expect(full!.sequence).toBeGreaterThan(thumbnail!.sequence);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const back = await preview.next(full!.sequence, 1_000, never, "thumbnail");
    expect(back!.sequence).toBeGreaterThan(full!.sequence);
    expect(browser.casts.map((cast) => cast.maxWidth)).toEqual([
      800, 2560, 800,
    ]);
    expect(new Set(browser.casts.map((cast) => cast.session)).size).toBe(1);
    expect(browser.connections).toHaveLength(1);
    preview.close();
  });

  it("lowers JPEG quality instead of dropping the stream when frames exceed the size limit", async () => {
    const browser = createFakeBrowser([shop]);
    const preview = createPreview(
      "ws://127.0.0.1:1/x",
      { ...timing, idleMs: 5_000 },
      browser.open,
    );
    const first = await preview.next(0, 1_000, never, "full");
    const oversized = "x".repeat(700_001);
    browser.frame("shop", oversized);
    await vi.waitFor(() =>
      expect(browser.casts.map((cast) => cast.quality)).toEqual([60, 45]),
    );
    browser.frame("shop", oversized);
    browser.frame("shop", oversized);
    await vi.waitFor(() =>
      expect(browser.casts.map((cast) => cast.quality)).toEqual([60, 45, 30]),
    );
    const next = await preview.next(first!.sequence, 1_000, never, "full");
    expect(next!.data).not.toBe(oversized);
    expect(new Set(browser.casts.map((cast) => cast.session)).size).toBe(1);
    preview.close();
  });

  it("stops casting when nobody is watching and resumes on demand", async () => {
    const browser = createFakeBrowser([shop]);
    const preview = createPreview("ws://127.0.0.1:1/x", timing, browser.open);
    const first = await preview.next(0, 1_000, never, "thumbnail");
    await vi.waitFor(() => expect(browser.live()).toHaveLength(0));
    const resumed = await preview.next(
      first!.sequence,
      1_000,
      never,
      "thumbnail",
    );
    expect(resumed!.sequence).toBeGreaterThan(first!.sequence);
    expect(browser.connections).toHaveLength(2);
    preview.close();
  });

  it("recovers from a dropped browser connection", async () => {
    const browser = createFakeBrowser([shop]);
    const preview = createPreview("ws://127.0.0.1:1/x", timing, browser.open);
    const first = await preview.next(0, 1_000, never, "thumbnail");
    browser.live()[0]!.close();
    const next = await preview.next(first!.sequence, 1_000, never, "thumbnail");
    expect(next!.sequence).toBeGreaterThan(first!.sequence);
    preview.close();
  });

  it("rejects waiting consumers on cancellation and close", async () => {
    const browser = createFakeBrowser([]);
    const preview = createPreview("ws://127.0.0.1:1/x", timing, browser.open);
    const controller = new AbortController();
    const cancelled = preview.next(0, 1_000, controller.signal, "thumbnail");
    const closed = preview.next(0, 1_000, never, "thumbnail");
    controller.abort();
    await expect(cancelled).rejects.toThrow("cancelled");
    preview.close();
    await expect(closed).rejects.toThrow("stopped");
    await expect(preview.next(0, 10, never, "thumbnail")).rejects.toThrow(
      "stopped",
    );
    expect(browser.live()).toHaveLength(0);
  });

  it("sends viewer input to the page on screen, as CDP commands in order", async () => {
    const browser = createFakeBrowser([blank, shop]);
    const preview = createPreview("ws://127.0.0.1:1/x", timing, browser.open);
    await preview.input(
      [
        {
          type: "mouse",
          event: "move",
          x: 5,
          y: 6,
          button: "none",
          clickCount: 0,
          modifiers: 0,
        },
        {
          type: "mouse",
          event: "down",
          x: 5,
          y: 6,
          button: "left",
          clickCount: 1,
          modifiers: 8,
        },
        {
          type: "mouse",
          event: "down",
          x: 5,
          y: 6,
          button: "right",
          clickCount: 1,
          modifiers: 0,
        },
        {
          type: "mouse",
          event: "up",
          x: 5,
          y: 6,
          button: "left",
          clickCount: 1,
          modifiers: 0,
        },
        { type: "wheel", x: 1, y: 2, deltaX: 0, deltaY: 120, modifiers: 0 },
        {
          type: "key",
          event: "down",
          key: "a",
          code: "KeyA",
          text: "a",
          keyCode: 65,
          modifiers: 0,
        },
        {
          type: "key",
          event: "up",
          key: "a",
          code: "KeyA",
          text: "a",
          keyCode: 65,
          modifiers: 0,
        },
        {
          type: "key",
          event: "down",
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          modifiers: 2,
        },
        { type: "text", text: "héllo" },
        { type: "navigate", url: "https://shop.test/next" },
        { type: "history", delta: -1 },
        { type: "history", delta: 1 },
        { type: "reload" },
        { type: "resize", width: 600, height: 900 },
      ],
      never,
    );
    expect(browser.commands).toEqual([
      {
        method: "Input.dispatchMouseEvent",
        target: "shop",
        params: {
          type: "mouseMoved",
          x: 5,
          y: 6,
          button: "none",
          buttons: 0,
          clickCount: 0,
          modifiers: 0,
        },
      },
      {
        method: "Input.dispatchMouseEvent",
        target: "shop",
        params: {
          type: "mousePressed",
          x: 5,
          y: 6,
          button: "left",
          buttons: 1,
          clickCount: 1,
          modifiers: 8,
        },
      },
      {
        method: "Input.dispatchMouseEvent",
        target: "shop",
        params: {
          type: "mousePressed",
          x: 5,
          y: 6,
          button: "right",
          buttons: 3,
          clickCount: 1,
          modifiers: 0,
        },
      },
      {
        method: "Input.dispatchMouseEvent",
        target: "shop",
        params: {
          type: "mouseReleased",
          x: 5,
          y: 6,
          button: "left",
          buttons: 2,
          clickCount: 1,
          modifiers: 0,
        },
      },
      {
        method: "Input.dispatchMouseEvent",
        target: "shop",
        params: {
          type: "mouseWheel",
          x: 1,
          y: 2,
          deltaX: 0,
          deltaY: 120,
          modifiers: 0,
        },
      },
      {
        method: "Input.dispatchKeyEvent",
        target: "shop",
        params: {
          type: "keyDown",
          key: "a",
          code: "KeyA",
          text: "a",
          unmodifiedText: "a",
          windowsVirtualKeyCode: 65,
          modifiers: 0,
        },
      },
      {
        method: "Input.dispatchKeyEvent",
        target: "shop",
        params: {
          type: "keyUp",
          key: "a",
          code: "KeyA",
          windowsVirtualKeyCode: 65,
          modifiers: 0,
        },
      },
      {
        method: "Input.dispatchKeyEvent",
        target: "shop",
        params: {
          type: "rawKeyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          modifiers: 2,
        },
      },
      { method: "Input.insertText", target: "shop", params: { text: "héllo" } },
      {
        method: "Page.navigate",
        target: "shop",
        params: { url: "https://shop.test/next" },
      },
      {
        method: "Page.navigateToHistoryEntry",
        target: "shop",
        params: { entryId: 10 },
      },
      { method: "Page.reload", target: "shop", params: {} },
      {
        method: "Browser.getWindowForTarget",
        target: null,
        params: { targetId: "shop" },
      },
      {
        method: "Browser.setWindowBounds",
        target: null,
        params: { windowId: 7, bounds: { width: 600, height: 900 } },
      },
    ]);
    preview.close();
  });

  it("keeps showing the tab the user picked and reports every tab in frames", async () => {
    const browser = createFakeBrowser([blank, shop]);
    const preview = createPreview(
      "ws://127.0.0.1:1/x",
      { ...timing, idleMs: 5_000 },
      browser.open,
    );
    const first = await preview.next(0, 1_000, never, "thumbnail");
    expect(first).toMatchObject({
      activeTabId: "shop",
      tabs: [
        { id: "blank", url: "about:blank", title: "" },
        { id: "shop", url: shop.url, title: "Cart" },
      ],
    });
    await preview.input([{ type: "selectTab", tabId: "blank" }], never);
    expect(browser.castTargets()).toEqual(["blank"]);
    browser.update({ ...shop, url: "https://shop.test/paid" });
    await preview.input(
      [
        { type: "text", text: "x" },
        { type: "newTab", url: "https://example.test/" },
        { type: "text", text: "y" },
      ],
      never,
    );
    expect(
      browser.commands
        .filter((command) => command.method === "Input.insertText")
        .map((command) => command.target),
    ).toEqual(["blank", "new-1"]);
    let frame = await preview.next(0, 1_000, never, "thumbnail");
    while (frame!.activeTabId !== "new-1" || frame!.tabs.length < 3)
      frame = await preview.next(frame!.sequence, 1_000, never, "thumbnail");
    expect(frame!.tabs.map((tab) => tab.id)).toEqual([
      "blank",
      "shop",
      "new-1",
    ]);
    await preview.input([{ type: "closeTab", tabId: "new-1" }], never);
    const after = await preview.next(
      frame!.sequence,
      1_000,
      never,
      "thumbnail",
    );
    expect(browser.castTargets()).toEqual(["shop"]);
    expect(after).toMatchObject({
      activeTabId: "shop",
      tabs: [{ id: "blank" }, { id: "shop" }],
    });
    preview.close();
  });

  it("sizes the viewport, not the window, to the viewer on every tab", async () => {
    const browser = createFakeBrowser([blank, shop]);
    browser.toolbarHeights.set("shop", 143);
    browser.toolbarHeights.set("blank", 87);
    browser.toolbarHeights.set("new-1", "page overrode innerHeight");
    const preview = createPreview("ws://127.0.0.1:1/x", timing, browser.open);
    await preview.next(0, 1_000, never, "full");
    const windowHeights = () =>
      browser.commands
        .filter((command) => command.method === "Browser.setWindowBounds")
        .map((command) => command.params.bounds);
    expect(windowHeights()).toEqual([]);

    await preview.input([{ type: "resize", width: 600, height: 900 }], never);
    expect(windowHeights()).toEqual([{ width: 600, height: 1043 }]);

    await preview.input([{ type: "selectTab", tabId: "blank" }], never);
    await preview.input([{ type: "newTab" }], never);
    expect(windowHeights()).toEqual([
      { width: 600, height: 1043 },
      { width: 600, height: 987 },
      { width: 600, height: 900 },
    ]);
    preview.close();
  });

  it("refuses input after close", async () => {
    const browser = createFakeBrowser([shop]);
    const preview = createPreview("ws://127.0.0.1:1/x", timing, browser.open);
    preview.close();
    await expect(preview.input([{ type: "reload" }], never)).rejects.toThrow(
      "stopped",
    );
  });
});
