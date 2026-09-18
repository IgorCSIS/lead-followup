/**
 * The lead sheet endpoint.
 *
 * One Google Apps Script web app that closes the loop between the Ridgeview
 * demo site and this drafting tool:
 *
 *   doPost  the quote form calls this when someone submits, and a row is
 *           appended to the sheet
 *   doGet   this tool calls this to read the sheet back as leads
 *
 * It is free with no quota worth worrying about at this volume, it needs no
 * server, and it lives in the sheet owner's own Google account, so the lead
 * data never passes through anything belonging to a third party.
 *
 * Read and write are deliberately asymmetric.
 *
 *   Writing is open. The form on a public website has to be able to post
 *   without a credential, because anything it carried would be visible in
 *   the page source anyway. Spam is held down by a honeypot, length caps,
 *   and a minimum bar for what counts as a lead, not by a secret.
 *
 *   Reading requires a key, held in Script Properties and never committed
 *   anywhere. Without it this endpoint will not hand back the lead list.
 *
 * That asymmetry is the whole security model, and it is worth being blunt
 * about its limits: the read key has to be pasted into a browser tool to be
 * used, so treat it as a lock on a filing cabinet rather than a vault. For a
 * demo full of fictional leads that is the right amount of security. For a
 * real client's real homeowners, see the note in tools/sheet-endpoint/README.md
 * about keeping the sheet private and exporting CSV by hand instead.
 *
 * Setup is in tools/sheet-endpoint/README.md. The only line you may need to
 * edit is SPREADSHEET_ID, and only if you create this as a standalone
 * script rather than from inside the sheet.
 */

/**
 * Which spreadsheet to write to.
 *
 * Leave this empty when the script lives inside the sheet itself, which is
 * what Extensions > Apps Script gives you: the script is bound to that sheet
 * and finds it on its own.
 *
 * Fill it in when the script is a standalone project created at
 * script.google.com. Paste the long id out of the sheet's own URL, the part
 * between /d/ and /edit:
 *
 *   https://docs.google.com/spreadsheets/d/THIS_PART_HERE/edit
 *
 * Both routes end up identical. The standalone one exists because the
 * Extensions menu is desktop only, so it is the way in from a phone or from
 * a Google account whose admin has hidden that menu.
 */
const SPREADSHEET_ID = '';

/** The tab the leads are written to. Created on first write if missing. */
const SHEET_NAME = 'Leads';

/**
 * The columns, in order. The first is filled in by this script; the rest
 * come from the form. Changing this list changes the sheet layout on the
 * next write, so add to the end rather than reordering.
 */
const COLUMNS = [
  'submitted_at',
  'name',
  'phone',
  'email',
  'project_type',
  'city',
  'timeline',
  'details',
  'source',
  'budget',
  'prefers_text',
];

/**
 * The most leads a single read will return.
 *
 * A cap exists so a sheet that has been collecting for two years cannot
 * produce a response large enough to stall a phone on a job site. Newest
 * rows win, because those are the ones anybody is drafting replies to.
 */
const MAX_ROWS_RETURNED = 500;

/** Longest accepted value for any one field, in characters. */
const MAX_FIELD_LENGTH = 2000;

/** Script Property that holds the read key. Set it during setup. */
const READ_KEY_PROPERTY = 'READ_KEY';

/**
 * Handle a form submission and append it to the sheet.
 *
 * The body is sent as text/plain JSON on purpose. It keeps the browser's
 * request simple, so there is no CORS preflight to fail, which matters
 * because this fires while the visitor is already navigating to the
 * thank-you page.
 *
 * Always answers 200. A form that shows an error because a spam check fired
 * teaches the spammer what to change, and a real homeowner should never see
 * a failure here: their submission has already been emailed by the form
 * backend, and this sheet row is the convenience copy.
 *
 * @param {Object} event The Apps Script POST event.
 * @return {TextOutput} A small JSON acknowledgement.
 */
function doPost(event) {
  try {
    const payload = JSON.parse((event && event.postData && event.postData.contents) || '{}');

    // A hidden field no person can see and no person will fill in. A bot
    // that fills every input gives itself away here.
    if (String(payload.botcheck || '').trim() !== '') {
      return _json({ ok: true, stored: false, reason: 'honeypot' });
    }

    // Something that identifies a human has to be present. A row with no
    // name, phone, or email cannot be replied to, so storing it only makes
    // the sheet worse.
    const hasContact =
      _clean(payload.name) !== '' || _clean(payload.phone) !== '' || _clean(payload.email) !== '';
    if (!hasContact) {
      return _json({ ok: true, stored: false, reason: 'no contact details' });
    }

    const sheet = _sheet();
    const row = COLUMNS.map(function (column) {
      if (column === 'submitted_at') return _timestamp();
      return _clean(payload[_camel(column)] !== undefined ? payload[_camel(column)] : payload[column]);
    });
    sheet.appendRow(row);

    return _json({ ok: true, stored: true });
  } catch (error) {
    // Logged for the sheet owner, never shown to the visitor.
    console.error('doPost failed: ' + error);
    return _json({ ok: true, stored: false, reason: 'error' });
  }
}

/**
 * Return the sheet as leads, for the drafting tool.
 *
 * @param {Object} event The Apps Script GET event. Requires a `key`
 *     parameter matching the READ_KEY script property.
 * @return {TextOutput} `{ ok, leads }`, or `{ ok: false, error }`.
 */
function doGet(event) {
  const expected = PropertiesService.getScriptProperties().getProperty(READ_KEY_PROPERTY);
  if (!expected) {
    return _json({ ok: false, error: 'This endpoint has no read key set. See the setup steps.' });
  }

  const supplied = (event && event.parameter && event.parameter.key) || '';
  if (supplied !== expected) {
    return _json({ ok: false, error: 'Wrong or missing read key.' });
  }

  const sheet = _sheet();
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    return _json({ ok: true, leads: [] });
  }

  const headers = values[0].map(function (header) {
    return String(header).trim();
  });
  const rows = values.slice(1).slice(-MAX_ROWS_RETURNED);

  const leads = rows
    .map(function (row) {
      const lead = {};
      headers.forEach(function (header, index) {
        lead[_camel(header)] = _clean(row[index]);
      });
      return lead;
    })
    .filter(function (lead) {
      return lead.name || lead.phone || lead.email;
    });

  return _json({ ok: true, leads: leads });
}

/**
 * Get the leads tab, creating it with a header row if it does not exist.
 *
 * @return {Sheet} The leads tab.
 */
function _sheet() {
  const book = _book();
  let sheet = book.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = book.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(COLUMNS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Get the spreadsheet, whichever way this script was set up.
 *
 * A bound script has an active spreadsheet and needs no id. A standalone one
 * has no active spreadsheet at all, and calling it from a web request would
 * return null rather than throw, so this is checked rather than assumed: a
 * silent null here would look exactly like a lead that vanished.
 *
 * @return {Spreadsheet} The lead spreadsheet.
 * @throws {Error} If neither route is configured.
 */
function _book() {
  if (SPREADSHEET_ID) {
    return SpreadsheetApp.openById(SPREADSHEET_ID);
  }
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) {
    throw new Error(
      'No spreadsheet. This script is not bound to a sheet, so set SPREADSHEET_ID to the id from your sheet URL.',
    );
  }
  return active;
}

/**
 * Trim a value, force it to a string, and hold it to the length cap.
 *
 * Dates arrive from the sheet as Date objects and have to survive the trip
 * back out as text, so they are formatted rather than stringified.
 *
 * @param {*} value Anything a cell or a JSON field might hold.
 * @return {string} A safe, bounded string.
 */
function _clean(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return _timestamp(value);
  return String(value).trim().slice(0, MAX_FIELD_LENGTH);
}

/**
 * Format a time the way the drafting tool expects to read it.
 *
 * @param {Date=} when Defaults to now.
 * @return {string} An ISO-like local timestamp, e.g. 2026-09-18T14:06:00.
 */
function _timestamp(when) {
  const date = when || new Date();
  return Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
}

/**
 * Convert a snake_case column name to the camelCase the tool uses.
 *
 * @param {string} name A column name.
 * @return {string} The camelCase form. `project_type` becomes `projectType`.
 */
function _camel(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[\s\-.]+/g, '_')
    .replace(/_([a-z])/g, function (_match, letter) {
      return letter.toUpperCase();
    });
}

/**
 * Wrap a value as a JSON response.
 *
 * @param {Object} value The response body.
 * @return {TextOutput} A JSON TextOutput.
 */
function _json(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

/**
 * Generate a read key and store it, printing it once to the log.
 *
 * Run this by hand from the Apps Script editor during setup. It is the only
 * place the key is ever shown, and it is never written to the sheet or to
 * any file in the repository.
 */
function setUpReadKey() {
  const key = Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty(READ_KEY_PROPERTY, key);
  console.log('Read key (copy this, it is not shown again): ' + key);
}
