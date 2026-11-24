import {
  useEffect,
  useEffectEvent,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  experimental_useTabVisible,
  useRpc,
  type ExperimentalTabReference,
  type ExperimentalThreadActionTabProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, Session } from "./contracts.js";
import { useDocumentVisible, useLivePreview } from "./live-preview.js";
import { InteractiveViewer } from "./viewer.js";

const LIST_INTERVAL_MS = 5_000;

export const REMOTE_BROWSER_TAB = {
  id: "remote-browser",
  context: { kind: "thread" },
  availability: "action",
} as const satisfies ExperimentalTabReference;

const pendingStarts = new Set<string>();
const startListeners = new Set<() => void>();

function publishStarts() {
  for (const listener of [...startListeners]) listener();
}

export function requestBrowserStart(threadId: string): void {
  pendingStarts.add(threadId);
  publishStarts();
}

export function cancelBrowserStart(threadId: string): void {
  if (pendingStarts.delete(threadId)) publishStarts();
}

function subscribeStarts(listener: () => void): () => void {
  startListeners.add(listener);
  return () => startListeners.delete(listener);
}

function useStartRequested(threadId: string): boolean {
  return useSyncExternalStore(
    subscribeStarts,
    () => pendingStarts.has(threadId),
    () => false,
  );
}

type StartState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "failed"; message: string };

function newestReadySession(sessions: readonly Session[]): Session | null {
  let newest: Session | null = null;
  for (const session of sessions)
    if (
      session.state === "ready" &&
      (newest === null || session.createdAt > newest.createdAt)
    )
      newest = session;
  return newest;
}

function SessionViewer({
  threadId,
  sessionId,
  visible,
  onEnded,
}: {
  threadId: string;
  sessionId: string;
  visible: boolean;
  onEnded: () => void;
}) {
  const { frame, status } = useLivePreview({
    threadId,
    sessionId,
    enabled: visible,
    size: "full",
    initialFrame: null,
  });
  const ended = status === "ended" || status === "unavailable";
  const reportEnded = useEffectEvent(onEnded);
  useEffect(() => {
    if (ended) reportEnded();
  }, [ended]);
  return (
    <InteractiveViewer
      threadId={threadId}
      sessionId={sessionId}
      frame={frame}
      status={status}
      placement="panel"
    />
  );
}

function CenteredState({ children }: { children: ReactNode }) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-3 p-6 text-center">
      {children}
    </div>
  );
}

export function RemoteBrowserTab({
  threadId,
}: ExperimentalThreadActionTabProps) {
  const rpc = useRpc<typeof rpcContract>();
  const visible = useDocumentVisible() && experimental_useTabVisible();
  const [sessions, setSessions] = useState<readonly Session[] | null>(null);
  const [listRequest, setListRequest] = useState(0);
  const [start, setStart] = useState<StartState>({ kind: "idle" });
  const startRequested = useStartRequested(threadId);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer: number | null = null;
    const load = async () => {
      try {
        const listed = await rpc.call("list", { threadId });
        if (!cancelled) setSessions(listed);
      } catch {
        if (!cancelled) setSessions((current) => current ?? []);
      }
      if (!cancelled)
        timer = window.setTimeout(() => void load(), LIST_INTERVAL_MS);
    };
    void load();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [listRequest, rpc, threadId, visible]);

  const startBrowser = async () => {
    setStart({ kind: "starting" });
    try {
      const opened = await rpc.call("openForThread", { threadId });
      setSessions((current) => [
        opened,
        ...(current ?? []).filter((session) => session.id !== opened.id),
      ]);
      setStart({ kind: "idle" });
    } catch (error) {
      setStart({
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const startRequestedBrowser = useEffectEvent(() => {
    cancelBrowserStart(threadId);
    void startBrowser();
  });
  useEffect(() => {
    if (startRequested) startRequestedBrowser();
  }, [startRequested]);

  const session = sessions === null ? null : newestReadySession(sessions);

  if (session !== null)
    return (
      <SessionViewer
        key={session.id}
        threadId={threadId}
        sessionId={session.id}
        visible={visible}
        onEnded={() => setListRequest((value) => value + 1)}
      />
    );

  if (start.kind === "starting")
    return (
      <CenteredState>
        <Icon
          name="Spinner"
          className="size-5 animate-spin text-muted-foreground"
          aria-hidden
        />
        <div role="status" className="flex flex-col gap-1">
          <p className="text-sm text-foreground">Starting browser…</p>
          <p className="text-xs text-muted-foreground">
            The first start on a machine can take a minute while the browser
            installs.
          </p>
        </div>
      </CenteredState>
    );

  if (sessions === null)
    return (
      <CenteredState>
        <Icon
          name="Spinner"
          className="size-5 animate-spin text-muted-foreground"
          aria-label="Loading browser sessions"
        />
      </CenteredState>
    );

  return (
    <CenteredState>
      <Icon name="Globe" className="size-6 text-muted-foreground" aria-hidden />
      <div className="flex max-w-xs flex-col gap-1">
        <p className="text-sm text-foreground">No browser is running</p>
        <p className="text-xs text-muted-foreground">
          Start a browser on this thread's machine. You and the agent share it
          and its sign-ins.
        </p>
      </div>
      {start.kind === "failed" ? (
        <p role="alert" className="max-w-xs text-xs text-destructive">
          {start.message}
        </p>
      ) : null}
      <Button type="button" size="sm" onClick={() => void startBrowser()}>
        {start.kind === "failed" ? "Try again" : "Start browser"}
      </Button>
    </CenteredState>
  );
}
