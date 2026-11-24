import { BrowserConcept } from "../concepts";
import { PromptBlock, Ui } from "../guide-blocks";
import { skillOffer, withIntake } from "../prompt-intake";
import type { Guide } from "../guide-types";
import {
  annotateStep,
  BROWSER_FAQ,
  BROWSER_TROUBLESHOOTING,
  PLUGINS_STEP,
  SIGN_INS_STEP,
} from "../shared/browser";
import { meta } from "./agent-browser.meta";

const AGENT_PROMPT = withIntake(
  [
    { label: "App URL", hint: "e.g. http://localhost:3000" },
    { label: "Flow to check", hint: "the change to click through" },
    { label: "Screen sizes", hint: "e.g. desktop and phone" },
    { label: "Needs a sign-in", hint: "yes or no" },
  ],
  `Use a real browser to check my app, click through the change, and show me screenshots.
Guide: https://getbb.app/guides/agent-browser

Do every step below, with a Check after each step. Stop if a check fails and tell me what failed. Don't commit, push, or deploy unless I ask.

1. Set up browser access. Run bb plugin list. Browser Automation isn't installed by default: install it with bb plugin install browser-automation --yes if it's missing, or enable it with bb plugin enable browser-automation if it's off. Agent Annotations is built in but off: enable it with bb plugin enable agent-annotations. Then read bb guide browser and bb browser-automation --help.
   Check: both plugins are running.

2. Open the app.
   2a. If the App URL needs a dev server, start it with the project's documented command in a bb terminal in this environment, and check that the URL responds.
   2b. Run bb browser-automation list --json and reuse a ready session if this thread has one. Otherwise run:
   bb browser-automation open --json
   This opens the Remote browser on this thread's machine, the same browser I see in the side panel, so localhost means this machine and my logins there carry over. Keep the returned session ID and emit the returned previewDirective once. Use bb browser-automation run to get a named page, navigate, and snapshot it; follow bb guide browser for the script format. Each run times out after 30 seconds by default. Don't use bb browser commands; they drive my desktop tabs.
   Check: the page shows the intended app. If Needs a sign-in is yes, verify the expected account. If it's signed out, stop and ask me to sign in once in the side panel's Remote browser tab, then continue. Never read or print cookie values.

3. Verify the change. Take a fresh snapshot, click through the requested flow using its element references, and check the visible result. Check the console and the layout at each size in Screen sizes. Use bb browser-automation screenshot <session-id> --page <name> --json and inspect the returned images. Show the screenshots that matter in this thread as images. Fix failures within the requested change and recheck the affected flow.
   Check: the flow behaves as requested, the layout works at each size, and any console errors are explained. Report what you actually exercised and show the screenshots; don't call a screenshot alone a passing interaction test.

4. Leave the app ready for feedback. Close your session with bb browser-automation close <session-id>; my own tabs stay open. Keep the dev server running. Give me an address for the app that my computer can reach. Tell me I can open it in a Browser tab in the bb desktop app, choose Annotate elements, click the element, write the change, and choose Add to prompt. When I send an annotation, use its element context to make the change and verify it in a new browser session.
   Check: your session is closed and the dev server still responds. Report the URL, terminal ID, screenshots, and anything you couldn't verify.

${skillOffer("check-in-browser", "my App URL, dev server command, sign-in, and Screen sizes")}`,
);

export const guide: Guide = {
  ...meta,
  description:
    "Have your coding agent check its own work and show you screenshots. Then you annotate what to change instead of describing it.",
  heroTop: null,
  concept: <BrowserConcept scene="code" />,
  agentPrompt: AGENT_PROMPT,
  requirement: "the bb desktop app for annotations",
  steps: [
    PLUGINS_STEP,
    SIGN_INS_STEP,
    {
      id: "check",
      title: "Ask your agent to try its change",
      lead: "Give it a flow to exercise and the screen sizes you care about.",
      body: (
        <>
          <PromptBlock
            name="Example"
            prompt="I just added status filters to the Orders page. Start the dev server, open the app in a browser, and try the filters at desktop and phone sizes. Fix anything broken, and show me screenshots."
          />
          <p>
            Your agent starts the dev server, opens the Remote browser, and
            clicks through the flow. A live preview in the thread lets you
            watch.
          </p>
        </>
      ),
      shot: {
        src: "/guides/agent-browser/window-check-full.webp",
        alt: "A bb thread where the agent is trying new order filters, with the full live preview of the Acme Store Orders page in its browser",
        width: 2048,
        height: 1280,
      },
      options: [
        {
          title: "See the screenshots",
          body: (
            <p>
              Ask for them in the thread, like “show me the phone screenshots
              before and after, side by side.” Here, the agent found the search
              box and Total column cut off on a phone, fixed the CSS, and posted
              both.
            </p>
          ),
          shot: {
            src: "/guides/agent-browser/window-screenshots-full.webp",
            alt: "The agent's phone screenshots side by side in a bb thread: before, the search box and Total column are cut off; after, both fit",
            width: 2048,
            height: 1280,
          },
        },
      ],
    },
    annotateStep({
      title: "Point at what to change",
      lead: "Select the element instead of describing where it is.",
      open: (
        <>
          In the bb desktop app, open the side panel <Ui icon="side-panel" /> (⌘
          J), choose <Ui icon="plus" />, then <strong>Open browser</strong>, and
          enter the app address your agent gave you.
        </>
      ),
      target: "the element",
      note: "your note",
      shot: {
        src: "/guides/agent-browser/window-annotate.webp",
        alt: "A Browser tab in bb with the All filter selected for annotation, and the note: Use our brand blue for the selected filter, like Export CSV",
        width: 2048,
        height: 1280,
      },
    }),
  ],
  troubleshooting: BROWSER_TROUBLESHOOTING,
  faq: [
    {
      question: "Can it test my app at phone sizes?",
      answer: (
        <p>
          Yes. Ask for the sizes you care about, like “desktop and iPhone.” The
          agent resizes the browser and takes a screenshot at each size.
        </p>
      ),
    },
    {
      question: "Does my dev server need to run on the same machine?",
      answer: (
        <p>
          It's easiest. The agent starts the dev server in a terminal in the
          thread, and the Remote browser runs on the same machine, so{" "}
          <code>localhost</code> works.
        </p>
      ),
    },
    {
      question: "Can I point at a Figma design?",
      answer: (
        <p>
          Annotations select elements on a webpage, not layers in Figma.
          Annotate the running app, and attach a screenshot of the design for
          reference.
        </p>
      ),
    },
    {
      question: "Can it do more than test my app?",
      answer: (
        <p>
          Yes. The same browser handles research, signed-in dashboards, and
          forms. See{" "}
          <a href="/guides/agent-browser-for-work">
            Get research and reports from any site
          </a>
          .
        </p>
      ),
    },
    ...BROWSER_FAQ,
  ],
  closer: {
    title: "Let your agent check its own work.",
    body: "Free and open source. Use the agents you already have.",
  },
};
