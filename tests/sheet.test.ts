/**
 * Tests for the connected-sheet reader.
 *
 * The failure cases matter more than the happy path here. Everything that
 * can go wrong with an Apps Script deployment goes wrong in the Google
 * console, hours after the person set it up, so each error has to name the
 * setting to go and change rather than say that something failed.
 */

import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

/** A localStorage good enough for the module under test. */
class MemoryStorage {
  private readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

const g = globalThis as unknown as Record<string, unknown>;
g["window"] = {
  localStorage: new MemoryStorage(),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: number) => clearTimeout(id),
};

const {
  SheetError,
  clearEndpoint,
  describeEndpoint,
  fetchLeads,
  loadEndpoint,
  normalizeEndpoint,
  saveEndpoint,
} = await import("../src/lib/sheet.ts");

const GOOD = "https://script.google.com/macros/s/AKfycbxDEPLOYMENTID/exec?key=abc123";

/** Replace global fetch for one test. */
function mockFetch(handler: () => Promise<Response> | Response): void {
  g["fetch"] = async () => handler();
}

beforeEach(() => {
  clearEndpoint();
});

test("a usable Apps Script URL is accepted and normalized", () => {
  assert.equal(normalizeEndpoint(`  ${GOOD}  `), GOOD);
});

test("anything that is not an Apps Script endpoint is refused", () => {
  const cases: [string, RegExp][] = [
    ["", /Paste the web app URL/],
    ["not a url", /does not look like a URL/],
    ["http://script.google.com/macros/s/x/exec?key=1", /has to be https/],
    ["https://example.com/collect?key=1", /not an Apps Script URL/],
    ["https://script.google.com/macros/s/x/exec", /missing its read key/],
  ];
  for (const [input, expected] of cases) {
    assert.throws(() => normalizeEndpoint(input), (error: unknown) => {
      assert.ok(error instanceof SheetError, `${input} should raise a SheetError`);
      assert.match((error as Error).message, expected);
      return true;
    });
  }
});

test("the host allow-list is the point, not a formality", () => {
  // Without it the connect box would make the page fetch any address someone
  // could talk a user into pasting.
  assert.throws(
    () => normalizeEndpoint("https://script.google.com.attacker.example/macros/s/x/exec?key=1"),
    /not an Apps Script URL/,
  );
});

test("an endpoint survives a round trip through storage", () => {
  assert.equal(loadEndpoint(), "");
  saveEndpoint(GOOD);
  assert.equal(loadEndpoint(), GOOD);
  clearEndpoint();
  assert.equal(loadEndpoint(), "");
});

test("a stored endpoint that is no longer valid is ignored rather than thrown", () => {
  saveEndpoint("https://example.com/whatever");
  assert.equal(loadEndpoint(), "", "a bad stored value must not break the page on load");
});

test("the endpoint is described without leaking its key", () => {
  const shown = describeEndpoint(GOOD);
  assert.doesNotMatch(shown, /abc123/);
  assert.match(shown, /script\.google\.com/);
});

test("leads come back mapped, with blank fields filled in", async () => {
  mockFetch(() =>
    new Response(
      JSON.stringify({
        ok: true,
        leads: [
          {
            name: "  Dan Whitfield ",
            phone: "619-555-0198",
            email: "dan@example.com",
            projectType: "Bathroom remodel",
            city: "La Mesa",
            timeline: "As soon as possible",
            details: "Shower pan is leaking",
            source: "Referral",
            submittedAt: "2026-09-14T16:48:00",
          },
          { name: "Sparse Row" },
        ],
      }),
    ),
  );
  const { leads, skippedRows } = await fetchLeads(GOOD);
  assert.equal(leads.length, 2);
  assert.equal(skippedRows, 0);
  assert.equal(leads[0]?.name, "Dan Whitfield", "values are trimmed on the way in");
  assert.equal(leads[1]?.city, "", "a missing field becomes empty, never undefined");
});

test("rows with no way to reply are skipped and counted", async () => {
  mockFetch(() =>
    new Response(
      JSON.stringify({ ok: true, leads: [{ name: "Real Person" }, { city: "El Cajon" }, null] }),
    ),
  );
  const { leads, skippedRows } = await fetchLeads(GOOD);
  assert.equal(leads.length, 1);
  assert.equal(skippedRows, 2);
});

test("a wrong read key is reported in the endpoint's own words", async () => {
  mockFetch(() => new Response(JSON.stringify({ ok: false, error: "Wrong or missing read key." })));
  await assert.rejects(fetchLeads(GOOD), /Wrong or missing read key/);
});

test("a sign-in page instead of data names the deployment setting to fix", async () => {
  mockFetch(() => new Response("<!DOCTYPE html><html>Sign in to continue</html>"));
  await assert.rejects(fetchLeads(GOOD), /access set to Anyone/);
});

test("a blocked cross-origin read points at the same setting", async () => {
  mockFetch(() => {
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(fetchLeads(GOOD), /Who has access is set to Anyone/);
});

test("an HTTP error says to redeploy rather than showing a status code alone", async () => {
  mockFetch(() => new Response("nope", { status: 500 }));
  await assert.rejects(fetchLeads(GOOD), /answered with 500/);
});

test("a response missing the lead list is caught", async () => {
  mockFetch(() => new Response(JSON.stringify({ ok: true })));
  await assert.rejects(fetchLeads(GOOD), /did not return a lead list/);
});

test("a bad endpoint never reaches the network at all", async () => {
  let called = false;
  g["fetch"] = async () => {
    called = true;
    return new Response("{}");
  };
  await assert.rejects(fetchLeads("https://example.com/collect?key=1"));
  assert.equal(called, false, "validation has to happen before the request, not after");
});
