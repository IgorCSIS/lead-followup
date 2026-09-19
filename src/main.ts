/**
 * Lead Follow-up: the app.
 *
 * One screen. Drop a CSV of leads, get an SMS and an email draft for each,
 * urgent ones first, with a copy button on every field.
 *
 * Everything runs in the page. The file is read by the browser, parsed in
 * memory, and never uploaded. There is no account, no key, and no request to
 * anything at runtime, which is what makes this free to run forever and safe
 * to hand a contractor's real lead list.
 */

import "./style.css";
import { parseLeads, draftsToCsv } from "./lib/csv";
import { buildDrafts, DEMO_BUSINESS, SMS_CHARACTER_LIMIT, type Business, type Draft } from "./lib/drafts";
import { copyText, downloadFile, escapeHtml, formatSubmitted } from "./lib/ui";
import {
  clearEndpoint,
  describeEndpoint,
  fetchLeads,
  loadEndpoint,
  normalizeEndpoint,
  saveEndpoint,
  SheetError,
} from "./lib/sheet";

const PORTFOLIO_URL = "https://igorcsis.github.io/niftyai-portfolio/";
const RIDGEVIEW_URL = "https://igorcsis.github.io/ridgeview-remodeling-demo/";
const SETUP_URL = "https://github.com/IgorCSIS/lead-followup/blob/main/tools/sheet-endpoint/README.md";
const SAMPLE_URL = `${import.meta.env.BASE_URL}sample_leads.csv`;

/**
 * How long the copy button holds its confirmation.
 *
 * Long enough to be seen by somebody who has already looked away at their
 * phone to paste, which is exactly what happens in the demo.
 */
const COPY_FEEDBACK_MS = 1400;

interface State {
  business: Business;
  drafts: Draft[];
  urgentOnly: boolean;
  fileName: string;
  notice: { kind: "info" | "warn" | "error"; text: string } | null;
  /** The connected Apps Script endpoint, or "" when working from files. */
  endpoint: string;
  /** Whether the connect panel is expanded. Kept here because every render
      replaces the markup, which would otherwise collapse it mid-typing. */
  sheetOpen: boolean;
  sheetBusy: boolean;
  /** Whether the white-label fields are expanded once drafts are showing. */
  whiteLabelOpen: boolean;
}

const state: State = {
  business: { ...DEMO_BUSINESS },
  drafts: [],
  urgentOnly: false,
  fileName: "",
  notice: null,
  endpoint: loadEndpoint(),
  sheetOpen: false,
  sheetBusy: false,
  whiteLabelOpen: false,
};

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app not found");

/* ------------------------------------------------------------------ view */

function header(): string {
  return `
    <header class="border-b border-ink-700">
      <div class="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-4">
        <div class="flex items-center gap-2.5">
          <svg viewBox="0 0 32 32" class="h-7 w-7" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="#0B1220"/>
            <rect x="6.5" y="7.6" width="19" height="2.8" rx="1.4" fill="#F8FAFC"/>
            <rect x="6.5" y="13.3" width="12.5" height="2.8" rx="1.4" fill="#8FA3BC"/>
            <rect x="6.5" y="19" width="6.5" height="2.8" rx="1.4" fill="#8FA3BC"/>
            <path d="M17.4 17.1h7.4a2.3 2.3 0 0 1 2.3 2.3v3.5a2.3 2.3 0 0 1-2.3 2.3h-3.1l-3.2 2.4a.5.5 0 0 1-.8-.4v-2h-.3a2.3 2.3 0 0 1-2.3-2.3v-3.5a2.3 2.3 0 0 1 2.3-2.3z" fill="#F59E0B"/>
          </svg>
          <span class="font-semibold text-sand-50">Lead Follow-up</span>
        </div>
        <a href="${PORTFOLIO_URL}" target="_blank" rel="noopener noreferrer"
           class="text-sm text-sand-400 hover:text-ember-400">Built by Igor Lima</a>
      </div>
    </header>`;
}

function hero(): string {
  return `
    <section class="mx-auto max-w-5xl px-5 pt-8 sm:pt-14">
      <h1 class="text-3xl font-bold leading-tight tracking-tight text-sand-50 sm:text-4xl">
        Same-day replies for the leads your website just captured
      </h1>
      <p class="mt-4 max-w-2xl text-base leading-relaxed text-sand-200">
        Drop in today's leads. Get a ready-to-send text and email for each one, with the people
        who need a reply today at the top. Whoever answers first usually gets the walkthrough.
      </p>
      <p class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-sand-400">
        ${
          state.endpoint
            ? `<span class="chip bg-good-bg text-good">Reading your own sheet</span>
               <span>Leads come from your Google Sheet to this page and go no further.</span>`
            : `<span class="chip bg-good-bg text-good">Nothing leaves your browser</span>
               <span>No account. No API keys. Your lead list stays on this device.</span>`
        }
      </p>
    </section>`;
}

/**
 * The half of the pitch the tool cannot show on its own.
 *
 * Sits above the tool rather than in the footer because a contractor being
 * shown this in a meeting sees the first screen and often nothing else, and
 * the argument being made is that the capture site and the follow-up are one
 * system. Burying that under eight draft cards loses it.
 */
function upsell(): string {
  return `
    <section class="mx-auto mt-5 max-w-5xl px-5 sm:mt-6">
      <p class="rounded-card border border-ink-700 bg-ink-900/60 px-4 py-3 text-sm leading-relaxed text-sand-200">
        Built to sit next to a remodel site like
        <a href="${RIDGEVIEW_URL}" target="_blank" rel="noopener noreferrer"
           class="font-semibold text-ember-400 underline underline-offset-2 hover:text-ember-500">Ridgeview</a>:
        the form captures the lead, this drafts the same-day reply. Want that loop for your company?
        <a href="${PORTFOLIO_URL}" target="_blank" rel="noopener noreferrer"
           class="font-semibold text-ember-400 underline underline-offset-2 hover:text-ember-500">Talk to Igor.</a>
      </p>
    </section>`;
}

function whiteLabelPanel(): string {
  const b = state.business;

  // Once drafts are on screen this collapses to a single line. The panel is
  // the least interesting thing on the page to a contractor watching a demo,
  // and an expanded three field form competing with their own leads is how
  // the first screen gets stolen.
  if (state.drafts.length > 0 && !state.whiteLabelOpen) {
    const summary = [b.companyName, b.ownerName, b.phone].filter(Boolean).join(" \u00b7 ");
    return `
      <section class="mx-auto mt-8 max-w-5xl px-5">
        <div class="card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <p class="min-w-0 text-sm text-sand-400">
            Editing as <span class="font-semibold text-sand-50">${escapeHtml(summary)}</span>
          </p>
          <button id="white-label-edit" type="button" class="btn btn-ghost">Edit</button>
        </div>
      </section>`;
  }

  return `
    <section class="mx-auto mt-8 max-w-5xl px-5">
      <div class="card p-5">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="text-sm font-semibold text-sand-50">Your name on every draft</h2>
          <span class="chip bg-warn-bg text-warn">Demo defaults</span>
        </div>
        <p class="mt-1.5 text-sm text-sand-400">
          Defaults are the Ridgeview demo. Type your company, sign-off, and callback number.
          Every draft updates as you type.
        </p>
        <div class="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <label class="label" for="f-company">Company</label>
            <input id="f-company" class="field" type="text" value="${escapeHtml(b.companyName)}"
                   data-business="companyName" autocomplete="organization" />
          </div>
          <div>
            <label class="label" for="f-owner">Signs off as</label>
            <input id="f-owner" class="field" type="text" value="${escapeHtml(b.ownerName)}"
                   data-business="ownerName" autocomplete="given-name" />
          </div>
          <div>
            <label class="label" for="f-phone">Callback number</label>
            <input id="f-phone" class="field" type="tel" value="${escapeHtml(b.phone)}"
                   data-business="phone" autocomplete="tel" />
          </div>
        </div>
      </div>
    </section>`;
}

function dropZone(): string {
  return `
    <section class="mx-auto mt-5 max-w-5xl px-5 sm:mt-6">
      <div id="drop" class="drop-zone">
        <svg viewBox="0 0 48 48" class="h-10 w-10 text-sand-400" fill="none" aria-hidden="true">
          <path d="M14 6h13l9 9v27a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"
                stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>
          <path d="M27 6v9h9" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>
          <path d="M24 34V22m0 0-4.5 4.5M24 22l4.5 4.5"
                stroke="#F59E0B" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>

        <button id="use-sample" class="btn btn-primary mt-5 w-full sm:w-auto" type="button">
          Use the sample leads
        </button>
        <p class="mt-2 text-sm text-sand-400">Try the sample in one tap. No file needed.</p>

        <div class="my-5 flex w-full max-w-xs items-center gap-3" aria-hidden="true">
          <span class="h-px flex-1 bg-ink-700"></span>
          <span class="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-sand-400">or</span>
          <span class="h-px flex-1 bg-ink-700"></span>
        </div>

        <label for="file" class="btn btn-ghost cursor-pointer">
          <svg viewBox="0 0 20 20" class="h-4 w-4" fill="none" aria-hidden="true">
            <path d="M10 14V4m0 0L6 8m4-4 4 4M3.5 14v1.5A1.5 1.5 0 0 0 5 17h10a1.5 1.5 0 0 0 1.5-1.5V14"
                  stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Choose a CSV
        </label>
        <input id="file" type="file" accept=".csv,text/csv" class="sr-only" />
        <p class="mt-2 text-sm text-sand-400">or drag one here</p>

        <p class="mt-4 max-w-md text-sm text-sand-400">
          Works with a CSV export from your form, sheet, or CRM. Name, phone, email, project,
          city, timeline, details. Spelling can be messy.
        </p>
      </div>
    </section>`;
}

/**
 * The connect-a-sheet panel.
 *
 * Collapsed until someone asks for it, because most people will drop a file
 * in and never need this. Once connected it collapses again to a single row
 * with Refresh on it, which is the only control that matters day to day.
 */
function sheetPanel(): string {
  if (state.endpoint) {
    return `
      <section class="mx-auto mt-4 max-w-5xl px-5">
        <div class="card flex flex-wrap items-center justify-between gap-3 p-4">
          <div class="min-w-0">
            <p class="text-sm font-semibold text-sand-50">Lead sheet connected</p>
            <p class="mt-0.5 font-mono text-xs text-sand-400">${escapeHtml(describeEndpoint(state.endpoint))}</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <button id="sheet-refresh" type="button" class="btn btn-quiet" ${state.sheetBusy ? "disabled" : ""}>
              ${state.sheetBusy ? "Loading" : "Refresh from sheet"}
            </button>
            <button id="sheet-disconnect" type="button" class="btn btn-ghost">Disconnect</button>
          </div>
        </div>
      </section>`;
  }

  if (!state.sheetOpen) {
    return `
      <section class="mx-auto mt-4 max-w-5xl px-5">
        <button id="sheet-open" type="button"
                class="text-sm text-sand-400 underline underline-offset-4 hover:text-ember-400">
          Or connect a lead sheet, so new form submissions show up here
        </button>
      </section>`;
  }

  return `
    <section class="mx-auto mt-4 max-w-5xl px-5">
      <div class="card p-5">
        <h2 class="text-sm font-semibold text-sand-50">Connect a lead sheet</h2>
        <p class="mt-1.5 text-sm text-sand-400">
          When your website form writes straight to a Google Sheet, this reads that sheet, so a lead
          that came in this morning is a draft by lunchtime without anyone exporting anything. The
          setup is a spreadsheet and a script in your own Google account, and it stays free.
          <a href="${SETUP_URL}" target="_blank" rel="noopener noreferrer"
             class="text-ember-400 underline underline-offset-2">The six steps are here.</a>
        </p>
        <div class="mt-4 flex flex-wrap gap-2">
          <label class="sr-only" for="sheet-url">Apps Script web app URL</label>
          <input id="sheet-url" class="field min-w-0 flex-1" type="url" spellcheck="false"
                 placeholder="https://script.google.com/macros/s/.../exec?key=..." />
          <button id="sheet-connect" type="button" class="btn btn-quiet" ${state.sheetBusy ? "disabled" : ""}>
            ${state.sheetBusy ? "Connecting" : "Connect"}
          </button>
        </div>
        <p class="mt-2.5 text-xs text-sand-400">
          The URL contains a read key, so it is kept in this browser only. It is never uploaded and
          never built into this site.
        </p>
      </div>
    </section>`;
}

function noticeBlock(): string {
  if (!state.notice) return "";
  const tone =
    state.notice.kind === "error"
      ? "border-bad/40 bg-bad-bg text-bad"
      : state.notice.kind === "warn"
        ? "border-warn/40 bg-warn-bg text-warn"
        : "border-ink-600 bg-ink-900 text-sand-200";
  return `
    <section class="mx-auto mt-5 max-w-5xl px-5">
      <p role="status" class="rounded-card border px-4 py-3 text-sm ${tone}">${escapeHtml(state.notice.text)}</p>
    </section>`;
}

/**
 * The results toolbar, pinned to the top once there are drafts.
 *
 * Sticky means it is on screen the whole time somebody scrolls eight leads,
 * so it has to stay short. Left to wrap freely it took four rows on a phone
 * and held about a fifth of the viewport hostage, so the file name is hidden
 * at small widths and the controls share one row.
 */
function toolbar(): string {
  if (state.drafts.length === 0) return "";
  const urgent = state.drafts.filter((d) => d.isUrgent).length;
  return `
    <section class="sticky top-0 z-20 mx-auto mt-6 max-w-5xl border-b border-ink-700 bg-ink-950/95 px-5 py-2.5 backdrop-blur sm:py-3">
      <div class="flex flex-wrap items-center justify-between gap-2 sm:gap-3">
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          <h2 class="text-sm font-semibold text-sand-50">
            ${state.drafts.length} draft${state.drafts.length === 1 ? "" : "s"}
          </h2>
          ${urgent > 0 ? `<span class="chip bg-bad-bg text-bad">${urgent} need a reply today</span>` : ""}
          ${
            state.fileName
              ? `<span class="hidden truncate font-mono text-xs text-sand-400 sm:inline">${escapeHtml(state.fileName)}</span>`
              : ""
          }
        </div>
        <div class="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-end">
          <div class="flex rounded-lg border border-ink-700 p-0.5" role="group" aria-label="Filter drafts">
            <button type="button" data-filter="all" aria-pressed="${!state.urgentOnly}"
              class="rounded-md px-3 py-1.5 text-sm ${!state.urgentOnly ? "bg-ink-700 text-sand-50" : "text-sand-400"}">All</button>
            <button type="button" data-filter="urgent" aria-pressed="${state.urgentOnly}"
              class="rounded-md px-3 py-1.5 text-sm ${state.urgentOnly ? "bg-ink-700 text-sand-50" : "text-sand-400"}">Reply today</button>
          </div>
          <button id="export" type="button" class="btn btn-ghost">Download CSV</button>
        </div>
      </div>
    </section>`;
}

/**
 * A copy button.
 *
 * `strong` is for the text message, which is the one pressed in the demo and
 * the one a contractor actually sends first. The others stay quiet so the
 * card does not turn into three competing buttons.
 *
 * Full height on purpose. These were a cramped 24px before, which is under
 * every touch target guideline and made the confirmation easy to miss.
 */
function copyButton(target: string, label: string, strong = false): string {
  const tone = strong ? "btn-primary" : "btn-quiet";
  return `<button type="button" class="btn btn-copy ${tone}"
            data-copy="${target}" aria-label="Copy ${escapeHtml(label)}">
            <span data-copy-label>Copy</span>
          </button>`;
}

function draftCard(draft: Draft, index: number): string {
  const l = draft.lead;
  const meta = [l.projectType, l.city, l.timeline].filter(Boolean).map(escapeHtml).join(" &middot; ");
  const contact = [l.phone, l.email].filter(Boolean).map(escapeHtml).join(" &middot; ");
  const submitted = formatSubmitted(l.submittedAt);

  return `
    <li class="card p-5 ${draft.isUrgent ? "border-l-4 border-l-ember-500" : ""}" data-index="${index}">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="font-semibold text-sand-50">${escapeHtml(l.name || "Unnamed lead")}</h3>
            ${draft.isUrgent ? `<span class="chip bg-bad-bg text-bad">Reply today</span>` : ""}
          </div>
          ${meta ? `<p class="mt-1 text-sm text-sand-400">${meta}</p>` : ""}
          ${contact ? `<p class="mt-0.5 font-mono text-xs text-sand-400">${contact}</p>` : ""}
        </div>
        ${submitted ? `<p class="shrink-0 font-mono text-xs text-sand-400">${escapeHtml(submitted)}</p>` : ""}
      </div>

      <div class="mt-5 rounded-lg border border-ink-700 bg-ink-950 p-4">
        <div class="flex items-center justify-between gap-3">
          <span class="label !mb-0">Text message</span>
          <div class="flex items-center gap-2">
            <span class="font-mono text-xs ${draft.smsOverLimit ? "text-warn" : "text-sand-400"}">
              ${draft.smsLength}/${SMS_CHARACTER_LIMIT}${draft.smsOverLimit ? " over" : ""}
            </span>
            ${copyButton(`sms-${index}`, "text message", true)}
          </div>
        </div>
        <p id="sms-${index}" class="mt-2.5 text-sm leading-relaxed text-sand-200">${escapeHtml(draft.sms)}</p>
        ${
          draft.smsOverLimit
            ? `<p class="mt-2 text-xs text-warn">Over ${SMS_CHARACTER_LIMIT} characters, so carriers may send it as two messages. Trim it or send as is.</p>`
            : ""
        }
      </div>

      <div class="mt-3 rounded-lg border border-ink-700 bg-ink-950 p-4">
        <div class="flex items-center justify-between gap-3">
          <span class="label !mb-0">Email subject</span>
          ${copyButton(`subject-${index}`, "email subject")}
        </div>
        <p id="subject-${index}" class="mt-2.5 text-sm text-sand-200">${escapeHtml(draft.subject)}</p>

        <div class="mt-4 flex items-center justify-between gap-3 border-t border-ink-700 pt-4">
          <span class="label !mb-0">Email body</span>
          ${copyButton(`body-${index}`, "email body")}
        </div>
        <pre id="body-${index}" class="mt-2.5 whitespace-pre-wrap font-sans text-sm leading-relaxed text-sand-200">${escapeHtml(draft.body)}</pre>
      </div>
    </li>`;
}

/**
 * A nudge towards the white-label fields, once there are drafts to rewrite.
 *
 * Disappears the moment the company name is no longer the demo one, because
 * at that point the person has already found the control and repeating the
 * tip would just be nagging.
 */
function loadTip(): string {
  if (state.drafts.length === 0) return "";
  if (state.business.companyName !== DEMO_BUSINESS.companyName) return "";
  return `
    <section class="mx-auto mt-3 max-w-5xl px-5">
      <p class="text-sm text-sand-400">
        Change Company above to put your name on these drafts.
      </p>
    </section>`;
}

function results(): string {
  if (state.drafts.length === 0) return "";
  const shown = state.urgentOnly ? state.drafts.filter((d) => d.isUrgent) : state.drafts;

  if (shown.length === 0) {
    return `
      <section class="mx-auto mt-5 max-w-5xl px-5">
        <p class="card p-8 text-center text-sand-400">
          No leads are marked as needing a reply today. Switch back to All to see the rest.
        </p>
      </section>`;
  }

  // Index against the full list so copy targets stay stable when filtering.
  return `
    <section id="results" class="mx-auto mt-5 max-w-5xl scroll-mt-24 px-5 pb-16">
      <ul class="grid gap-4">
        ${shown.map((d) => draftCard(d, state.drafts.indexOf(d))).join("")}
      </ul>
    </section>`;
}

function footer(): string {
  return `
    <footer class="border-t border-ink-700">
      <div class="mx-auto flex max-w-5xl flex-col gap-3 px-5 py-8 text-sm text-sand-400 sm:flex-row sm:items-center sm:justify-between">
        <p>Drafts only. Nothing sends until you hit Copy.</p>
        <div class="flex flex-wrap gap-4">
          <a href="${RIDGEVIEW_URL}" target="_blank" rel="noopener noreferrer" class="hover:text-ember-400">
            See the lead-capture site this pairs with
          </a>
          <a href="${PORTFOLIO_URL}" target="_blank" rel="noopener noreferrer" class="hover:text-ember-400">
            Built by Igor Lima \u00b7 Python automation for East County
          </a>
        </div>
      </div>
    </footer>`;
}

function render(): void {
  if (!app) return;
  // Order matters more than it looks. The white-label fields used to be the
  // first interactive block on the page, which meant the first thing a
  // contractor saw was a form asking about a company that is not theirs. The
  // sample button comes first now, and the fields sit next to the drafts they
  // rewrite.
  app.innerHTML = [
    header(),
    hero(),
    upsell(),
    dropZone(),
    sheetPanel(),
    noticeBlock(),
    state.drafts.length > 0 ? whiteLabelPanel() : "",
    toolbar(),
    loadTip(),
    results(),
    state.drafts.length === 0 ? whiteLabelPanel() : "",
    footer(),
  ].join("");
  bind();
}

/* --------------------------------------------------------------- behavior */

/**
 * Put the drafts on screen after a load.
 *
 * Without this, loading eight leads from a button near the top of the page
 * leaves the person looking at the same drop zone, with the thing they asked
 * for below the fold. Honours the reduced-motion setting rather than always
 * animating.
 */
function scrollToResults(): void {
  const target = document.getElementById("results");
  if (!target) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
}

/** Re-derive every draft from the current leads and business identity. */
function rebuild(leads: Parameters<typeof buildDrafts>[0]): void {
  state.drafts = buildDrafts(leads, state.business);
}

function loadCsvText(text: string, fileName: string): void {
  const result = parseLeads(text);

  if (result.leads.length === 0) {
    state.drafts = [];
    state.fileName = "";
    state.notice = {
      kind: "error",
      text: "No usable rows in that file. Each row needs at least a name, a phone number, or an email address.",
    };
    render();
    return;
  }

  rebuild(result.leads);
  state.fileName = fileName;

  // Say what was ignored rather than silently dropping it. A contractor whose
  // export uses an unusual header should find that out here, not by noticing
  // a draft is missing a detail three calls later.
  const notes: string[] = [];
  if (result.skippedRows > 0) {
    notes.push(`${result.skippedRows} row${result.skippedRows === 1 ? "" : "s"} skipped with no contact details`);
  }
  if (result.missingFields.length > 0) {
    notes.push(`no column matched: ${result.missingFields.join(", ")}`);
  }
  state.notice = notes.length > 0 ? { kind: "warn", text: `${result.leads.length} leads loaded. ${notes.join(". ")}.` } : null;
  render();
  scrollToResults();
}

function readFile(file: File): void {
  if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") {
    state.notice = { kind: "error", text: "That does not look like a CSV. Export your leads as CSV and try again." };
    render();
    return;
  }
  const reader = new FileReader();
  reader.onload = () => loadCsvText(String(reader.result ?? ""), file.name);
  reader.onerror = () => {
    state.notice = { kind: "error", text: "That file could not be read. Try exporting it again." };
    render();
  };
  reader.readAsText(file);
}

async function loadSample(): Promise<void> {
  try {
    const response = await fetch(SAMPLE_URL);
    if (!response.ok) throw new Error(String(response.status));
    loadCsvText(await response.text(), "sample_leads.csv");
  } catch {
    state.notice = { kind: "error", text: "The sample file could not be loaded. Try uploading your own CSV." };
    render();
  }
}

/**
 * Load the connected sheet and draft every lead on it.
 *
 * A failed refresh leaves whatever is already on screen alone. Someone who
 * is mid-call with a lead should not lose the draft they were reading
 * because the network dropped on a background refresh.
 */
async function loadFromSheet(): Promise<void> {
  if (!state.endpoint || state.sheetBusy) return;
  state.sheetBusy = true;
  render();

  try {
    const { leads, skippedRows } = await fetchLeads(state.endpoint);

    if (leads.length === 0) {
      state.notice = {
        kind: "info",
        text: "The sheet is connected, and there are no leads on it yet. Submit the form on your site and hit Refresh.",
      };
      return;
    }

    rebuild(leads);
    state.fileName = "from your lead sheet";
    const skipped =
      skippedRows > 0 ? ` ${skippedRows} row${skippedRows === 1 ? "" : "s"} had no contact details and were skipped.` : "";
    state.notice = {
      kind: "info",
      text: `${leads.length} lead${leads.length === 1 ? "" : "s"} loaded from your sheet.${skipped}`,
    };
  } catch (error) {
    state.notice = {
      kind: "error",
      text: error instanceof SheetError ? error.message : "The sheet could not be read. Check the setup steps and try again.",
    };
  } finally {
    state.sheetBusy = false;
    render();
    if (state.drafts.length > 0) scrollToResults();
  }
}

/** Validate and store a pasted endpoint, then pull the leads straight away. */
async function connectSheet(raw: string): Promise<void> {
  let endpoint: string;
  try {
    endpoint = normalizeEndpoint(raw);
  } catch (error) {
    state.notice = {
      kind: "error",
      text: error instanceof SheetError ? error.message : "That endpoint could not be used.",
    };
    render();
    return;
  }

  state.endpoint = endpoint;
  saveEndpoint(endpoint);
  state.sheetOpen = false;
  await loadFromSheet();
}

function bind(): void {
  if (!app) return;

  app.querySelectorAll<HTMLInputElement>("[data-business]").forEach((input) => {
    input.addEventListener("input", () => {
      const key = input.dataset.business as keyof Business | undefined;
      if (!key) return;
      state.business[key] = input.value;
      if (state.drafts.length > 0) {
        rebuild(state.drafts.map((d) => d.lead));
        // Re-render loses focus, so put it back where the person was typing.
        const active = input.id;
        const caret = input.selectionStart;
        render();
        const restored = document.getElementById(active) as HTMLInputElement | null;
        restored?.focus();
        if (restored && caret !== null) restored.setSelectionRange(caret, caret);
      }
    });
  });

  app.querySelector<HTMLInputElement>("#file")?.addEventListener("change", (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) readFile(file);
  });

  app.querySelector<HTMLButtonElement>("#use-sample")?.addEventListener("click", () => void loadSample());

  app.querySelector<HTMLButtonElement>("#white-label-edit")?.addEventListener("click", () => {
    state.whiteLabelOpen = true;
    render();
    document.getElementById("f-company")?.focus();
  });

  app.querySelector<HTMLButtonElement>("#sheet-open")?.addEventListener("click", () => {
    state.sheetOpen = true;
    render();
    document.getElementById("sheet-url")?.focus();
  });

  const endpointField = app.querySelector<HTMLInputElement>("#sheet-url");
  app.querySelector<HTMLButtonElement>("#sheet-connect")?.addEventListener("click", () => {
    void connectSheet(endpointField?.value ?? "");
  });
  endpointField?.addEventListener("keydown", (event) => {
    // Pasting a URL and pressing Enter is what everyone will try first.
    if (event.key === "Enter") {
      event.preventDefault();
      void connectSheet(endpointField.value);
    }
  });

  app.querySelector<HTMLButtonElement>("#sheet-refresh")?.addEventListener("click", () => void loadFromSheet());

  app.querySelector<HTMLButtonElement>("#sheet-disconnect")?.addEventListener("click", () => {
    clearEndpoint();
    state.endpoint = "";
    state.notice = {
      kind: "info",
      text: "Sheet disconnected. The drafts on screen stay until you load something else.",
    };
    render();
  });

  const drop = app.querySelector<HTMLDivElement>("#drop");
  if (drop) {
    ["dragenter", "dragover"].forEach((name) =>
      drop.addEventListener(name, (e) => {
        e.preventDefault();
        drop.classList.add("is-dragging");
      }),
    );
    ["dragleave", "drop"].forEach((name) =>
      drop.addEventListener(name, (e) => {
        e.preventDefault();
        drop.classList.remove("is-dragging");
      }),
    );
    drop.addEventListener("drop", (e) => {
      const file = (e as DragEvent).dataTransfer?.files?.[0];
      if (file) readFile(file);
    });
  }

  app.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.urgentOnly = button.dataset.filter === "urgent";
      render();
    });
  });

  app.querySelector<HTMLButtonElement>("#export")?.addEventListener("click", () => {
    downloadFile("lead-followup-drafts.csv", draftsToCsv(state.drafts), "text/csv;charset=utf-8");
  });

  app.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = document.getElementById(button.dataset.copy ?? "");
      if (!target) return;

      const ok = await copyText(target.textContent ?? "");

      // Swap the label rather than the whole button, so the tick can sit
      // beside the word and the button keeps its width instead of jumping.
      const slot = button.querySelector<HTMLElement>("[data-copy-label]");
      if (!slot) return;
      const original = slot.textContent;

      slot.textContent = ok ? "Copied" : "Press Ctrl C";
      button.classList.add(ok ? "copied" : "copy-failed");
      // A live region announcement, because a colour and a word change is
      // nothing at all to a screen reader.
      button.setAttribute("aria-live", "polite");

      window.setTimeout(() => {
        slot.textContent = original;
        button.classList.remove("copied", "copy-failed");
        button.removeAttribute("aria-live");
      }, COPY_FEEDBACK_MS);
    });
  });
}

render();

// A remembered endpoint means somebody already set this up, so load their
// leads rather than showing them an empty page and a Refresh button they
// have to think about.
if (state.endpoint) void loadFromSheet();
