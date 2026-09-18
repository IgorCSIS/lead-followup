/**
 * The draft engine.
 *
 * This module is the single source of truth for what a follow-up says.
 * tools/lead_followup_drafter.py mirrors it line for line so the CLI and the
 * web app produce byte-identical drafts, and scripts/check-parity.mjs fails
 * the build if they ever drift. When changing a template, change it here
 * first, then port it, then run the parity check.
 *
 * Everything here is deterministic template selection. There is no API call,
 * no key, and no network, so the same lead always produces the same draft and
 * the tool costs nothing to run forever.
 */

/** A lead as parsed from a CSV row, after header aliasing. */
export interface Lead {
  name: string;
  phone: string;
  email: string;
  projectType: string;
  city: string;
  timeline: string;
  details: string;
  source: string;
  submittedAt: string;
}

/** Who the drafts are written as. Editable in the UI for white-labeling. */
export interface Business {
  companyName: string;
  ownerName: string;
  phone: string;
}

/** A finished pair of drafts for one lead. */
export interface Draft {
  lead: Lead;
  isUrgent: boolean;
  sms: string;
  smsLength: number;
  smsOverLimit: boolean;
  subject: string;
  body: string;
}

/**
 * Timeline answers that mean the homeowner wants to hear back today rather
 * than whenever someone gets to it. Compared lower-cased.
 */
export const URGENT_TIMELINES: ReadonlySet<string> = new Set([
  "asap",
  "as soon as possible",
  "emergency",
  "immediately",
  "urgent",
]);

/**
 * Opening line per project type. Naming the specific job in the first
 * sentence is what makes a reply read as written by a person.
 */
const PROJECT_OPENERS: Readonly<Record<string, string>> = {
  kitchen: "Thanks for the details on the kitchen.",
  "kitchen remodel": "Thanks for the details on the kitchen.",
  bathroom: "Thanks for the details on the bathroom.",
  "bathroom remodel": "Thanks for the details on the bathroom.",
  adu: "Thanks for reaching out about the ADU.",
  "adu or garage conversion": "Thanks for reaching out about the ADU.",
  "garage conversion": "Thanks for reaching out about the garage conversion.",
  "whole home": "Thanks for reaching out about the whole-home remodel.",
  "whole-home remodel": "Thanks for reaching out about the whole-home remodel.",
};

const GENERIC_OPENER = "Thanks for reaching out about your project.";

/**
 * Short project nouns for the text message.
 *
 * The SMS cannot afford the full opener sentence. A realistic worst case
 * (an eleven-letter first name, a whole-home remodel, a long timeline) ran
 * to 178 characters with the email opener in it, which carriers split into
 * two messages. Naming the job in three words instead of a sentence buys
 * back the room while still reading as written by a person.
 */
const PROJECT_LABELS: Readonly<Record<string, string>> = {
  kitchen: "kitchen",
  "kitchen remodel": "kitchen",
  bathroom: "bathroom",
  "bathroom remodel": "bathroom",
  adu: "ADU",
  "adu or garage conversion": "ADU",
  "garage conversion": "garage conversion",
  "whole home": "whole-home remodel",
  "whole-home remodel": "whole-home remodel",
};

const GENERIC_PROJECT_LABEL = "project";

/**
 * How soon to offer a visit, per timeline. These are deliberately
 * conservative: the promise has to be one the business can actually keep.
 * They are also kept short, because the same line goes into the text message
 * and every character there counts against the single-message limit.
 */
const VISIT_OFFERS: Readonly<Record<string, string>> = {
  asap: "I can come take a look tomorrow if that works.",
  "as soon as possible": "I can come take a look tomorrow if that works.",
  "1-3 months": "I can come take a look this week or next.",
  "1 to 3 months": "I can come take a look this week or next.",
  "3-6 months": "Happy to come walk the space whenever you are ready.",
  "3 to 6 months": "Happy to come walk the space whenever you are ready.",
  "6-12 months": "Happy to come out and get you a number to plan with.",
  "6 months or later": "Happy to come out and get you a number to plan with.",
  "just planning": "Happy to give you a ballpark whenever you want one.",
  "just researching": "Happy to give you a ballpark whenever you want one.",
  "still planning": "Happy to give you a ballpark whenever you want one.",
};

const GENERIC_VISIT_OFFER = "Happy to come take a look whenever suits you.";

/**
 * Carriers split anything longer than this into multiple messages, which
 * looks careless. Drafts over it are flagged in the UI rather than truncated,
 * because silently cutting a message is worse than showing a warning.
 */
export const SMS_CHARACTER_LIMIT = 160;

/** Default business identity, matching the Ridgeview demo brand. */
export const DEMO_BUSINESS: Business = {
  companyName: "Ridgeview Remodeling",
  ownerName: "Marcus",
  phone: "(619) 555-0180",
};

/**
 * Report whether a lead's timeline means it needs a reply today.
 */
export function isUrgent(lead: Lead): boolean {
  return URGENT_TIMELINES.has(lead.timeline.trim().toLowerCase());
}

/**
 * Get the homeowner's first name, for the greeting.
 *
 * Falls back to "there" when the name is missing, so a greeting never reads
 * "Hi ,".
 */
export function firstName(lead: Lead): string {
  const name = lead.name.trim() || "there";
  return name.split(/\s+/)[0] ?? "there";
}

/** Choose the opening sentence for a lead's project type. Used in the email. */
function openerFor(lead: Lead): string {
  return PROJECT_OPENERS[lead.projectType.trim().toLowerCase()] ?? GENERIC_OPENER;
}

/** Choose the short project noun for a lead. Used in the text message. */
function labelFor(lead: Lead): string {
  return PROJECT_LABELS[lead.projectType.trim().toLowerCase()] ?? GENERIC_PROJECT_LABEL;
}

/** Choose the visit offer that matches a lead's timeline. */
function visitOfferFor(lead: Lead): string {
  return VISIT_OFFERS[lead.timeline.trim().toLowerCase()] ?? GENERIC_VISIT_OFFER;
}

/**
 * Draft the short SMS reply.
 *
 * Kept under the single-message limit for every project and timeline in the
 * sample data, with room for a long first name. A white-label company name
 * longer than the demo one can still push it over, which is why the UI shows
 * the character count rather than assuming it always fits.
 */
export function draftSms(lead: Lead, business: Business): string {
  return (
    `Hi ${firstName(lead)}, it's ${business.ownerName} at ${business.companyName} ` +
    `about your ${labelFor(lead)}. ${visitOfferFor(lead)} What days work for you?`
  );
}

/** Draft the email subject line. */
export function draftSubject(lead: Lead, business: Business): string {
  const project = lead.projectType.trim() || "project";
  return `Your ${project.toLowerCase()} project, from ${business.companyName}`;
}

/**
 * Draft the longer email reply.
 *
 * Quoting the homeowner's own words back is what separates a reply that gets
 * answered from one that reads as a form letter, so the detail line is
 * included verbatim whenever they wrote anything.
 */
export function draftEmail(lead: Lead, business: Business): string {
  const detailLine = lead.details.trim() ? `You mentioned: "${lead.details.trim()}"\n\n` : "";
  const locationLine = lead.city.trim() ? ` out in ${lead.city.trim()}` : "";
  return (
    `Hi ${firstName(lead)},\n\n` +
    `${openerFor(lead)} ${visitOfferFor(lead)}\n\n` +
    detailLine +
    `The visit takes about thirty minutes. I measure, ask what you are trying ` +
    `to end up with, and flag anything that tends to surprise people on a job ` +
    `like this${locationLine}. You get a written quote after that, with the ` +
    `scope and the number in writing. No charge for any of it.\n\n` +
    `If it is easier to talk it through first, call or text ${business.phone}.\n\n` +
    `${business.ownerName}\n${business.companyName}`
  );
}

/** Build the full draft pair for one lead. */
export function buildDraft(lead: Lead, business: Business): Draft {
  const sms = draftSms(lead, business);
  return {
    lead,
    isUrgent: isUrgent(lead),
    sms,
    smsLength: sms.length,
    smsOverLimit: sms.length > SMS_CHARACTER_LIMIT,
    subject: draftSubject(lead, business),
    body: draftEmail(lead, business),
  };
}

/**
 * Build drafts for a list of leads, urgent ones first.
 *
 * Sorting here rather than in the view means the CLI and the web app agree on
 * ordering too, and the contractor sees the reply-today leads without
 * scrolling or filtering.
 */
export function buildDrafts(leads: readonly Lead[], business: Business): Draft[] {
  return leads
    .map((lead) => buildDraft(lead, business))
    .sort((a, b) => Number(b.isUrgent) - Number(a.isUrgent));
}
