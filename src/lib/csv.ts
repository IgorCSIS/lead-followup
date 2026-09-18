/**
 * CSV parsing and header mapping.
 *
 * Real exports never have the headers you expect. A Web3Forms export, a
 * Google Sheet a contractor maintains by hand, and a CRM download all call
 * the same column something different, so every field accepts a list of
 * aliases and matching ignores case, spaces, underscores and hyphens.
 *
 * Nothing here touches the network. The file is read by the browser, parsed
 * in memory, and never uploaded anywhere.
 */

import Papa from "papaparse";
import type { Lead } from "./drafts";

/**
 * Accepted header spellings per field, normalized.
 *
 * Order matters: the first alias found in the row wins, so the canonical
 * name is listed first.
 */
const FIELD_ALIASES: Readonly<Record<keyof Lead, readonly string[]>> = {
  name: ["name", "fullname", "yourname", "contact", "contactname", "customer", "leadname"],
  phone: ["phone", "phonenumber", "mobile", "cell", "tel", "telephone", "bestnumbertoreachyou"],
  email: ["email", "emailaddress", "e mail"],
  projectType: ["projecttype", "project", "service", "jobtype", "whatareyouremodeling", "whatdoyouneed"],
  city: ["city", "cityorzip", "town", "location", "zip", "zipcode", "postalcode", "area"],
  timeline: ["timeline", "when", "startdate", "timeframe", "whenwouldyouliketostart", "urgency"],
  details: ["details", "projectdetails", "message", "notes", "description", "tellusabouttheproject", "comments"],
  source: ["source", "howtheyheard", "howdidyouhearaboutus", "referral", "channel", "leadsource"],
  submittedAt: ["submittedat", "submitted", "date", "timestamp", "created", "createdat", "receivedat"],
};

/** Strip everything that varies between exports of the same column. */
function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[\s_\-.]/g, "");
}

/** The outcome of parsing a file, including what could not be matched. */
export interface ParseResult {
  leads: Lead[];
  /** Canonical field names no column could be matched to. */
  missingFields: (keyof Lead)[];
  /** Headers present in the file that were not recognized. */
  unmappedHeaders: string[];
  /** Rows skipped because they had no name, phone, or email. */
  skippedRows: number;
}

/** Build a normalized-header to canonical-field lookup for one file. */
function mapHeaders(headers: readonly string[]): {
  map: Map<string, keyof Lead>;
  missing: (keyof Lead)[];
  unmapped: string[];
} {
  const normalized = new Map<string, string>();
  for (const header of headers) {
    normalized.set(normalizeHeader(header), header);
  }

  const map = new Map<string, keyof Lead>();
  const missing: (keyof Lead)[] = [];
  const claimed = new Set<string>();

  for (const [field, aliases] of Object.entries(FIELD_ALIASES) as [keyof Lead, readonly string[]][]) {
    const hit = aliases.find((alias) => normalized.has(alias));
    if (hit) {
      const original = normalized.get(hit);
      if (original !== undefined) {
        map.set(original, field);
        claimed.add(original);
      }
    } else {
      missing.push(field);
    }
  }

  const unmapped = headers.filter((h) => !claimed.has(h) && h.trim() !== "");
  return { map, missing, unmapped };
}

/**
 * Parse CSV text into leads.
 *
 * A row is kept when it has at least one way to contact the person. A row
 * with no name, phone, or email is a blank line or a footer, and drafting a
 * reply to it would waste the contractor's time.
 */
export function parseLeads(csvText: string): ParseResult {
  const parsed = Papa.parse<Record<string, string>>(csvText.trim(), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });

  const headers = parsed.meta.fields ?? [];
  const { map, missing, unmapped } = mapHeaders(headers);

  const leads: Lead[] = [];
  let skippedRows = 0;

  for (const row of parsed.data) {
    const lead: Lead = {
      name: "",
      phone: "",
      email: "",
      projectType: "",
      city: "",
      timeline: "",
      details: "",
      source: "",
      submittedAt: "",
    };

    for (const [header, field] of map) {
      lead[field] = (row[header] ?? "").trim();
    }

    if (!lead.name && !lead.phone && !lead.email) {
      skippedRows += 1;
      continue;
    }
    leads.push(lead);
  }

  return { leads, missingFields: missing, unmappedHeaders: unmapped, skippedRows };
}

/** Quote a value for CSV output, escaping embedded quotes. */
function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Serialize drafts to CSV for download.
 *
 * Kept deliberately flat, one row per lead with the drafts inline, so it can
 * be pasted straight into a spreadsheet or a CRM import.
 */
export function draftsToCsv(
  rows: readonly {
    lead: Lead;
    isUrgent: boolean;
    sms: string;
    subject: string;
    body: string;
  }[],
): string {
  const header = [
    "name",
    "phone",
    "email",
    "project_type",
    "city",
    "timeline",
    "urgent",
    "sms",
    "email_subject",
    "email_body",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        csvCell(row.lead.name),
        csvCell(row.lead.phone),
        csvCell(row.lead.email),
        csvCell(row.lead.projectType),
        csvCell(row.lead.city),
        csvCell(row.lead.timeline),
        csvCell(row.isUrgent ? "yes" : "no"),
        csvCell(row.sms),
        csvCell(row.subject),
        csvCell(row.body),
      ].join(","),
    );
  }
  return lines.join("\n");
}
