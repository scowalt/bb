import { describe, expect, it } from "vitest";
import type { ViewerAction } from "./contracts.js";
import { viewerActionSchema } from "./contracts.js";
import {
  createClickCounter,
  createInputQueue,
  keyAction,
  modifierBits,
  normalizeAddress,
  remoteViewportSize,
  viewerShortcut,
  viewportPoint,
  wheelDelta,
} from "./viewer-input.js";

const noModifiers = {
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
};
const key = (
  overrides: Partial<Parameters<typeof keyAction>[0]> & { key: string },
) => ({
  ...noModifiers,
  code: "",
  keyCode: 0,
  isComposing: false,
  ...overrides,
});

describe("viewport coordinates", () => {
  const viewport = { width: 1280, height: 640 };

  it("scales a point on an image rendered at half size", () => {
    expect(
      viewportPoint({
        client: { x: 110, y: 70 },
        rendered: { left: 10, top: 20, width: 640, height: 320 },
        viewport,
        clampToEdge: false,
      }),
    ).toEqual({ x: 200, y: 100 });
  });

  it("subtracts the letterbox bars of a contained image", () => {
    const rendered = { left: 0, top: 0, width: 640, height: 520 };
    expect(
      viewportPoint({
        client: { x: 320, y: 260 },
        rendered,
        viewport,
        clampToEdge: false,
      }),
    ).toEqual({ x: 640, y: 320 });
    expect(
      viewportPoint({
        client: { x: 0, y: 100 },
        rendered,
        viewport,
        clampToEdge: false,
      }),
    ).toEqual({ x: 0, y: 0 });
  });

  it("ignores presses on the bars but pins drags to the page edge", () => {
    const rendered = { left: 0, top: 0, width: 640, height: 520 };
    const onBar = { x: 320, y: 20 };
    expect(
      viewportPoint({ client: onBar, rendered, viewport, clampToEdge: false }),
    ).toBeNull();
    expect(
      viewportPoint({ client: onBar, rendered, viewport, clampToEdge: true }),
    ).toEqual({ x: 640, y: 0 });
  });
});

describe("modifiers", () => {
  it("encodes the CDP bitmask Alt 1, Ctrl 2, Meta 4, Shift 8", () => {
    expect(modifierBits({ ...noModifiers, altKey: true }, false)).toBe(1);
    expect(modifierBits({ ...noModifiers, ctrlKey: true }, false)).toBe(2);
    expect(modifierBits({ ...noModifiers, metaKey: true }, false)).toBe(4);
    expect(modifierBits({ ...noModifiers, shiftKey: true }, false)).toBe(8);
    expect(
      modifierBits(
        { altKey: true, ctrlKey: true, metaKey: true, shiftKey: true },
        false,
      ),
    ).toBe(15);
  });

  it("sends Command as Control from a Mac, because the remote is Linux Chrome", () => {
    expect(modifierBits({ ...noModifiers, metaKey: true }, true)).toBe(2);
    expect(
      keyAction(
        key({ key: "a", code: "KeyA", keyCode: 65, metaKey: true }),
        "down",
        true,
      ),
    ).toEqual({
      type: "key",
      event: "down",
      key: "a",
      code: "KeyA",
      keyCode: 65,
      modifiers: 2,
    });
  });
});

describe("keys", () => {
  it("types printable keys as text on key down only", () => {
    const down = keyAction(
      key({ key: "é", code: "KeyE", keyCode: 69 }),
      "down",
      false,
    );
    const up = keyAction(
      key({ key: "é", code: "KeyE", keyCode: 69 }),
      "up",
      false,
    );
    expect(down.text).toBe("é");
    expect(up.text).toBeUndefined();
    expect(keyAction(key({ key: "😀" }), "down", false).text).toBe("😀");
  });

  it("sends Enter as a carriage return", () => {
    expect(
      keyAction(
        key({ key: "Enter", code: "Enter", keyCode: 13 }),
        "down",
        false,
      ).text,
    ).toBe("\r");
  });

  it("sends named keys and chords without text", () => {
    expect(
      keyAction(
        key({ key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 }),
        "down",
        false,
      ).text,
    ).toBeUndefined();
    expect(
      keyAction(key({ key: "c", ctrlKey: true }), "down", false).text,
    ).toBeUndefined();
  });

  it("produces actions the server accepts", () => {
    for (const action of [
      keyAction(key({ key: "", code: "", keyCode: 229 }), "down", false),
      keyAction(key({ key: "x".repeat(60), keyCode: 999 }), "down", false),
    ])
      expect(viewerActionSchema.safeParse(action).success).toBe(true);
  });

  it("leaves paste to the clipboard event and Cmd+L to the address field", () => {
    expect(viewerShortcut(key({ key: "v", metaKey: true }), true)).toBe(
      "paste",
    );
    expect(viewerShortcut(key({ key: "v", ctrlKey: true }), false)).toBe(
      "paste",
    );
    expect(viewerShortcut(key({ key: "v", ctrlKey: true }), true)).toBeNull();
    expect(viewerShortcut(key({ key: "l", metaKey: true }), true)).toBe(
      "focusAddress",
    );
    expect(viewerShortcut(key({ key: "a", metaKey: true }), true)).toBeNull();
  });
});

describe("pointer details", () => {
  it("counts double and triple clicks at one spot and resets elsewhere", () => {
    const count = createClickCounter();
    const at = (x: number, timeMs: number) =>
      count({ button: "left", x, y: 10, timeMs });
    expect([at(10, 0), at(11, 200), at(11, 400), at(11, 600)]).toEqual([
      1, 2, 3, 3,
    ]);
    expect(at(80, 700)).toBe(1);
    expect(at(80, 1_500)).toBe(1);
  });

  it("converts line and page wheel deltas to pixels", () => {
    expect(wheelDelta({ delta: 3, deltaMode: 1, pageSize: 600 })).toBe(120);
    expect(wheelDelta({ delta: -1, deltaMode: 2, pageSize: 600 })).toBe(-600);
    expect(wheelDelta({ delta: 1e6, deltaMode: 0, pageSize: 600 })).toBe(
      10_000,
    );
  });

  it("keeps remote viewport sizes in the accepted range", () => {
    expect(remoteViewportSize({ width: 200.4, height: 900.6 })).toEqual({
      width: 320,
      height: 901,
    });
  });
});

describe("address field", () => {
  it.each([
    ["example.com", "https://example.com/"],
    ["  example.com/a?b=1 ", "https://example.com/a?b=1"],
    ["http://example.com", "http://example.com/"],
    ["localhost:3000/x", "http://localhost:3000/x"],
    ["127.0.0.1:8080", "http://127.0.0.1:8080/"],
    ["about:blank", "about:blank"],
  ])("opens %s as %s", (input, expected) => {
    expect(normalizeAddress(input)).toBe(expected);
  });

  it.each(["", "  ", "ftp://example.com", "javascript:alert(1)", "two words"])(
    "rejects %j",
    (input) => {
      expect(normalizeAddress(input)).toBeNull();
    },
  );
});

describe("input queue", () => {
  const move = (x: number): ViewerAction => ({
    type: "mouse",
    event: "move",
    x,
    y: 0,
    button: "none",
    clickCount: 0,
    modifiers: 0,
  });
  const down: ViewerAction = {
    type: "mouse",
    event: "down",
    x: 5,
    y: 0,
    button: "left",
    clickCount: 1,
    modifiers: 0,
  };

  function harness() {
    const sent: ViewerAction[][] = [];
    const pending: (() => void)[] = [];
    const flushes: (() => void)[] = [];
    const errors: unknown[] = [];
    const queue = createInputQueue({
      send: (actions) => {
        sent.push(actions);
        return new Promise<void>((resolve) => pending.push(resolve));
      },
      schedule: (flush) => flushes.push(flush),
      onError: (error) => errors.push(error),
    });
    const tick = async () => {
      for (const flush of flushes.splice(0)) flush();
      await Promise.resolve();
    };
    const settle = async () => {
      pending.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { queue, sent, tick, settle, errors };
  }

  it("keeps one request in flight and coalesces the moves queued behind it", async () => {
    const { queue, sent, tick, settle } = harness();
    queue.push(move(1));
    queue.push(move(2));
    await tick();
    expect(sent).toEqual([[move(2)]]);
    queue.push(move(3));
    queue.push(down);
    queue.push(move(4));
    queue.push(move(5));
    await tick();
    expect(sent).toHaveLength(1);
    await settle();
    await tick();
    expect(sent).toEqual([[move(2)], [move(3), down, move(5)]]);
  });

  it("sums consecutive wheel deltas", async () => {
    const { queue, sent, tick } = harness();
    const wheel = (deltaY: number): ViewerAction => ({
      type: "wheel",
      x: 1,
      y: 2,
      deltaX: 0,
      deltaY,
      modifiers: 0,
    });
    queue.push(wheel(10));
    queue.push(wheel(15));
    await tick();
    expect(sent).toEqual([[wheel(25)]]);
  });

  it("splits long bursts into calls of at most 64 actions", async () => {
    const { queue, sent, tick, settle } = harness();
    for (let index = 0; index < 70; index++)
      queue.push({ type: "text", text: String(index) });
    await tick();
    await settle();
    await tick();
    expect(sent.map((batch) => batch.length)).toEqual([64, 6]);
  });

  it("reports a failed call and keeps sending later input", async () => {
    const sent: ViewerAction[][] = [];
    const errors: unknown[] = [];
    const queue = createInputQueue({
      send: async (actions) => {
        sent.push(actions);
        if (sent.length === 1) throw new Error("session ended");
      },
      schedule: (flush) => queueMicrotask(flush),
      onError: (error) => errors.push(error),
    });
    queue.push({ type: "reload" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    queue.push({ type: "history", delta: -1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(1);
    expect(sent).toEqual([
      [{ type: "reload" }],
      [{ type: "history", delta: -1 }],
    ]);
  });

  it("drops queued input after dispose", async () => {
    const { queue, sent, tick } = harness();
    queue.push(move(1));
    queue.dispose();
    await tick();
    queue.push(move(2));
    await tick();
    expect(sent).toEqual([]);
  });
});
