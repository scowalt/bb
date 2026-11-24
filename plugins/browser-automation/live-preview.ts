import { useEffect, useState, useSyncExternalStore } from "react";
import {
  experimental_sliceUtf16Head as sliceUtf16Head,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PreviewFrame, PreviewSize, rpcContract } from "./contracts.js";

const MIN_POLL_INTERVAL_MS: Record<PreviewSize, number> = {
  thumbnail: 400,
  full: 60,
};
const MAX_RETRY_INTERVAL_MS = 15_000;
const MAX_CONSECUTIVE_FAILURES = 5;

export type PreviewStatus = "connecting" | "live" | "ended" | "unavailable";

export const STATUS_LABEL: Record<PreviewStatus, string> = {
  connecting: "Connecting",
  live: "Live",
  ended: "Ended",
  unavailable: "Unavailable",
};

function subscribeDocumentVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function readDocumentVisible(): boolean {
  return document.visibilityState !== "hidden";
}

export function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeDocumentVisibility,
    readDocumentVisible,
    () => true,
  );
}

export function pageLocation(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:")
      return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
    if (parsed.protocol === "about:") return url;
    if (parsed.protocol === "file:") return decodeURIComponent(parsed.pathname);
    return parsed.protocol;
  } catch {
    return sliceUtf16Head(url, 80);
  }
}

export function pageTitle(frame: PreviewFrame | null): string {
  const title = frame?.title.trim() ?? "";
  return title === "" || title === frame?.url ? "Remote browser" : title;
}

export function useLivePreview(args: {
  threadId: string;
  sessionId: string;
  enabled: boolean;
  size: PreviewSize;
  initialFrame: PreviewFrame | null;
}): { frame: PreviewFrame | null; status: PreviewStatus } {
  const { threadId, sessionId, enabled, size, initialFrame } = args;
  const rpc = useRpc<typeof rpcContract>();
  const [frame, setFrame] = useState<PreviewFrame | null>(initialFrame);
  const [status, setStatus] = useState<PreviewStatus>(
    initialFrame ? "live" : "connecting",
  );
  const settled = status === "ended" || status === "unavailable";

  useEffect(() => {
    if (!enabled || settled) return;
    let cancelled = false;
    let timeout: number | null = null;
    let afterSequence = 0;
    let failures = 0;
    const poll = async () => {
      const startedAt = Date.now();
      let delayMs: number;
      try {
        const result = await rpc.call("preview", {
          threadId,
          sessionId,
          afterSequence,
          size,
        });
        if (cancelled) return;
        if (result.session.state !== "ready") {
          setStatus("ended");
          return;
        }
        failures = 0;
        if (result.frame) {
          afterSequence = result.frame.sequence;
          setFrame(result.frame);
          setStatus("live");
        }
        delayMs = Math.max(
          0,
          MIN_POLL_INTERVAL_MS[size] - (Date.now() - startedAt),
        );
      } catch {
        if (cancelled) return;
        failures += 1;
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          setStatus("unavailable");
          return;
        }
        delayMs = Math.min(1_000 * 2 ** failures, MAX_RETRY_INTERVAL_MS);
      }
      timeout = window.setTimeout(() => void poll(), delayMs);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timeout !== null) window.clearTimeout(timeout);
    };
  }, [enabled, rpc, sessionId, settled, size, threadId]);

  return { frame, status };
}
