import type { ReactNode } from "react";

import { Substeps, Ui } from "../guide-blocks";
import type { GuideFaq, GuideShot, GuideStep } from "../guide-types";
import { AGENTS_FAQ } from "./faq";

export function annotateStep({
  title,
  lead,
  open,
  target,
  note,
  shot,
}: {
  title: string;
  lead: string;
  open: ReactNode;
  target: string;
  note: string;
  shot: GuideShot;
}): GuideStep {
  return {
    id: "annotate",
    title,
    lead,
    body: (
      <Substeps>
        <li>{open}</li>
        <li>
          Choose <Ui icon="annotate">Annotate elements</Ui> in the toolbar and
          click {target}.
        </li>
        <li>
          In the box, write {note} and choose <strong>Add to prompt</strong>.
          Add as many as you like, then send.
        </li>
      </Substeps>
    ),
    shot,
    options: [],
  };
}

export const PLUGINS_STEP: GuideStep = {
  id: "plugins",
  title: "Add the browser plugins",
  lead: (
    <>
      The <a href="/marketplace/browser-automation">Browser Automation</a>{" "}
      plugin gives your agent a browser. The{" "}
      <a href="/marketplace/agent-annotations">Agent Annotations</a> plugin lets
      you point at what you mean.
    </>
  ),
  body: (
    <Substeps>
      <li>
        Choose <strong>Plugins</strong> in the sidebar, search for “browser”,
        open <strong>Browser Automation</strong>, and choose{" "}
        <strong>Install</strong>. It's made by bb but isn't installed until you
        add it.
      </li>
      <li>
        Agent Annotations comes with bb, turned off. In the same list, open{" "}
        <strong>Agent Annotations</strong> and turn on its switch.
      </li>
    </Substeps>
  ),
  shot: {
    src: "/guides/agent-browser/window-plugins-sidebar.webp",
    alt: "bb's Plugins page with Browse plugins selected in the sidebar, a search for browser, and Browser Automation open with an Install button",
    width: 2048,
    height: 1280,
  },
  options: [],
};

export const SIGN_INS_STEP: GuideStep = {
  id: "sign-ins",
  title: "Sign in once in the Remote browser",
  lead: "Your agent uses the same browser you do, so it opens your sites logged in as you.",
  body: (
    <Substeps>
      <li>
        Open a thread on the machine your agent will use. Open the side panel{" "}
        <Ui icon="side-panel" /> (⌘ J), choose <Ui icon="plus" />, then{" "}
        <strong>Remote browser</strong>.
      </li>
      <li>
        Choose <strong>Start browser</strong> if it isn't running. Go to each
        site your agent needs and sign in.
      </li>
      <li>
        That's it. The browser keeps your logins on that machine, even after it
        restarts, and every thread there shares them.
      </li>
    </Substeps>
  ),
  shot: {
    src: "/guides/agent-browser/window-remote-browser.webp",
    alt: "A bb thread where the agent is waiting for a sign-in, next to the Acme Analytics sign-in page in the side panel's Remote browser tab",
    width: 2048,
    height: 1280,
  },
  options: [],
};

export const BROWSER_TROUBLESHOOTING: [GuideFaq, ...GuideFaq[]] = [
  {
    question: "Browser Automation isn't in my installed plugins",
    answer: (
      <ol>
        <li>
          It's not installed by default. Choose <strong>Plugins</strong>, search
          for “browser”, and open <strong>Browser Automation</strong>.
        </li>
        <li>
          Choose <strong>Install</strong>, then confirm. It turns on right away.
        </li>
      </ol>
    ),
  },
  {
    question: "I don't see Annotate elements",
    answer: (
      <ol>
        <li>
          Use the bb desktop app. Annotations only work in a{" "}
          <strong>Browser</strong> tab there, not in the Remote browser or the
          live preview in a thread.
        </li>
        <li>
          In <strong>Plugins</strong>, open <strong>Agent Annotations</strong>{" "}
          and turn on its switch.
        </li>
      </ol>
    ),
  },
  {
    question: "The browser won't start",
    answer: (
      <ol>
        <li>
          Check that the machine is connected in{" "}
          <Ui icon="settings">Settings → Machines</Ui>.
        </li>
        <li>
          The first run installs the browser tools on that machine, so it needs
          network access and npm. It also needs Chrome or Chromium installed
          there.
        </li>
      </ol>
    ),
  },
  {
    question: "The site still asks me to sign in",
    answer: (
      <ol>
        <li>
          Each machine has its own Remote browser. Sign in from a thread on the
          same machine as your agent's thread.
        </li>
        <li>
          Logins you import in <Ui icon="settings">Settings → Browser</Ui> go to
          the desktop app's Browser tabs, not the Remote browser. Sign in once
          in the Remote browser instead.
        </li>
        <li>
          If your agent asked for a clean, signed-out browser, ask it to use the
          default one.
        </li>
      </ol>
    ),
  },
  {
    question: "The live preview says Ended",
    answer: (
      <p>
        Your agent closed its browser session, or it sat unused for 30 minutes.
        The thread keeps the last view. Ask your agent to open it again. Your
        tabs and logins stay in the Remote browser.
      </p>
    ),
  },
];

export const BROWSER_FAQ: GuideFaq[] = [
  AGENTS_FAQ,
  {
    question: "Does it keep working when my laptop sleeps?",
    answer: (
      <p>
        Yes, if your agent runs on another machine, like a dev box. The browser
        runs there, not on your laptop, so you can close the lid and check the
        result later from the web or your phone.
      </p>
    ),
  },
  {
    question: "Do I need the desktop app?",
    answer: (
      <p>
        No. The Remote browser works in the web app too. Only annotations need
        the desktop app.
      </p>
    ),
  },
  {
    question: "Can I stop the agent or step in?",
    answer: (
      <p>
        Yes. You and your agent share the browser. Click and type in the Remote
        browser tab any time, like to enter a sign-in code. To stop your agent,
        stop the thread.
      </p>
    ),
  },
  {
    question: "Can my agent see my passwords?",
    answer: (
      <p>
        You sign in yourself, so you never give your agent a password. The
        browser keeps you logged in, and your agent uses that. The prompt from{" "}
        <strong>Copy for agent</strong> tells your agent never to read or print
        your logins. Anyone who can use that machine can use them, so sign in
        only on machines you trust.
      </p>
    ),
  },
  {
    question: "Can the browser run on a different machine?",
    answer: (
      <p>
        Yes. Ask for the browser on the machine you want, and sign in there
        once. There, <code>localhost</code> means that machine, so use an
        address it can reach.
      </p>
    ),
  },
  {
    question: "Does it need macOS Automation permission?",
    answer: (
      <p>
        No. Browser Automation runs Chrome in the background and controls it
        directly, so it doesn't need Accessibility or Automation permission.
      </p>
    ),
  },
];
