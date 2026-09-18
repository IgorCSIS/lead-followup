# The lead sheet endpoint

This closes the loop. A homeowner submits the form on your website, a row
appears in your spreadsheet, and this tool drafts the replies from that
spreadsheet. Nobody exports anything, and it stays free.

```
your website form ─┬─ email to you            (Web3Forms, unchanged)
                   └─ a row in your sheet     (this script)
                                ↓
                        Google Sheet
                                ↓
                   Lead Follow-up drafts the replies
```

`Code.gs` is a Google Apps Script that does both halves: it accepts the form
post and appends a row, and it hands the sheet back to the drafting tool when
asked with the right key.

It runs in **your** Google account. The lead data goes from your website to
your spreadsheet, and there is no third-party service in between holding it.

## Setup, about ten minutes

**1. Make the spreadsheet.**
New Google Sheet, name it something like `Ridgeview leads`. Leave it empty.
The script writes the header row the first time a lead arrives.

**2. Open the script editor.**
In the sheet: **Extensions → Apps Script**. Delete whatever is in `Code.gs`
and paste in the contents of the `Code.gs` next to this file. Save.

**3. Make a read key.**
In the editor's function dropdown pick **setUpReadKey**, then **Run**. Google
will ask you to authorize the script the first time, and it will warn you
that the app is not verified. That warning is about scripts in general, not
about this one; you are the author and it only touches this spreadsheet.
Choose **Advanced → Go to (your project)** and allow it.

Open **Execution log** and copy the key it printed. It is shown once. If you
lose it, run `setUpReadKey` again and the old key stops working.

**4. Deploy it as a web app.**
**Deploy → New deployment → Web app**.

| Setting | Value |
| --- | --- |
| Execute as | Me |
| Who has access | **Anyone** |

Both matter. *Execute as me* is what lets it write to your sheet. *Anyone* is
what lets your website reach it: with any other setting Google answers with a
sign-in page and no lead is ever recorded.

Copy the **Web app URL**. It ends in `/exec`.

**5. Point your website at it.**
In the website repo (`ridgeview-remodeling-demo`), add a repository secret
under **Settings → Secrets and variables → Actions**:

```
PUBLIC_SHEET_ENDPOINT = https://script.google.com/macros/s/..../exec
```

Re-run the deploy workflow. Submit the form on your own site. A row should
appear in the sheet within a second or two.

**6. Connect the drafting tool.**
Open the Lead Follow-up tool, click **Or connect a lead sheet**, and paste the
web app URL with your read key on the end:

```
https://script.google.com/macros/s/..../exec?key=YOUR_READ_KEY
```

That URL is stored in your browser only. It is never uploaded and never built
into the site, so it stays out of the repository and off the public page.

## Changes to make after a code change

Apps Script serves the **deployed** version, not the saved one. After editing
`Code.gs`, go to **Deploy → Manage deployments**, hit the pencil, set Version
to **New version**, and Deploy. Skipping this is why an edit appears to have
no effect.

## Who can read and write

Worth being straight about, because it decides whether this is appropriate
for real customers.

**Writing is open.** Your website form posts with no credential, because
anything it carried would be visible in the page source. Spam is held down by
a honeypot field, length caps, and a requirement that a row have a name, a
phone, or an email. Somebody who found your endpoint URL could append junk
rows. They could not read anything, and they could not delete anything.

**Reading needs the key**, which never goes into any repository or any built
page. But it does have to be pasted into a browser tool to be used, so treat
it as a lock on a filing cabinet, not a vault.

**For a demo with invented leads, that is the right amount of security.**

**For a real client with real homeowners on the sheet**, do not connect the
read half. Set `PUBLIC_SHEET_ENDPOINT` so the sheet fills up automatically,
keep the spreadsheet private, and when you want drafts use **File → Download →
CSV** and drop the file into the tool. You get the same drafts, the sheet is
readable only by the Google accounts you shared it with, and there is no key
in anyone's browser.

## If something does not work

**Nothing appears in the sheet after a submission.**
Check that `PUBLIC_SHEET_ENDPOINT` is set as a secret and that the deploy
workflow has run since you added it. The endpoint URL is baked in at build
time, so adding the secret is not enough on its own. Then check **Executions**
in the Apps Script editor: a submission that arrived shows up there, with the
error if it failed.

**The tool says the endpoint returned a web page.**
The deployment's *Who has access* is not **Anyone**. Edit the deployment,
change it, deploy a new version.

**The tool says the read key is wrong.**
The `?key=` on the end does not match what `setUpReadKey` stored. Run
`setUpReadKey` again and reconnect with the new key.

**Leads stop appearing after you changed the columns.**
`COLUMNS` in `Code.gs` defines the sheet layout on write, and the header row
in the sheet defines it on read. If you rename a column in the sheet, rename
it in `COLUMNS` too. Add new columns at the end rather than reordering.

**The form works but the email stopped.**
Nothing here touches the email path. That is Web3Forms, and
`PUBLIC_WEB3FORMS_ACCESS_KEY` in the website repo.

## No JavaScript, no row

The sheet copy is written by a script in the visitor's browser. With
JavaScript disabled the form still posts natively and you still get the
email, but there is no row. That trade is deliberate: the email is the
reliable path and must never depend on anything here.
