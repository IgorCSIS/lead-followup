# Lead Follow-up

Turn a CSV of leads into same-day text and email drafts, one per lead, urgent
ones first, with a copy button on each.

**Live tool:** https://igorcsis.github.io/lead-followup/
**Where the leads come from:** https://igorcsis.github.io/ridgeview-remodeling-demo/

It runs entirely in the browser. No account, no API key, no server, and the
CSV is never uploaded anywhere. Hosting is GitHub Pages, so it costs nothing
to run and there is no bill that can arrive later.

## The problem it solves

A remodeling lead that gets a reply within an hour is worth several times one
that gets a reply on Thursday. Contractors know this. They still miss it,
because the leads arrive while they are on a roof, and by the time they sit
down there are six of them and writing six replies from scratch is a job in
itself.

So this does the writing. Drop the export in, get a text and an email for
every lead, read them, fix anything that is off, send them yourself.

## What it deliberately does not do

- **It does not send anything.** No Twilio, no SMTP, no mail API. Every draft
  is copied to the clipboard by a person who has read it. A tool that texts
  homeowners on its own is one bad row away from an embarrassment, and the
  contractor is the one whose name is on it.
- **It does not call a language model.** The drafts come from templates chosen
  by project type and timeline. That means no API key, no per-draft cost, no
  rate limit, and the same lead always produces the same draft.
- **It does not upload the CSV.** The file is read by the browser and parsed
  in memory. There is no request to anything at runtime, which you can check
  yourself in the network tab: the page loads, and then it goes quiet. The web
  fonts were removed for the same reason.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173/lead-followup/
npm run build      # typecheck, then a static site in dist/
npm test           # TypeScript tests, Python tests, and the parity check
```

Node 22 or newer. The tests use Node's built-in runner and its TypeScript
support, so there is no test framework to install.

## The command line version

Same drafts, no browser:

```bash
python tools/lead_followup_drafter.py                      # the sample file
python tools/lead_followup_drafter.py --csv leads.csv      # your own
python tools/lead_followup_drafter.py --only-urgent        # today's triage
python tools/lead_followup_drafter.py --company "Your Co" --owner "You" --phone "..."
```

Python 3.10 or newer, standard library only. No network calls, same as the web
version.

## Why there are two engines, and how they stay honest

`src/lib/drafts.ts` is the single source of truth for what a follow-up says.
`tools/lead_followup_drafter.py` mirrors it.

Two copies of the same wording will drift, so `scripts/check-parity.mjs` runs
both engines over `public/sample_leads.csv` and compares every field of every
draft. A difference of one character fails the build, and CI runs it on every
push. Change a template in one place and the build tells you about the other.

```
$ npm run parity
Parity OK: 8 drafts identical in TypeScript and Python (2 urgent).
```

## Your own CSV

Column names are matched loosely. Case, spaces, underscores, hyphens and dots
are ignored, and each field accepts several spellings, so a Web3Forms export,
a hand-kept Google Sheet, and a CRM download all work without editing.

| Field | Headers it will match |
| --- | --- |
| name | name, full name, your name, contact, customer |
| phone | phone, phone number, mobile, cell, tel |
| email | email, email address, e-mail |
| project type | project type, project, service, job type, what are you remodeling |
| city | city, city or zip, town, location, zip, area |
| timeline | timeline, when, start date, timeframe, urgency |
| details | details, message, notes, description, comments |
| source | source, how did you hear about us, referral, channel |
| submitted | submitted at, date, timestamp, created, received at |

Anything it cannot match is reported on screen rather than silently dropped,
and a row with no name, phone, or email is skipped and counted.

A lead counts as urgent when its timeline says ASAP, as soon as possible,
emergency, immediately, or urgent. Urgent leads sort to the top.

## White-labeling it

The three fields at the top of the page (company, who it signs off as,
callback number) rewrite every draft as you type. They default to the
Ridgeview demo brand, which is a fictional company: the (619) 555-0180 number
is a reserved 555 number and belongs to nobody.

## The 30-second version, for showing someone

1. Open the Ridgeview site, fill in the quote form, submit it.
2. Open this tool, click **Use the sample leads**.
3. Point at the two red **Reply today** badges. "Those two came in overnight.
   They are the ones that turn into jobs if you get to them first."
4. Click **Copy** on a text message and paste it into a phone.
5. Change the company name at the top and watch all eight drafts rewrite.

The point is not the software. The point is that the lead form and the
follow-up are one system, and the second half is the half most contractors
never build.

## Deploying your own copy

1. Fork or clone, then push to a repository named `lead-followup`. If you name
   it something else, change `base` in `vite.config.ts` to match, or every
   asset will 404 in production.
2. In the repository, go to **Settings → Pages** and set **Source** to
   **GitHub Actions**.
3. Push to `main`. The workflow in `.github/workflows/deploy.yml` runs the
   tests and the parity check, builds, and deploys. If the tests fail, nothing
   ships.

There are no secrets to configure, because there is nothing to authenticate
against.

## Layout

```
index.html                       the shell, plus a real message when JS is off
src/main.ts                      the single-screen UI
src/lib/drafts.ts                the draft engine, and the source of truth
src/lib/csv.ts                   parsing, header aliasing, and CSV export
src/lib/ui.ts                    clipboard, downloads, escaping, dates
tools/lead_followup_drafter.py   the CLI, mirroring the engine
tools/test_lead_followup_drafter.py
tests/                           TypeScript tests
scripts/check-parity.mjs         proves the two engines agree
public/sample_leads.csv          eight fictional leads, two of them urgent
```

Python here follows the Appendix A conventions: snake_case, `Final` on
constants, a leading underscore on anything private, a docstring on every
module, class, and function, and encapsulation through properties rather than
public attributes.

## The data in the sample

Eight fictional leads for a fictional company in East County San Diego. The
names, the phone numbers, the email addresses and the projects are invented.
The 555 numbers are reserved for exactly this.

## License

MIT. See [LICENSE](LICENSE).

Built by Igor Lima. https://igorcsis.github.io/niftyai-portfolio/
