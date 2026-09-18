/**
 * Reading leads from a connected Google Sheet.
 *
 * This is the only part of the tool that touches the network, and it is off
 * until someone connects an endpoint. Everything else still works with no
 * connection at all: drop a CSV in and nothing leaves the page.
 *
 * What it talks to is the Apps Script in tools/sheet-endpoint/, running in
 * the sheet owner's own Google account. There is no service in the middle,
 * no account here, and nothing is ever sent out: this reads, and that is all
 * it can do.
 *
 * The endpoint URL carries a read key, so it is a credential. It is kept in
 * this browser's local storage and never committed, never built into the
 * deployed site, and never sent anywhere except to Google.
 */

import type { Lead } from "./drafts";

/** Where the connected endpoint is remembered, per browser. */
const STORAGE_KEY = "lead-followup.endpoint";

/**
 * Hosts an endpoint is allowed to live on.
 *
 * Without this the connect box would be a field that makes the page issue a
 * request to any address someone can talk a user into pasting. Apps Script
 * is the only thing this is designed to speak to, so it is the only thing
 * it will call.
 */
const ALLOWED_HOSTS: readonly string[] = ["script.google.com", "script.googleusercontent.com"];

/** How long to wait before giving up on the sheet. */
const TIMEOUT_MS = 15_000;

/** What came back from a connected sheet. */
export interface SheetResult {
  leads: Lead[];
  /** Rows the endpoint returned that had no name, phone, or email. */
  skippedRows: number;
}

/** A failure worth showing the person, in words they can act on. */
export class SheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheetError";
  }
}

/**
 * Check that a pasted endpoint is a usable Apps Script web app URL.
 *
 * Returns the normalized URL rather than a boolean so the caller stores the
 * parsed form, not whatever was typed.
 */
export function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new SheetError("Paste the web app URL from your Apps Script deployment.");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new SheetError("That does not look like a URL. It should start with https://script.google.com/");
  }

  if (url.protocol !== "https:") {
    throw new SheetError("The endpoint has to be https.");
  }
  if (!ALLOWED_HOSTS.includes(url.hostname)) {
    throw new SheetError(
      "That is not an Apps Script URL. It should start with https://script.google.com/macros/",
    );
  }
  if (!url.searchParams.get("key")) {
    throw new SheetError(
      "The URL is missing its read key. Add ?key=... to the end, using the key from setUpReadKey.",
    );
  }
  return url.toString();
}

/** Remember an endpoint for next time. */
export function saveEndpoint(endpoint: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, endpoint);
  } catch {
    // Private browsing, or storage turned off. Connecting still works for
    // this session, it just will not be remembered, which is not worth
    // interrupting anyone over.
  }
}

/** Get the remembered endpoint, if there is one and it still looks valid. */
export function loadEndpoint(): string {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return "";
    return normalizeEndpoint(stored);
  } catch {
    return "";
  }
}

/** Forget the remembered endpoint. */
export function clearEndpoint(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do. If it cannot be removed it was never stored.
  }
}

/** Show an endpoint without its key, for display next to the Refresh button. */
export function describeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const id = url.pathname.split("/").filter(Boolean).slice(-2, -1)[0] ?? "";
    return id ? `script.google.com/.../${id.slice(0, 8)}...` : url.hostname;
  } catch {
    return "connected sheet";
  }
}

/** Turn one row of the endpoint's JSON into a lead, filling in what is absent. */
function toLead(row: Record<string, unknown>): Lead {
  const text = (key: string): string => {
    const value = row[key];
    return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  };
  return {
    name: text("name"),
    phone: text("phone"),
    email: text("email"),
    projectType: text("projectType"),
    city: text("city"),
    timeline: text("timeline"),
    details: text("details"),
    source: text("source"),
    submittedAt: text("submittedAt"),
  };
}

/**
 * Read the connected sheet.
 *
 * Every failure here is one somebody has to fix in the Google console, so
 * each one says which mistake it probably is rather than reporting that
 * something went wrong.
 */
export async function fetchLeads(endpoint: string): Promise<SheetResult> {
  const url = normalizeEndpoint(endpoint);

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, { method: "GET", signal: controller.signal, redirect: "follow" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new SheetError("The sheet did not answer in time. Check your connection and try again.");
    }
    // A blocked cross-origin read looks exactly like this, and by far the
    // most common cause is a deployment that is not open to anyone.
    throw new SheetError(
      "Could not reach the sheet. In the Apps Script deployment, check that Who has access is set to Anyone.",
    );
  } finally {
    window.clearTimeout(timer);
  }

  if (!response.ok) {
    throw new SheetError(`The sheet answered with ${response.status}. Redeploy the web app and try again.`);
  }

  const body = await response.text();

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    // Google serves a sign-in page as HTML when the deployment is private.
    throw new SheetError(
      "The endpoint returned a web page instead of data, which usually means the deployment asks for a Google sign-in. Redeploy it with access set to Anyone.",
    );
  }

  if (typeof payload !== "object" || payload === null) {
    throw new SheetError("The endpoint returned something unexpected. Check that it is the lead sheet script.");
  }

  const result = payload as { ok?: unknown; error?: unknown; leads?: unknown };
  if (result.ok === false) {
    throw new SheetError(typeof result.error === "string" ? result.error : "The sheet refused the request.");
  }
  if (!Array.isArray(result.leads)) {
    throw new SheetError("The endpoint did not return a lead list. Check that the script is deployed as a web app.");
  }

  const leads: Lead[] = [];
  let skippedRows = 0;
  for (const row of result.leads) {
    if (typeof row !== "object" || row === null) {
      skippedRows += 1;
      continue;
    }
    const lead = toLead(row as Record<string, unknown>);
    if (!lead.name && !lead.phone && !lead.email) {
      skippedRows += 1;
      continue;
    }
    leads.push(lead);
  }

  return { leads, skippedRows };
}
