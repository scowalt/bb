import { isNonImeKey } from "@/lib/ime-keyboard";
import type { ViewerAction } from "./contracts.js";

type KeyAction = Extract<ViewerAction, { type: "key" }>;
type MouseButton = Extract<ViewerAction, { type: "mouse" }>["button"];

export interface ModifierState {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface KeyEventLike extends ModifierState {
  key: string;
  code: string;
  keyCode: number;
  isComposing: boolean;
}

export interface Size {
  width: number;
  height: number;
}

export interface Box extends Size {
  left: number;
  top: number;
}

export type ViewerShortcut = "paste" | "focusAddress";

const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;
const MAX_COORDINATE = 10_000;
const MAX_WHEEL_DELTA = 10_000;
const WHEEL_LINE_PX = 40;
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_SLOP_PX = 4;
const MAX_ACTIONS_PER_CALL = 64;
const MAX_URL_LENGTH = 2_000;
const LOCAL_HOST_PATTERN =
  /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i;

export function isMacPlatform(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/.test(platform);
}

export function modifierBits(state: ModifierState, mac: boolean): number {
  return (
    (state.altKey ? ALT : 0) |
    (state.ctrlKey || (mac && state.metaKey) ? CTRL : 0) |
    (!mac && state.metaKey ? META : 0) |
    (state.shiftKey ? SHIFT : 0)
  );
}

function keyText(event: KeyEventLike): string | undefined {
  if (isNonImeKey(event, "Enter")) return "\r";
  if (event.ctrlKey || event.metaKey) return undefined;
  return [...event.key].length === 1 ? event.key : undefined;
}

export function keyAction(
  event: KeyEventLike,
  phase: KeyAction["event"],
  mac: boolean,
): KeyAction {
  const text = phase === "down" ? keyText(event) : undefined;
  return {
    type: "key",
    event: phase,
    key: event.key === "" ? "Unidentified" : event.key.slice(0, 40),
    code: event.code.slice(0, 40),
    ...(text === undefined ? {} : { text }),
    keyCode: Math.min(255, Math.max(0, Math.trunc(event.keyCode))),
    modifiers: modifierBits(event, mac),
  };
}

export function viewerShortcut(
  event: KeyEventLike,
  mac: boolean,
): ViewerShortcut | null {
  const primary = mac ? event.metaKey : event.ctrlKey;
  if (!primary || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === "v") return "paste";
  if (key === "l" && !event.shiftKey) return "focusAddress";
  return null;
}

export function mouseButton(button: number): MouseButton {
  if (button === 0) return "left";
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "none";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function viewportPoint(args: {
  client: { x: number; y: number };
  rendered: Box;
  viewport: Size;
  clampToEdge: boolean;
}): { x: number; y: number } | null {
  const { client, rendered, viewport, clampToEdge } = args;
  if (rendered.width <= 0 || rendered.height <= 0) return null;
  const scale = Math.min(
    rendered.width / viewport.width,
    rendered.height / viewport.height,
  );
  const offsetX = (rendered.width - viewport.width * scale) / 2;
  const offsetY = (rendered.height - viewport.height * scale) / 2;
  const x = (client.x - rendered.left - offsetX) / scale;
  const y = (client.y - rendered.top - offsetY) / scale;
  const inside =
    x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height;
  if (!inside && !clampToEdge) return null;
  const round = (value: number, max: number) =>
    Math.round(clamp(value, 0, Math.min(max, MAX_COORDINATE)) * 100) / 100;
  return { x: round(x, viewport.width), y: round(y, viewport.height) };
}

export function wheelDelta(args: {
  delta: number;
  deltaMode: number;
  pageSize: number;
}): number {
  const { delta, deltaMode, pageSize } = args;
  const pixels =
    deltaMode === 1
      ? delta * WHEEL_LINE_PX
      : deltaMode === 2
        ? delta * pageSize
        : delta;
  return clamp(pixels, -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA);
}

export function remoteViewportSize(rendered: Size): Size {
  return {
    width: clamp(Math.round(rendered.width), 320, 2_560),
    height: clamp(Math.round(rendered.height), 240, 2_560),
  };
}

export function createClickCounter(): (args: {
  button: MouseButton;
  x: number;
  y: number;
  timeMs: number;
}) => number {
  let last: {
    button: MouseButton;
    x: number;
    y: number;
    timeMs: number;
    count: number;
  } | null = null;
  return ({ button, x, y, timeMs }) => {
    const repeated =
      last !== null &&
      last.button === button &&
      timeMs - last.timeMs <= DOUBLE_CLICK_MS &&
      Math.hypot(x - last.x, y - last.y) <= DOUBLE_CLICK_SLOP_PX;
    const count = repeated && last ? Math.min(3, last.count + 1) : 1;
    last = { button, x, y, timeMs, count };
    return count;
  };
}

export function normalizeAddress(input: string): string | null {
  const text = input.trim();
  if (text === "") return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  const candidate =
    hasScheme || /^about:/i.test(text)
      ? text
      : `${LOCAL_HOST_PATTERN.test(text) ? "http" : "https"}://${text}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (!["http:", "https:", "about:"].includes(parsed.protocol)) return null;
  if (parsed.protocol !== "about:" && !parsed.hostname) return null;
  return parsed.href.length > MAX_URL_LENGTH ? null : parsed.href;
}

function merge(
  previous: ViewerAction,
  next: ViewerAction,
): ViewerAction | null {
  if (
    previous.type === "mouse" &&
    next.type === "mouse" &&
    previous.event === "move" &&
    next.event === "move"
  )
    return next;
  if (
    previous.type === "wheel" &&
    next.type === "wheel" &&
    previous.modifiers === next.modifiers
  )
    return {
      ...next,
      deltaX: clamp(
        previous.deltaX + next.deltaX,
        -MAX_WHEEL_DELTA,
        MAX_WHEEL_DELTA,
      ),
      deltaY: clamp(
        previous.deltaY + next.deltaY,
        -MAX_WHEEL_DELTA,
        MAX_WHEEL_DELTA,
      ),
    };
  if (previous.type === "resize" && next.type === "resize") return next;
  return null;
}

export interface InputQueue {
  push(action: ViewerAction): void;
  dispose(): void;
}

export function createInputQueue(options: {
  send(actions: ViewerAction[]): Promise<unknown>;
  schedule(flush: () => void): void;
  onError(error: unknown): void;
}): InputQueue {
  let queued: ViewerAction[] = [];
  let inFlight = false;
  let scheduled = false;
  let disposed = false;

  const requestFlush = () => {
    if (scheduled || inFlight || disposed || queued.length === 0) return;
    scheduled = true;
    options.schedule(() => void flush());
  };

  const flush = async () => {
    scheduled = false;
    if (inFlight || disposed || queued.length === 0) return;
    const batch = queued.slice(0, MAX_ACTIONS_PER_CALL);
    queued = queued.slice(MAX_ACTIONS_PER_CALL);
    inFlight = true;
    try {
      await options.send(batch);
    } catch (error) {
      if (!disposed) options.onError(error);
    } finally {
      inFlight = false;
      requestFlush();
    }
  };

  return {
    push(action) {
      if (disposed) return;
      const last = queued.at(-1);
      const merged = last === undefined ? null : merge(last, action);
      if (merged === null) queued.push(action);
      else queued[queued.length - 1] = merged;
      requestFlush();
    },
    dispose() {
      disposed = true;
      queued = [];
    },
  };
}
