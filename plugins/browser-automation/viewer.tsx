import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { isImeComposing, isNonImeKey } from "@/lib/ime-keyboard";
import { observeSharedResize } from "@/lib/shared-resize-observer";
import { cn } from "@/lib/utils";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type {
  PreviewFrame,
  PreviewTab,
  rpcContract,
  ViewerAction,
} from "./contracts.js";
import { STATUS_LABEL, pageTitle, type PreviewStatus } from "./live-preview.js";
import {
  createClickCounter,
  createInputQueue,
  isMacPlatform,
  keyAction,
  modifierBits,
  mouseButton,
  normalizeAddress,
  remoteViewportSize,
  viewerShortcut,
  viewportPoint,
  wheelDelta,
  type InputQueue,
} from "./viewer-input.js";

const RESIZE_DEBOUNCE_MS = 300;
const MAX_PASTE_LENGTH = 10_000;
const TOOLBAR_BUTTON_CLASS = "size-7 shrink-0 text-muted-foreground";

export type ViewerPlacement = "panel" | "dialog";

type PressedButton = {
  button: Exclude<ReturnType<typeof mouseButton>, "none">;
  clickCount: number;
};

function useInputSender(args: {
  threadId: string;
  sessionId: string;
  onError: (message: string) => void;
}): (action: ViewerAction) => void {
  const { threadId, sessionId, onError } = args;
  const rpc = useRpc<typeof rpcContract>();
  const queueRef = useRef<InputQueue | null>(null);
  const reportError = useEffectEvent(onError);

  useEffect(() => {
    const queue = createInputQueue({
      send: (actions) => rpc.call("input", { threadId, sessionId, actions }),
      schedule: (flush) => window.requestAnimationFrame(flush),
      onError: (error) =>
        reportError(error instanceof Error ? error.message : String(error)),
    });
    queueRef.current = queue;
    return () => {
      queue.dispose();
      queueRef.current = null;
    };
  }, [rpc, sessionId, threadId]);

  return useCallback((action: ViewerAction) => {
    queueRef.current?.push(action);
  }, []);
}

function ToolbarButton({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={TOOLBAR_BUTTON_CLASS}
    >
      <Icon name={icon} className="size-3.5" aria-hidden />
    </Button>
  );
}

function TabMenu({
  tabs,
  activeTabId,
  disabled,
  send,
}: {
  tabs: readonly PreviewTab[];
  activeTabId: string | null;
  disabled: boolean;
  send: (action: ViewerAction) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Tabs, ${tabs.length} open`}
          disabled={disabled}
          className="h-7 shrink-0 gap-1 px-1.5 text-muted-foreground"
        >
          <Icon name="Layers" className="size-3.5" aria-hidden />
          <span className="text-2xs tabular-nums">{tabs.length}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-72 max-w-[90vw]"
        mobileTitle="Tabs"
      >
        {tabs.map((tab) => (
          <DropdownMenuItem
            key={tab.id}
            onSelect={() => send({ type: "selectTab", tabId: tab.id })}
            className="gap-2"
          >
            <Icon
              name="Check"
              className={cn(
                "size-3.5 shrink-0",
                tab.id !== activeTabId && "invisible",
              )}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate" title={tab.url}>
              {tab.title.trim() || tab.url || "New tab"}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => send({ type: "newTab" })}>
          New tab
        </DropdownMenuItem>
        {activeTabId !== null && tabs.length > 1 ? (
          <DropdownMenuItem
            onSelect={() => send({ type: "closeTab", tabId: activeTabId })}
          >
            Close this tab
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AddressField({
  url,
  disabled,
  inputRef,
  onNavigate,
  onDone,
}: {
  url: string;
  disabled: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onNavigate: (url: string) => void;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const target = normalizeAddress(draft ?? url);
    if (target === null) {
      setInvalid(true);
      return;
    }
    setDraft(null);
    setInvalid(false);
    onNavigate(target);
    onDone();
  };

  return (
    <form onSubmit={submit} className="min-w-0 flex-1">
      <Input
        ref={inputRef}
        aria-label="Address"
        aria-invalid={invalid}
        spellCheck={false}
        autoCapitalize="off"
        enterKeyHint="go"
        disabled={disabled}
        value={draft ?? url}
        onChange={(event) => {
          setDraft(event.target.value);
          setInvalid(false);
        }}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => {
          setDraft(null);
          setInvalid(false);
        }}
        onKeyDown={(event) => {
          if (!isNonImeKey(event, "Escape")) return;
          event.preventDefault();
          setDraft(null);
          onDone();
        }}
        className="h-7 px-2 text-xs aria-[invalid=true]:border-destructive"
      />
    </form>
  );
}

export function InteractiveViewer({
  threadId,
  sessionId,
  frame,
  status,
  placement,
}: {
  threadId: string;
  sessionId: string;
  frame: PreviewFrame | null;
  status: PreviewStatus;
  placement: ViewerPlacement;
}) {
  const [inputError, setInputError] = useState<string | null>(null);
  const queueAction = useInputSender({
    threadId,
    sessionId,
    onError: setInputError,
  });
  const send = useCallback(
    (action: ViewerAction) => {
      setInputError(null);
      queueAction(action);
    },
    [queueAction],
  );
  const surfaceRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const pressed = useRef<PressedButton | null>(null);
  const [countClicks] = useState(createClickCounter);
  const [mac] = useState(() =>
    typeof navigator === "undefined"
      ? false
      : isMacPlatform(navigator.platform),
  );
  const live = status === "live" && frame !== null;
  const title = pageTitle(frame);

  const pointAt = (
    event: { clientX: number; clientY: number },
    clampToEdge: boolean,
  ) => {
    const image = imageRef.current;
    if (!image || !frame) return null;
    return viewportPoint({
      client: { x: event.clientX, y: event.clientY },
      rendered: image.getBoundingClientRect(),
      viewport: frame,
      clampToEdge,
    });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!live) return;
    surfaceRef.current?.focus({ preventScroll: true });
    const button = mouseButton(event.button);
    if (button === "none") return;
    const point = pointAt(event, false);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const clickCount = countClicks({
      button,
      ...point,
      timeMs: event.timeStamp,
    });
    pressed.current = { button, clickCount };
    send({
      type: "mouse",
      event: "down",
      ...point,
      button,
      clickCount,
      modifiers: modifierBits(event, mac),
    });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!live) return;
    const point = pointAt(event, pressed.current !== null);
    if (!point) return;
    send({
      type: "mouse",
      event: "move",
      ...point,
      button: pressed.current?.button ?? "none",
      clickCount: 0,
      modifiers: modifierBits(event, mac),
    });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const down = pressed.current;
    if (!down) return;
    if (event.type === "pointerup" && mouseButton(event.button) !== down.button)
      return;
    pressed.current = null;
    const point = pointAt(event, true);
    if (!point) return;
    send({
      type: "mouse",
      event: "up",
      ...point,
      button: down.button,
      clickCount: down.clickCount,
      modifiers: modifierBits(event, mac),
    });
  };

  const onKey = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    phase: "down" | "up",
  ) => {
    if (!live || isImeComposing(event)) return;
    const shortcut = viewerShortcut(event.nativeEvent, mac);
    if (shortcut === "paste") return;
    event.preventDefault();
    if (shortcut === "focusAddress") {
      if (phase === "down") addressRef.current?.focus();
      return;
    }
    send(keyAction(event.nativeEvent, phase, mac));
  };

  const onWheel = useEffectEvent((event: WheelEvent) => {
    if (!live || !frame) return;
    const point = pointAt(event, false);
    if (!point) return;
    event.preventDefault();
    const delta = (value: number, pageSize: number) =>
      wheelDelta({ delta: value, deltaMode: event.deltaMode, pageSize });
    send({
      type: "wheel",
      ...point,
      deltaX: delta(event.deltaX, frame.width),
      deltaY: delta(event.deltaY, frame.height),
      modifiers: modifierBits(event, mac),
    });
  });

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const listener = (event: WheelEvent) => onWheel(event);
    surface.addEventListener("wheel", listener, { passive: false });
    return () => surface.removeEventListener("wheel", listener);
  }, []);

  const resizeRemote = placement === "panel" && live;
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!resizeRemote || !surface) return;
    const pending = { timer: 0, sent: "" };
    const stop = observeSharedResize(surface, {
      read: (entry) =>
        remoteViewportSize(
          entry?.contentRect ?? surface.getBoundingClientRect(),
        ),
      write: (size) => {
        window.clearTimeout(pending.timer);
        pending.timer = window.setTimeout(() => {
          const key = `${size.width}x${size.height}`;
          if (key === pending.sent) return;
          pending.sent = key;
          send({ type: "resize", ...size });
        }, RESIZE_DEBOUNCE_MS);
      },
    });
    return () => {
      stop();
      window.clearTimeout(pending.timer);
    };
  }, [resizeRemote, send]);

  const aspect = frame ?? { width: 16, height: 9 };

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col",
        placement === "panel"
          ? "size-full bg-background"
          : "overflow-hidden rounded-md border border-border/60 bg-background",
      )}
    >
      <div
        role="toolbar"
        aria-label="Browser controls"
        className="flex shrink-0 items-center gap-0.5 border-b border-border px-1 py-1"
      >
        <ToolbarButton
          label="Back"
          icon="ArrowLeft"
          disabled={!live}
          onClick={() => send({ type: "history", delta: -1 })}
        />
        <ToolbarButton
          label="Forward"
          icon="ArrowRight"
          disabled={!live}
          onClick={() => send({ type: "history", delta: 1 })}
        />
        <ToolbarButton
          label="Reload"
          icon="RotateCcw"
          disabled={!live}
          onClick={() => send({ type: "reload" })}
        />
        <AddressField
          url={frame?.url ?? ""}
          disabled={!live}
          inputRef={addressRef}
          onNavigate={(url) => send({ type: "navigate", url })}
          onDone={() => surfaceRef.current?.focus({ preventScroll: true })}
        />
        <TabMenu
          tabs={frame?.tabs ?? []}
          activeTabId={frame?.activeTabId ?? null}
          disabled={!live}
          send={send}
        />
        <ToolbarButton
          label="New tab"
          icon="Plus"
          disabled={!live}
          onClick={() => send({ type: "newTab" })}
        />
        <span
          role="status"
          title={inputError ?? undefined}
          className={cn(
            "shrink-0 px-1.5 text-2xs",
            inputError ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {inputError ? "Input failed" : STATUS_LABEL[status]}
        </span>
      </div>
      <div
        className={cn(
          "min-h-0",
          placement === "panel" ? "flex-1" : "mx-auto w-full",
        )}
        style={
          placement === "dialog"
            ? {
                aspectRatio: `${aspect.width} / ${aspect.height}`,
                maxWidth: `calc(72dvh * ${aspect.width / aspect.height})`,
              }
            : undefined
        }
      >
        <div
          ref={surfaceRef}
          tabIndex={0}
          role="application"
          aria-roledescription="remote browser"
          aria-label={`Remote browser: ${title}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(event) => event.preventDefault()}
          onKeyDown={(event) => onKey(event, "down")}
          onKeyUp={(event) => onKey(event, "up")}
          onPaste={(event) => {
            if (!live) return;
            const text = event.clipboardData
              .getData("text/plain")
              .slice(0, MAX_PASTE_LENGTH);
            event.preventDefault();
            if (text !== "") send({ type: "text", text });
          }}
          className="size-full touch-none select-none outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {frame ? (
            <img
              ref={imageRef}
              src={`data:${frame.mimeType};base64,${frame.data}`}
              alt={
                status === "live"
                  ? `Live view of ${title}`
                  : `Last view of ${title}`
              }
              draggable={false}
              className={cn(
                "pointer-events-none block size-full object-contain",
                status !== "live" && "opacity-60",
              )}
            />
          ) : (
            <div
              role="status"
              aria-busy="true"
              aria-label="Loading browser preview"
              className="size-full"
            >
              <Skeleton className="size-full rounded-none" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
