// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { experimental_makeActionContext } from "@get-bb/plugin-sdk/testing";
import type { ExperimentalTabRegistration } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PreviewFrame, Session, ViewerAction } from "./contracts.js";
import { closeLightbox } from "./lightbox-store.js";

const app = await loadPluginApp(() => import("./app"));
const directive = app.messageDirectives[0]!;
const overlay = app.appOverlays[0]!;
const tab = app.tabs.find(
  (
    registration,
  ): registration is Extract<
    ExperimentalTabRegistration,
    { context: { kind: "thread" }; availability: "action" }
  > =>
    registration.context.kind === "thread" &&
    registration.availability === "action",
)!;

afterEach(() => {
  cleanup();
  closeLightbox();
});

const session: Session = {
  id: "1a12a3f1-12de-4fbb-a011-df0905678757",
  threadId: "thr_1",
  hostId: "host",
  profile: "default",
  state: "ready",
  createdAt: 1,
  expiresAt: 4_000_000_000_000,
};
const frame = (
  sequence: number,
  title = "Cart",
  url = "https://shop.test/cart?step=2",
): PreviewFrame => ({
  sequence,
  mimeType: "image/jpeg",
  data: `bytes${sequence}`,
  width: 1280,
  height: 640,
  url,
  title,
  tabs: [{ id: "tab-1", title, url }],
  activeTabId: "tab-1",
});
const hang = () => new Promise<never>(() => {});
const props = (sessionId: string = session.id) => ({
  attributes: { session: sessionId },
  source: `::browser-preview{session="${sessionId}"}`,
  message: { id: "msg_1", threadId: "thr_1", turnId: "turn_1", projectId: "p" },
  openWorkspaceFile: null,
});
const previewInputs = (slot: {
  rpcCalls: { method: string; input: unknown }[];
}) =>
  slot.rpcCalls
    .filter((call) => call.method === "preview")
    .map((call) => call.input);

describe("inline browser preview", () => {
  it("rejects a malformed session attribute without calling the server", async () => {
    const slot = renderSlot(directive, props("not-a-session"), { rpc: {} });
    expect((await slot.findByRole("alert")).textContent).toMatch(
      /valid session attribute/,
    );
    expect(slot.rpcCalls).toEqual([]);
  });

  it("streams frames by resuming from the last sequence", async () => {
    let polls = 0;
    let deliverFirst!: () => void;
    const firstRequested = new Promise<void>((resolve) => {
      deliverFirst = resolve;
    });
    const slot = renderSlot(directive, props(), {
      rpc: {
        preview: async () => {
          polls += 1;
          if (polls === 1) {
            await firstRequested;
            return { session, frame: frame(4) };
          }
          if (polls === 2) return { session, frame: frame(5, "Checkout") };
          return hang();
        },
      },
    });
    expect(await slot.findByRole("status")).toBeTruthy();
    expect(slot.getByText("Connecting")).toBeTruthy();
    deliverFirst();
    const first = await slot.findByAltText("Live view of Cart");
    expect(first.getAttribute("src")).toBe("data:image/jpeg;base64,bytes4");
    expect(slot.getByText("shop.test/cart")).toBeTruthy();
    expect(slot.getByText("Live")).toBeTruthy();
    const second = await slot.findByAltText(
      "Live view of Checkout",
      {},
      { timeout: 3_000 },
    );
    expect(second.getAttribute("src")).toBe("data:image/jpeg;base64,bytes5");
    await waitFor(() =>
      expect(previewInputs(slot)).toEqual(
        [0, 4, 5].map((afterSequence) => ({
          threadId: "thr_1",
          sessionId: session.id,
          afterSequence,
          size: "thumbnail",
        })),
      ),
    );
  });

  it("labels pages that have no web address without dumping their URL", async () => {
    const slot = renderSlot(directive, props(), {
      rpc: {
        preview: () => ({
          session,
          frame: frame(1, "", "data:text/html,%3Ch1%3Every-long-inline-page"),
        }),
      },
    });
    await slot.findByAltText("Live view of Remote browser");
    expect(slot.getByText("data:")).toBeTruthy();
    expect(slot.queryByText(/very-long-inline-page/)).toBeNull();
  });

  it("does not repeat the address as the title of a blank page", async () => {
    const slot = renderSlot(directive, props(), {
      rpc: {
        preview: () => ({
          session,
          frame: frame(1, "about:blank", "about:blank"),
        }),
      },
    });
    await slot.findByAltText("Live view of Remote browser");
    expect(slot.getAllByText("about:blank")).toHaveLength(1);
  });

  it("stops polling while collapsed", async () => {
    let polls = 0;
    const slot = renderSlot(directive, props(), {
      rpc: {
        preview: () => {
          polls += 1;
          return { session, frame: frame(polls) };
        },
      },
    });
    await slot.findByAltText("Live view of Cart");
    fireEvent.click(slot.getByRole("button", { name: /^Browser preview:/ }));
    expect(slot.queryByRole("img")).toBeNull();
    const settled = polls;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(polls).toBe(settled);
    fireEvent.click(slot.getByRole("button", { name: /^Browser preview:/ }));
    await waitFor(() => expect(polls).toBeGreaterThan(settled));
  });

  it("stops polling while scrolled out of view", async () => {
    const observers: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(
          callback: (entries: { isIntersecting: boolean }[]) => void,
        ) {
          observers.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    try {
      let polls = 0;
      const slot = renderSlot(directive, props(), {
        rpc: {
          preview: () => {
            polls += 1;
            return { session, frame: frame(polls) };
          },
        },
      });
      await slot.findByAltText("Live view of Cart");
      expect(observers).toHaveLength(1);
      act(() => observers[0]!([{ isIntersecting: false }]));
      const settled = polls;
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(polls).toBe(settled);
      expect(slot.getByRole("img")).toBeTruthy();
      act(() => observers[0]!([{ isIntersecting: true }]));
      await waitFor(() => expect(polls).toBeGreaterThan(settled));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the last view when the session ends and stops asking", async () => {
    let polls = 0;
    const slot = renderSlot(directive, props(), {
      rpc: {
        preview: () => {
          polls += 1;
          return polls === 1
            ? { session, frame: frame(1) }
            : { session: { ...session, state: "closed" }, frame: null };
        },
      },
    });
    const last = await slot.findByAltText(
      "Last view of Cart",
      {},
      { timeout: 3_000 },
    );
    expect(last.getAttribute("src")).toBe("data:image/jpeg;base64,bytes1");
    expect(slot.getByText("Ended")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(polls).toBe(2);
    expect(
      slot.getByRole("button", { name: "Expand browser preview" }),
    ).toBeTruthy();
  });

  it("shows only a closed header for a session that ended before it was viewed", async () => {
    const slot = renderSlot(directive, props(), {
      rpc: {
        preview: () => ({
          session: { ...session, state: "closed" },
          frame: null,
        }),
      },
    });
    await slot.findByText("Ended");
    expect(slot.queryByRole("img")).toBeNull();
    expect(slot.queryByRole("status")).toBeNull();
    expect(
      slot.queryByRole("button", { name: "Expand browser preview" }),
    ).toBeNull();
  });

  it("gives up on a session it can never read, such as one copied into a fork", async () => {
    vi.useFakeTimers();
    try {
      const slot = renderSlot(directive, props(), {
        rpc: {
          preview: () => {
            throw new Error("Session does not belong to this thread");
          },
        },
      });
      for (let attempt = 0; attempt < 8; attempt++)
        await act(() => vi.advanceTimersByTimeAsync(16_000));
      expect(slot.getByText("Unavailable")).toBeTruthy();
      expect(previewInputs(slot)).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("expanded browser preview", () => {
  const sizes = (slot: { rpcCalls: { method: string; input: unknown }[] }) =>
    previewInputs(slot).map((input) =>
      typeof input === "object" && input !== null && "size" in input
        ? input.size
        : null,
    );

  it("opens instantly from the card's frame, streams full size, and hands back on close", async () => {
    let cardPolls = 0;
    let overlayPolls = 0;
    const card = renderSlot(directive, props(), {
      rpc: {
        preview: () => {
          cardPolls += 1;
          return { session, frame: frame(cardPolls, "Thumbnail") };
        },
      },
    });
    const lightbox = renderSlot(
      overlay,
      {},
      {
        rpc: {
          preview: () => {
            overlayPolls += 1;
            return { session, frame: frame(100 + overlayPolls, "Full size") };
          },
        },
      },
    );
    await card.findByAltText("Live view of Thumbnail");
    expect(lightbox.queryByRole("dialog")).toBeNull();
    expect(overlayPolls).toBe(0);

    fireEvent.click(
      card.getByRole("button", { name: "Expand browser preview" }),
    );
    const dialog = await lightbox.findByRole("dialog");
    expect(dialog.querySelector("img")).toBeTruthy();
    await waitFor(() =>
      expect(dialog.querySelector("img")!.getAttribute("alt")).toBe(
        "Live view of Full size",
      ),
    );
    expect(dialog.textContent).toContain("shop.test/cart · Live");
    expect(new Set(sizes(lightbox))).toEqual(new Set(["full"]));
    const pausedAt = cardPolls;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(cardPolls).toBe(pausedAt);

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(lightbox.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(cardPolls).toBeGreaterThan(pausedAt));
    expect(new Set(sizes(card))).toEqual(new Set(["thumbnail"]));
    const stoppedAt = overlayPolls;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(overlayPolls).toBe(stoppedAt);
  });

  it("stays open and live when the inline card is paginated out of the timeline", async () => {
    let overlayPolls = 0;
    const card = renderSlot(directive, props(), {
      rpc: { preview: () => ({ session, frame: frame(1) }) },
    });
    const lightbox = renderSlot(
      overlay,
      {},
      {
        rpc: {
          preview: () => {
            overlayPolls += 1;
            return { session, frame: frame(100 + overlayPolls) };
          },
        },
      },
    );
    await card.findByAltText("Live view of Cart");
    fireEvent.click(
      card.getByRole("button", { name: "Expand browser preview" }),
    );
    await lightbox.findByRole("dialog");
    card.unmount();
    const before = overlayPolls;
    await waitFor(() => expect(overlayPolls).toBeGreaterThan(before + 1), {
      timeout: 3_000,
    });
    expect(lightbox.getByRole("dialog").querySelector("img")).toBeTruthy();
  });

  it("keeps the last view when the session ends while expanded", async () => {
    const card = renderSlot(directive, props(), {
      rpc: { preview: () => ({ session, frame: frame(1) }) },
    });
    const lightbox = renderSlot(
      overlay,
      {},
      {
        rpc: {
          preview: () => ({
            session: { ...session, state: "closed" },
            frame: null,
          }),
        },
      },
    );
    await card.findByAltText("Live view of Cart");
    fireEvent.click(
      card.getByRole("button", { name: "Expand browser preview" }),
    );
    const dialog = await lightbox.findByRole("dialog");
    await waitFor(() => expect(dialog.textContent).toContain("Ended"));
    expect(dialog.querySelector("img")!.getAttribute("alt")).toBe(
      "Last view of Cart",
    );
    expect(previewInputs(lightbox)).toHaveLength(1);
  });
});

describe("remote browser side panel", () => {
  const tabProps = { threadId: "thr_1", environment: null, params: null };
  const inputBatches = (slot: {
    rpcCalls: { method: string; input: unknown }[];
  }) =>
    slot.rpcCalls
      .filter((call) => call.method === "input")
      .map((call) => {
        const input = call.input as {
          sessionId: string;
          actions: ViewerAction[];
        };
        expect(input.sessionId).toBe(session.id);
        return input.actions;
      });
  const renderViewer = async (input: () => unknown) => {
    let polls = 0;
    const slot = renderSlot(tab, tabProps, {
      rpc: {
        list: () => [session],
        preview: () => {
          polls += 1;
          return polls === 1 ? { session, frame: frame(1) } : hang();
        },
        input,
      },
    });
    const image = await slot.findByAltText("Live view of Cart");
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 10, y: 20, width: 640, height: 400 }),
    );
    const surface = slot.getByRole("application");
    return { slot, surface };
  };
  const pointer = (clientX: number, clientY: number) => ({
    clientX,
    clientY,
    button: 0,
    pointerId: 1,
  });

  it("starts a browser for the thread from the empty state", async () => {
    let finishStart!: (session: Session) => void;
    const slot = renderSlot(tab, tabProps, {
      rpc: {
        list: () => [],
        openForThread: () =>
          new Promise<Session>((resolve) => {
            finishStart = resolve;
          }),
        preview: hang,
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Start browser" }));
    expect(await slot.findByText("Starting browser…")).toBeTruthy();
    expect(
      slot.rpcCalls.filter((call) => call.method === "openForThread"),
    ).toEqual([{ method: "openForThread", input: { threadId: "thr_1" } }]);
    act(() => finishStart(session));
    expect(
      await slot.findByRole("toolbar", { name: "Browser controls" }),
    ).toBeTruthy();
  });

  it("starts the browser when launched from the panel menu", async () => {
    const context = experimental_makeActionContext({
      panel: { ...experimental_makeActionContext().panel, openTab: () => true },
    });
    await tab.run?.({ ...context, ...tabProps });
    const slot = renderSlot(tab, tabProps, {
      rpc: { list: () => [], openForThread: () => session, preview: hang },
    });
    await waitFor(() =>
      expect(slot.rpcCalls.map((call) => call.method)).toContain(
        "openForThread",
      ),
    );
  });

  it("clicks the remote page at the point under the pointer, ignoring letterboxing", async () => {
    const { slot, surface } = await renderViewer(() => ({ ok: true }));
    fireEvent.pointerDown(surface, pointer(110, 110));
    fireEvent.pointerUp(surface, pointer(110, 110));
    await waitFor(() => expect(inputBatches(slot).flat()).toHaveLength(2));
    expect(inputBatches(slot).flat()).toEqual([
      expect.objectContaining({ event: "down", x: 200, y: 100, clickCount: 1 }),
      expect.objectContaining({ event: "up", x: 200, y: 100, clickCount: 1 }),
    ]);
    fireEvent.pointerDown(surface, pointer(15, 30));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(inputBatches(slot).flat()).toHaveLength(2);
  });

  it("keeps one input request in flight and coalesces moves behind it", async () => {
    const replies: (() => void)[] = [];
    const { slot, surface } = await renderViewer(
      () =>
        new Promise((resolve) => {
          replies.push(() => resolve({ ok: true }));
        }),
    );
    fireEvent.pointerDown(surface, pointer(110, 110));
    await waitFor(() => expect(inputBatches(slot)).toHaveLength(1));
    for (const x of [120, 130, 140])
      fireEvent.pointerMove(surface, pointer(x, 110));
    fireEvent.pointerUp(surface, pointer(140, 110));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(inputBatches(slot)).toHaveLength(1);
    act(() => replies[0]!());
    await waitFor(() => expect(inputBatches(slot)).toHaveLength(2));
    expect(inputBatches(slot)[1]).toEqual([
      expect.objectContaining({ event: "move", x: 260, button: "left" }),
      expect.objectContaining({ event: "up", x: 260 }),
    ]);
  });

  it("opens from the chat card's side panel button", async () => {
    const openTab = vi.fn(() => true);
    const card = renderSlot(directive, props(), {
      rpc: { preview: () => ({ session, frame: frame(1) }) },
      experimental_panel: { openTab },
    });
    fireEvent.click(
      await card.findByRole("button", { name: "Open in side panel" }),
    );
    expect(card.experimental_panelCalls).toEqual([
      {
        method: "openTab",
        options: {
          tab: {
            id: "remote-browser",
            context: { kind: "thread" },
            availability: "action",
          },
        },
      },
    ]);
  });
});
