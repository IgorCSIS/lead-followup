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
            <path d="M6 11h18M6 16h13M6 21h8" stroke="#F59E0B" stroke-width="2.5" stroke-linecap="round" fill="none"/>
            <circle cx="25" cy="21" r="2.5" fill="#F59E0B"/>
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
    <section class="mx-auto max-w-5xl px-5 pt-10 sm:pt-14">
      <h1 class="text-3xl font-bold leading-tight tracking-tight text-sand-50 sm:text-4xl">
        Same-day follow-ups from a lead CSV
      </h1>
      <p class="mt-4 max-w-2xl text-base leading-relaxed text-sand-200">
        Drop in the leads your website captured. Get a ready-to-send text and email for each one,
        with the people who need a reply today at the top. The contractor who answers first books
        the job.
      </p>
      <p class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-sand-400">
        ${
          state.endpoint
            ? `<span class="chip bg-good-bg text-good">Reading your own sheet</span>
               <span>Leads come from your Google Sheet to this page and go no further.</span>`
            : `<span class="chip bg-good-bg text-good">Nothing leaves your browser</span>
               <span>No account, no API keys, and your file is never uploaded.</span>`
        }
      </p>
    </section>`;
}

function whiteLabelPanel(): string {
  const b = state.business;
  return `
    <section class="mx-auto mt-8 max-w-5xl px-5">
      <div class="card p-5">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="text-sm font-semibold text-sand-50">Who the drafts are from</h2>
          <span class="chip bg-warn-bg text-warn">Sample values</span>
        </div>
        <p class="mt-1.5 text-sm text-sand-400">
          These default to the Ridgeview demo brand. Change them and every draft below updates.
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
    <section class="mx-auto mt-5 max-w-5xl px-5">
      <div id="drop" class="card border-dashed p-8 text-center transition-colors">
        <p class="text-sand-200">
          <label for="file" class="cursor-pointer font-semibold text-ember-400 underline underline-offset-4">
            Choose a CSV
          </label>
          or drag one here
        </p>
        <input id="file" type="file" accept=".csv,text/csv" class="sr-only" />
        <p class="mt-2 text-sm text-sand-400">
          Columns like name, phone, email, project type, city, timeline and details. Spelling is flexible.
        </p>
        <button id="use-sample" class="btn btn-quiet mt-5" type="button">Use the sample leads</button>
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

function toolbar(): string {
  if (state.drafts.length === 0) return "";
  const urgent = state.drafts.filter((d) => d.isUrgent).length;
  return `
    <section class="mx-auto mt-8 max-w-5xl px-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-sm font-semibold text-sand-50">
            ${state.drafts.length} draft${state.drafts.length === 1 ? "" : "s"}
          </h2>
          ${urgent > 0 ? `<span class="chip bg-bad-bg text-bad">${urgent} need a reply today</span>` : ""}
          ${state.fileName ? `<span class="font-mono text-xs text-sand-400">${escapeHtml(state.fileName)}</span>` : ""}
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <div class="flex rounded-lg border border-ink-700 p-0.5" role="group" aria-label="Filter drafts">
            <button type="button" data-filter="all" aria-pressed="${!state.urgentOnly}"
              class="rounded-md px-3 py-1.5 text-sm ${!state.urgentOnly ? "bg-ink-700 text-sand-50" : "text-sand-400"}">All</button>
            <button type="button" data-filter="urgent" aria-pressed="${state.urgentOnly}"
              class="rounded-md px-3 py-1.5 text-sm ${state.urgentOnly ? "bg-ink-700 text-sand-50" : "text-sand-400"}">Reply today</button>
          </div>
          <button id="export" type="button" class="btn btn-ghost">Download drafts CSV</button>
        </div>
      </div>
    </section>`;
}

function copyButton(target: string, label: string): string {
  return `<button type="button" class="btn btn-quiet !min-h-0 !px-2.5 !py-1 text-xs"
            data-copy="${target}" aria-label="Copy ${escapeHtml(label)}">Copy</button>`;
}

function draftCard(draft: Draft, index: number): string {
  const l = draft.lead;
  const meta = [l.projectType, l.city, l.timeline].filter(Boolean).map(escapeHtml).join(" &middot; ");
  const contact = [l.phone, l.email].filter(Boolean).map(escapeHtml).join(" &middot; ");
  const submitted = formatSubmitted(l.submittedAt);

  return `
    <li class="card p-5" data-index="${index}">
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
            ${copyButton(`sms-${index}`, "text message")}
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
    <section class="mx-auto mt-5 max-w-5xl px-5 pb-16">
      <ul class="grid gap-4">
        ${shown.map((d) => draftCard(d, state.drafts.indexOf(d))).join("")}
      </ul>
    </section>`;
}

function footer(): string {
  return `
    <footer class="border-t border-ink-700">
      <div class="mx-auto flex max-w-5xl flex-col gap-3 px-5 py-8 text-sm text-sand-400 sm:flex-row sm:items-center sm:justify-between">
        <p>Drafts only. This tool never sends anything to anyone.</p>
        <div class="flex flex-wrap gap-4">
          <a href="${RIDGEVIEW_URL}" target="_blank" rel="noopener noreferrer" class="hover:text-ember-400">
            The website that captures the leads
          </a>
          <a href="${PORTFOLIO_URL}" target="_blank" rel="noopener noreferrer" class="hover:text-ember-400">
            Igor Lima
          </a>
        </div>
      </div>
    </footer>`;
}

function render(): void {
  if (!app) return;
  app.innerHTML = [
    header(),
    hero(),
    whiteLabelPanel(),
    dropZone(),
    sheetPanel(),
    noticeBlock(),
    toolbar(),
    results(),
    footer(),
  ].join("");
  bind();
}

/* --------------------------------------------------------------- behavior */

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
        drop.classList.add("border-ember-400");
      }),
    );
    ["dragleave", "drop"].forEach((name) =>
      drop.addEventListener(name, (e) => {
        e.preventDefault();
        drop.classList.remove("border-ember-400");
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
      const original = button.textContent;
      button.textContent = ok ? "Copied" : "Press Ctrl C";
      button.classList.toggle("copied", ok);
      window.setTimeout(() => {
        button.textContent = original;
        button.classList.remove("copied");
      }, 1400);
    });
  });
}

render();

// A remembered endpoint means somebody already set this up, so load their
// leads rather than showing them an empty page and a Refresh button they
// have to think about.
if (state.endpoint) void loadFromSheet();
