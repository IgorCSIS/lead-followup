/**
 * Tests for CSV parsing and header aliasing.
 *
 * The cases here are the shapes a real export actually arrives in: headers
 * spelled differently, columns missing, blank rows at the bottom, and commas
 * inside a homeowner's description.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { draftsToCsv, parseLeads } from "../src/lib/csv.ts";
import { DEMO_BUSINESS, buildDrafts } from "../src/lib/drafts.ts";

const SAMPLE = new URL("../public/sample_leads.csv", import.meta.url);

test("the shipped sample parses cleanly", () => {
  const result = parseLeads(readFileSync(SAMPLE, "utf8"));
  assert.equal(result.leads.length, 8);
  assert.equal(result.skippedRows, 0);
  assert.deepEqual(result.missingFields, []);
  assert.deepEqual(result.unmappedHeaders, []);
  assert.equal(result.leads[0]?.name, "Marisol Reyna");
  assert.equal(result.leads[0]?.city, "El Cajon");
});

test("headers match regardless of case, spaces, underscores and hyphens", () => {
  const csv = [
    "Full Name,Phone Number,E-mail,What are you remodeling,City or ZIP,When would you like to start,Tell us about the project",
    "Dan Whitfield,619-555-0198,dan@example.com,Bathroom remodel,La Mesa,ASAP,Shower pan is leaking",
  ].join("\n");
  const { leads, missingFields } = parseLeads(csv);
  const lead = leads[0];
  assert.equal(lead?.name, "Dan Whitfield");
  assert.equal(lead?.phone, "619-555-0198");
  assert.equal(lead?.email, "dan@example.com");
  assert.equal(lead?.projectType, "Bathroom remodel");
  assert.equal(lead?.city, "La Mesa");
  assert.equal(lead?.timeline, "ASAP");
  assert.equal(lead?.details, "Shower pan is leaking");
  assert.deepEqual(missingFields, ["source", "submittedAt"]);
});

test("rows with no way to contact anyone are skipped, not drafted", () => {
  const csv = ["name,phone,email,project", "Real Person,619-555-0100,,Kitchen", ",,,Kitchen", ",,,"].join(
    "\n",
  );
  const { leads, skippedRows } = parseLeads(csv);
  assert.equal(leads.length, 1);
  assert.equal(skippedRows, 1, "the fully blank line is dropped before it is counted");
});

test("commas and quotes inside a description survive parsing", () => {
  const csv = [
    "name,phone,message",
    'Priya Raman,619-555-0171,"Detached ADU, flat lot, alley access. She said ""no stairs""."',
  ].join("\n");
  const lead = parseLeads(csv).leads[0];
  assert.equal(lead?.details, 'Detached ADU, flat lot, alley access. She said "no stairs".');
});

test("unrecognized columns are reported instead of silently dropped", () => {
  const csv = ["name,phone,internal_score,assigned_rep", "Tom Alvarez,619-555-0110,88,Jess"].join("\n");
  const { unmappedHeaders } = parseLeads(csv);
  assert.deepEqual(unmappedHeaders, ["internal_score", "assigned_rep"]);
});

test("surrounding whitespace never reaches the middle of a sentence", () => {
  const csv = ["name,project_type", "  Janine Cobb  ,  Kitchen remodel  "].join("\n");
  const lead = parseLeads(csv).leads[0];
  assert.equal(lead?.name, "Janine Cobb");
  assert.equal(lead?.projectType, "Kitchen remodel");
});

test("the export has one row per lead and escapes embedded quotes", () => {
  const { leads } = parseLeads(readFileSync(SAMPLE, "utf8"));
  const csv = draftsToCsv(buildDrafts(leads, DEMO_BUSINESS));
  const header = csv.split("\n")[0];
  assert.equal(header, "name,phone,email,project_type,city,timeline,urgent,sms,email_subject,email_body");
  assert.equal(csv.split("\n")[1]?.startsWith('"Dan Whitfield"'), true, "urgent leads stay first");

  const quoted = draftsToCsv([
    {
      lead: { ...leads[0]!, name: 'He said "yes"' },
      isUrgent: false,
      sms: "x",
      subject: "y",
      body: "z",
    },
  ]);
  assert.match(quoted, /"He said ""yes"""/);
});
