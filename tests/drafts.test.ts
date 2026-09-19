/**
 * Tests for the draft engine.
 *
 * Run with `npm test`. Node strips the types and runs the TypeScript directly,
 * so there is no build step and no test framework to install.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEMO_BUSINESS,
  SMS_CHARACTER_LIMIT,
  buildDraft,
  buildDrafts,
  draftEmail,
  draftSms,
  draftSubject,
  firstName,
  isUrgent,
  type Lead,
} from "../src/lib/drafts.ts";

/** Build a lead with sensible defaults, overriding only what a test cares about. */
function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    name: "Marisol Reyna",
    phone: "619-555-0142",
    email: "marisol@example.com",
    projectType: "Kitchen remodel",
    city: "El Cajon",
    timeline: "1 to 3 months",
    details: "Galley kitchen, want the wall out.",
    source: "Google",
    submittedAt: "2026-09-14T09:12:00",
    ...overrides,
  };
}

test("urgency is decided by the timeline, not the wording of the details", () => {
  assert.equal(isUrgent(lead({ timeline: "As soon as possible" })), true);
  assert.equal(isUrgent(lead({ timeline: "  ASAP  " })), true);
  assert.equal(isUrgent(lead({ timeline: "1 to 3 months", details: "urgent!!" })), false);
  assert.equal(isUrgent(lead({ timeline: "" })), false);
});

test("a missing name never produces an empty greeting", () => {
  assert.equal(firstName(lead({ name: "" })), "there");
  assert.equal(firstName(lead({ name: "   " })), "there");
  assert.equal(firstName(lead({ name: "Dan Whitfield" })), "Dan");
});

test("the text names the project and offers a visit that matches the timeline", () => {
  const sms = draftSms(lead({ projectType: "Bathroom remodel", timeline: "ASAP" }), DEMO_BUSINESS);
  assert.match(sms, /Hi Marisol/);
  assert.match(sms, /Ridgeview Remodeling/);
  assert.match(sms, /about your bathroom\./);
  assert.match(sms, /tomorrow/);
});

test("an unknown project or timeline falls back instead of producing a blank sentence", () => {
  const sms = draftSms(lead({ projectType: "Deck rebuild", timeline: "sometime" }), DEMO_BUSINESS);
  assert.match(sms, /about your project\./);
  assert.match(sms, /whenever suits you\./);
  assert.doesNotMatch(sms, /undefined/);

  const email = draftEmail(lead({ projectType: "Deck rebuild", timeline: "sometime" }), DEMO_BUSINESS);
  assert.match(email, /Thanks for reaching out about your project\./);
  assert.doesNotMatch(email, /undefined/);
});

test("every project and timeline combination fits in a single message", () => {
  const projectTypes = [
    "Kitchen remodel",
    "Bathroom remodel",
    "ADU or garage conversion",
    "Garage conversion",
    "Whole-home remodel",
    "Deck rebuild",
    "",
  ];
  const timelines = [
    "As soon as possible",
    "1 to 3 months",
    "3 to 6 months",
    "6 months or later",
    "Still planning",
    "sometime next year",
    "",
  ];
  // Bartholomew is the longest plausible first name in the sample's range,
  // so passing here means the real leads have room to spare.
  for (const name of ["Dan Whitfield", "Bartholomew Castellanos"]) {
    for (const projectType of projectTypes) {
      for (const timeline of timelines) {
        const draft = buildDraft(lead({ name, projectType, timeline }), DEMO_BUSINESS);
        assert.ok(
          draft.smsLength <= SMS_CHARACTER_LIMIT,
          `${name} / ${projectType} / ${timeline} ran to ${draft.smsLength} characters`,
        );
        assert.equal(draft.smsOverLimit, false);
      }
    }
  }
});

test("an over-long message is flagged rather than truncated", () => {
  const draft = buildDraft(lead({ name: "Bartholomew".repeat(20) }), DEMO_BUSINESS);
  assert.equal(draft.smsOverLimit, true);
  assert.ok(draft.sms.endsWith("What days work for you?"), "the message is never cut short");
});

test("the email quotes the homeowner's own words when they wrote any", () => {
  const withDetails = draftEmail(lead({ details: "Shower pan is leaking." }), DEMO_BUSINESS);
  assert.match(withDetails, /You mentioned: "Shower pan is leaking\."/);

  const withoutDetails = draftEmail(lead({ details: "" }), DEMO_BUSINESS);
  assert.doesNotMatch(withoutDetails, /You mentioned/);
  assert.doesNotMatch(withoutDetails, /\n\n\n/, "no gap is left where the quote would be");
});

test("the email drops the location clause when the city is blank", () => {
  assert.match(draftEmail(lead({ city: "Santee" }), DEMO_BUSINESS), /job like this out in Santee\./);
  assert.match(draftEmail(lead({ city: "" }), DEMO_BUSINESS), /job like this\. You get/);
});

test("the email is signed by the business, with its callback number", () => {
  const body = draftEmail(lead(), DEMO_BUSINESS);
  assert.match(body, /call or text \(619\) 555-0180/);
  assert.ok(body.endsWith("Marcus\nRidgeview Remodeling"));
});

test("the subject names the project, and says project when there is none", () => {
  assert.equal(
    draftSubject(lead({ projectType: "Kitchen remodel" }), DEMO_BUSINESS),
    "Following up on your kitchen remodel \u00b7 Ridgeview Remodeling",
  );
  assert.equal(
    draftSubject(lead({ projectType: "" }), DEMO_BUSINESS),
    "Following up on your project \u00b7 Ridgeview Remodeling",
  );
});

test("the subject separator is a middle dot, never a dash", () => {
  // Mail clients and phones render em and en dashes inconsistently, and the
  // house style bans them in anything a homeowner reads.
  const subject = draftSubject(lead(), DEMO_BUSINESS);
  assert.match(subject, /\u00b7/);
  assert.doesNotMatch(subject, /[\u2013\u2014]/);
});

test("white-labeling replaces every mention of the demo business", () => {
  const custom = { companyName: "Cuyamaca Builders", ownerName: "Dana", phone: "(619) 555-0101" };
  const draft = buildDraft(lead(), custom);
  for (const text of [draft.sms, draft.subject, draft.body]) {
    assert.doesNotMatch(text, /Ridgeview|Marcus|555-0180/);
  }
  assert.match(draft.body, /Dana\nCuyamaca Builders$/);
});

test("urgent leads sort first and ties keep their file order", () => {
  const leads = [
    lead({ name: "Slow One", timeline: "6 months or later" }),
    lead({ name: "Fast One", timeline: "ASAP" }),
    lead({ name: "Slow Two", timeline: "Still planning" }),
    lead({ name: "Fast Two", timeline: "Emergency" }),
  ];
  const order = buildDrafts(leads, DEMO_BUSINESS).map((draft) => draft.lead.name);
  assert.deepEqual(order, ["Fast One", "Fast Two", "Slow One", "Slow Two"]);
});

test("the same lead always produces the same draft", () => {
  const first = buildDraft(lead(), DEMO_BUSINESS);
  const second = buildDraft(lead(), DEMO_BUSINESS);
  assert.deepEqual(first, second);
});
