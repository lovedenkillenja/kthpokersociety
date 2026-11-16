# Board applications in a Google Sheet

Every application that Edge Function `apply` (applications project `hrdqlaurdzyueviplbmj`) accepts and saves
in `board_applications` can also be appended as a row to a private Google Sheet, so the board can read them
all in one place. Supabase stays the source of truth; the sheet is a copy.

How it works: after the database insert succeeds, `apply` POSTs the application as JSON to a Google Apps
Script web app bound to the sheet. The script checks a shared secret (`TOKEN`) and appends one row.
If the sheet step fails (Google down, wrong token, timeout after 8 s), the application is still saved and
the applicant still sees "thank you". The function then logs only a short code such as
`apply: sheet failed (rejected)`, never the application, the URL or the error text.

Code: `supabase/functions/apply/sheet.js` (URL allowlist, formula-injection sanitizing, the poster),
`supabase/functions/apply/handler.js` (calls it after the insert), tests in `game/tests/apply-sheet.test.js`.
The function only talks to `https://script.google.com` and `https://script.googleusercontent.com`
(Apps Script answers with a 302 redirect to the second host).

Status: **UNVERIFIED.** The Apps Script below and the real Google round trip have not been run yet.
Checked only with stubs in `node --test`.

## Before you start: privacy

- This copies personal data about applicants (name, email, phone, programme, LinkedIn, CV link, GitHub,
  motivation) to Google, a second processor besides Supabase. **Update the site's privacy notice first**
  (`index.html`, `#privacy-dialog`, section "Applications for roles"). It currently says only
  "Applications are stored with Supabase". Suggested text: "Applications are stored with Supabase and
  copied to a private Google Sheet that only the recruitment team can open. Both copies are deleted
  within two months after recruitment closes unless you're accepted."
- Share the sheet only with named board members who recruit. **Never** "Anyone with the link".
- When recruitment closes, delete the rows of applicants who were not accepted (in the sheet AND in
  Supabase), within the period the privacy notice promises. Also empty the sheet's version history if you
  need the data truly gone (File > Version history: older versions keep deleted rows).
- Never download the sheet into the repo, a chat or a prompt.

## Step by step (Love)

### 1. Create the sheet
1. Go to https://sheets.google.com with the society account and create a blank spreadsheet.
2. Name it, for example, "KTHPS board applications".
3. Click **Share**. Under "General access" keep **Restricted**. Add only the named board members who
   recruit, as Viewer (or Editor if they should mark rows). Click **Done**.

### 2. Add the script
1. In the sheet: **Extensions > Apps Script**. A new tab opens with a file `Code.gs`.
2. Delete everything in `Code.gs` and paste the script from "Apps Script source" below. Click the save icon.
3. Click the gear icon (**Project Settings**) on the left. Scroll to **Script Properties** and click
   **Add script property**.
   - Property: `TOKEN`
   - Value: a long random string you make up yourself, at least 32 characters (for example from a
     password manager's generator). **Do not paste it into any chat, doc, commit or email.** Keep it in
     your password manager.
   - Click **Save script properties**.

### 3. Deploy as a web app
1. Top right: **Deploy > New deployment**.
2. Click the gear next to "Select type" and choose **Web app**.
3. Description: `apply webhook`. **Execute as: Me**. **Who has access: Anyone**.
   ("Anyone" is needed because Supabase calls it without a Google login; the `TOKEN` check is what keeps
   others out. The sheet itself stays private.)
4. Click **Deploy**. Google asks you to authorize: choose the society account, "Advanced", "Go to ... (unsafe)"
   (it is your own script), **Allow**. It asks for access to your spreadsheets.
5. Copy the **Web app URL**. It ends in `/exec`. Treat it as private too (not a secret on its own, but do
   not publish it).

### 4. Give the URL and token to Supabase
In a terminal on your computer (logged in with `supabase login`), with your own values in place of the
placeholders:

```sh
supabase secrets set SHEET_WEBHOOK_URL='https://script.google.com/macros/s/<deployment-id>/exec' \
  SHEET_WEBHOOK_TOKEN='<the TOKEN value from step 2>' --project-ref hrdqlaurdzyueviplbmj
supabase functions deploy apply --project-ref hrdqlaurdzyueviplbmj --no-verify-jwt
```

Tip: to keep the token out of your shell history, type a space before the command (zsh with
`HIST_IGNORE_SPACE`) or set the secrets in the Supabase dashboard (Edge Functions > Secrets).

### 5. Test
Send one test application through the form on the site. Within a few seconds a sheet tab
**Applications** should appear with a header row and one row. If not, look at the `apply` logs in
Supabase for `apply: sheet failed (<code>)`:

| Code | Meaning |
|---|---|
| `rejected` | The script answered but refused: token mismatch, `TOKEN` not set, or a field failed validation |
| `bad_response` | Not JSON: usually the deployment is not "Anyone" or not authorized yet |
| `http_<n>` | Google returned an HTTP error |
| `bad_redirect`, `too_many_redirects` | The redirect went somewhere unexpected |
| `error` | Network error or the 8 s timeout |
| `sheet skipped (bad_url)` | `SHEET_WEBHOOK_URL` is not an https Apps Script URL |

Delete the test row afterwards (and the test application in Supabase).

### Changing the script later
Edit `Code.gs`, save, then **Deploy > Manage deployments**, pencil icon, Version: **New version**, Deploy.
This keeps the same `/exec` URL. ("New deployment" would make a new URL that Supabase does not know.)
To rotate the token: change the `TOKEN` script property, then run `supabase secrets set SHEET_WEBHOOK_TOKEN=...`
again and redeploy `apply`. To turn the copy off: `supabase secrets unset SHEET_WEBHOOK_URL SHEET_WEBHOOK_TOKEN
--project-ref hrdqlaurdzyueviplbmj` and redeploy.

## Apps Script source

Paste this into `Code.gs`. It does not log the request body anywhere.

```js
// Board applications webhook for KTH Poker Society. Called by Supabase Edge Function `apply`.
// Script property TOKEN must be set (long random string). Never logs the request body.

var SHEET_NAME = 'Applications';
var FIELDS = [
  // [json key, header, max length, required]
  ['submitted_at', 'Submitted at (UTC)', 40, true],
  ['full_name', 'Name', 200, true],
  ['email', 'Email', 330, true],
  ['phone', 'Phone', 60, false],
  ['program', 'Programme', 210, false],
  ['linkedin_url', 'LinkedIn', 510, true],
  ['cv_url', 'CV', 510, true],
  ['github_url', 'GitHub', 510, false],
  ['role', 'First choice', 100, true],
  ['role_ranking', 'Ranking', 600, false],
  ['hours_per_week', 'Hours per week', 60, false],
  ['motivation', 'Motivation', 4010, false]
];

function doPost(e) {
  try {
    var expected = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (!expected || expected.length < 32) return out_({ ok: false, error: 'not_configured' });

    var data;
    try {
      data = JSON.parse((e && e.postData && e.postData.contents) || '');
    } catch (err) {
      return out_({ ok: false, error: 'bad_request' });
    }
    if (!data || typeof data !== 'object' || typeof data.token !== 'string' || !data.token ||
        !safeEqual_(data.token, expected)) {
      return out_({ ok: false, error: 'unauthorized' });
    }

    var values = [];
    for (var i = 0; i < FIELDS.length; i++) {
      var key = FIELDS[i][0], max = FIELDS[i][2], required = FIELDS[i][3];
      var v = data[key];
      if (v === null || v === undefined) v = '';
      if (typeof v !== 'string' || v.length > max || (required && !v.trim())) {
        return out_({ ok: false, error: 'invalid' });
      }
      values.push(sanitize_(v));
    }

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return out_({ ok: false, error: 'busy' });
    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
      if (sheet.getLastRow() === 0) {
        // Plain-text format so phone numbers keep their leading zero and nothing is parsed as a formula.
        sheet.getRange(1, 1, sheet.getMaxRows(), FIELDS.length).setNumberFormat('@');
        sheet.appendRow(FIELDS.map(function (f) { return f[1]; }));
        sheet.setFrozenRows(1);
      }
      sheet.appendRow(values);
    } finally {
      lock.releaseLock();
    }
    return out_({ ok: true });
  } catch (err) {
    return out_({ ok: false, error: 'server_error' });
  }
}

// Formula injection: a value starting with = + - @ (or tab / CR) becomes text. Idempotent.
function sanitize_(s) {
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

// Compares SHA-256 digests byte by byte without stopping early.
function safeEqual_(a, b) {
  var da = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, a, Utilities.Charset.UTF_8);
  var db = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, b, Utilities.Charset.UTF_8);
  var diff = 0;
  for (var i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
  return diff === 0;
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
```

The Edge Function already prefixes risky values with `'` before sending; the script does it again in case
anything else ever calls it. A value that already starts with `'` is left as it is.

## UNVERIFIED
- The script has never run against Google: the header creation, `appendRow`, the lock and the JSON answer.
- Whether rows appended later keep the plain-text (`@`) format of the first rows, and how a leading `'`
  shows in a plain-text cell (it might show as a visible apostrophe instead of being hidden). If phone
  numbers lose their leading zero or apostrophes look wrong, adjust the formatting in the sheet.
- That Deno on Supabase returns the real 302 with a `Location` header for `redirect: "manual"` (the poster
  follows Apps Script's redirect by hand). If every call logs `http_0` or `bad_response`, check this.
