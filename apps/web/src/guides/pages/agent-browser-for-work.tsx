import { BrowserConcept } from "../concepts";
import { BulletList, PromptBlock } from "../guide-blocks";
import { withIntake } from "../prompt-intake";
import type { Guide } from "../guide-types";
import {
  BROWSER_FAQ,
  BROWSER_TROUBLESHOOTING,
  PLUGINS_STEP,
  SIGN_INS_STEP,
} from "../shared/browser";
import { meta } from "./agent-browser-for-work.meta";

const AGENT_PROMPT = withIntake(
  [
    { label: "Task", hint: "what you want found, compared, or filled in" },
    { label: "Sites", hint: "where to look" },
    { label: "Logins", hint: "sites that need your account, if any" },
    { label: "Bring back", hint: "e.g. a table with a source link per row" },
  ],
  `Use a real browser to do a web task I give you, and show me what you found.
Guide: https://getbb.app/guides/agent-browser-for-work

Do every step below, with a Check after each step. Stop if a check fails and tell me what failed.

1. Set up browser access. Run bb plugin list. Browser Automation isn't installed by default: install it with bb plugin install browser-automation --yes if it's missing, or enable it with bb plugin enable browser-automation if it's off. Then read bb guide browser and bb browser-automation --help.
   Check: the plugin is running.

2. Open the browser. Run bb browser-automation list --json and reuse a ready session if this thread has one. Otherwise run:
   bb browser-automation open --json
   This opens the Remote browser on this thread's machine. It's the same browser I see in the side panel, so I can watch and my logins there carry over. Keep the returned session ID and emit the returned previewDirective once. Don't use bb browser commands; they drive my desktop tabs.
   Check: the first page loads. For a site in Logins, confirm the expected account is signed in. If it isn't, stop and ask me to sign in once in the side panel's Remote browser tab, then continue. Never read or print cookie values.

3. Do the task. Take a fresh snapshot before each action and use its element references. Read pages instead of guessing, and keep a list of the sources you used. If a page doesn't state a number, say so instead of filling it in from memory. Don't buy anything, send messages, submit forms that commit me to something, or change account settings unless I asked for exactly that; stop and ask first.
   Check: you have the information or result I asked for, with the page each fact came from.

4. Report. Close your session with bb browser-automation close <session-id>; my own tabs stay open.
   Check: reply with the result in the format from my Bring back answer (by default, a table with a source per row), a source link for each fact, screenshots of anything I should look at, and what you couldn't do.

If it's a task I'll want again, offer to save these steps as a bb skill in .bb/skills/<short-name>/SKILL.md with my answers filled in, or as a bb automation if it should run on a schedule.`,
);

export const guide: Guide = {
  ...meta,
  description:
    "Your agent compares pricing pages, pulls numbers from your dashboards, and fills in forms, in a browser you can watch.",
  heroTop: null,
  concept: <BrowserConcept scene="work" />,
  agentPrompt: AGENT_PROMPT,
  requirement: null,
  steps: [
    {
      ...PLUGINS_STEP,
      lead: (
        <>
          The <a href="/marketplace/browser-automation">Browser Automation</a>{" "}
          plugin gives your agent a browser.
        </>
      ),
      body: (
        <p>
          Choose <strong>Plugins</strong> in the sidebar, search for “browser”,
          open <strong>Browser Automation</strong>, and choose{" "}
          <strong>Install</strong>. It's made by bb but isn't installed until
          you add it.
        </p>
      ),
    },
    {
      ...SIGN_INS_STEP,
      lead: "For dashboards and tools behind a login, sign in once yourself. Your agent uses the same browser.",
    },
    {
      id: "ask",
      title: "Ask for the job",
      lead: "Say what you need, which sites to use, and what to bring back.",
      body: (
        <>
          <p>
            Choose <strong>New thread</strong>, set the project to{" "}
            <strong>Don't work in a project</strong>, then paste your request:
          </p>
          <PromptBlock
            name="Example"
            prompt="Compare the cheapest paid plans of Taskly, Linear, and Trello from their pricing pages: the plan name and its price per user per month, billed yearly. Put the result in a table and link each price to the page it came from."
          />
          <p>Jobs that work well:</p>
          <BulletList>
            <li>
              <strong>Research.</strong> Compare plans, pricing, or reviews
              across sites.
            </li>
            <li>
              <strong>Dashboards.</strong> Pull this week's numbers from
              analytics, billing, or ad accounts into one summary.
            </li>
            <li>
              <strong>Forms.</strong> Fill in the same details on several sites,
              and stop before anything is submitted.
            </li>
            <li>
              <strong>Every week.</strong> Pair it with an{" "}
              <a href="/guides/run-an-agent-on-a-schedule">automation</a> and
              have the report ready each morning.
            </li>
          </BulletList>
          <p>
            Watch your agent work in the side panel's Remote browser tab. Click
            and type there yourself when it needs you, like for a two-factor
            code.
          </p>
        </>
      ),
      shot: {
        src: "/guides/agent-browser-for-work/window-ask-remote.webp",
        alt: "A bb thread with a table comparing the cheapest paid plans of Taskly, Linear, and Trello, next to Taskly's pricing page in the side panel's Remote browser tab",
        width: 2048,
        height: 1280,
      },
      options: [],
    },
  ],
  troubleshooting: BROWSER_TROUBLESHOOTING,
  faq: [
    {
      question: "Do I need a code project?",
      answer: (
        <p>
          No. When you start the thread, set the project to{" "}
          <strong>Don't work in a project</strong>, and ask for the job.
        </p>
      ),
    },
    {
      question: "Will it buy things or send messages for me?",
      answer: (
        <p>
          Not unless you ask. The prompt tells it to stop and ask first, and for
          a hard stop, choose <strong>Accept Edits</strong> in the permission
          menu below the message box. Your agent then needs your OK before it
          acts in the browser.
        </p>
      ),
    },
    {
      question: "What if a site doesn't list the number I asked for?",
      answer: (
        <p>
          Ask your agent to say so instead of guessing, and to link the page it
          checked so you can look yourself.
        </p>
      ),
    },
    ...BROWSER_FAQ,
  ],
  closer: {
    title: "Get the answer, with sources.",
    body: "Free and open source. Use the agents you already have.",
  },
};
