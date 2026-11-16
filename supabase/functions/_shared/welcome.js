// Request handler for the `welcome` Edge Function.
// Pure ES module with injected `store` and `sendMail`, so it runs in Deno and in `node --test`.
//
// Flow: verify the caller's JWT -> atomically claim members.welcome_sent_at (only if NULL)
// -> send the welcome mail to the address on the caller's own auth account -> send a minimal
// notice (display name + timestamp only) to the society inbox.
// If the welcome mail fails, the claim is released so a later sign-in can retry.
// If only the society notice fails, the claim is kept: releasing it would send the member
// a second welcome mail on retry.

import { authenticateCaller, errorResult } from "./state-helpers.js";

export const SOCIETY_NOTICE_ADDRESS = "kthpokersociety@gmail.com";
export const SITE_URL = "https://kthpokersociety.se";

/** Removes control characters and caps length; the name is client-controlled data. */
export function sanitizeName(value, max = 40) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[ch]);
}

/**
 * Same rule as game/lib/format.js deriveDefaultDisplayName (first name + last initial),
 * but never falls back to the email handle, so no part of the address reaches the notice.
 */
export function deriveDisplayName(fullName) {
  const clean = sanitizeName(fullName, 200);
  if (!clean) return "KTH Member";
  const parts = clean.split(" ");
  if (parts.length >= 2) {
    return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`.slice(0, 40).trim();
  }
  return clean.slice(0, 40);
}

export function buildWelcomeMail({ firstName }) {
  const name = sanitizeName(firstName, 40);
  const hejSv = name ? `Hej ${name}!` : "Hej!";
  const hiEn = name ? `Hi ${name}!` : "Hi!";
  const subject = "Välkommen till KTH Poker Society / Welcome to KTH Poker Society";
  const text = [
    hejSv,
    "",
    "Välkommen till KTH Poker Society. Ditt konto är klart.",
    "I spelet använder du bara spelpengar (marker) utan något värde. Det går inte att köpa, sälja eller ta ut marker.",
    `Läs mer och logga in: ${SITE_URL}`,
    "",
    "---",
    "",
    hiEn,
    "",
    "Welcome to KTH Poker Society. Your account is ready.",
    "The game uses play money only: chips have no cash value and cannot be bought, sold or cashed out.",
    `Read more and sign in: ${SITE_URL}`,
    "",
    "KTH Poker Society"
  ].join("\n");
  const html = [
    `<p>${escapeHtml(hejSv)}</p>`,
    "<p>Välkommen till KTH Poker Society. Ditt konto är klart.</p>",
    "<p>I spelet använder du bara spelpengar (marker) utan något värde. Det går inte att köpa, sälja eller ta ut marker.</p>",
    `<p>Läs mer och logga in: <a href="${SITE_URL}">kthpokersociety.se</a></p>`,
    "<hr>",
    `<p>${escapeHtml(hiEn)}</p>`,
    "<p>Welcome to KTH Poker Society. Your account is ready.</p>",
    "<p>The game uses play money only: chips have no cash value and cannot be bought, sold or cashed out.</p>",
    `<p>Read more and sign in: <a href="${SITE_URL}">kthpokersociety.se</a></p>`,
    "<p>KTH Poker Society</p>"
  ].join("\n");
  return { subject, text, html };
}

export function buildSocietyNotice({ displayName, at }) {
  const name = sanitizeName(displayName, 40) || "KTH Member";
  const text = `New member signed in for the first time.\nDisplay name: ${name}\nTime (UTC): ${at}`;
  return {
    subject: "New member",
    text,
    html: `<p>New member signed in for the first time.</p><p>Display name: ${escapeHtml(name)}<br>Time (UTC): ${escapeHtml(at)}</p>`
  };
}

function isEmailConfirmed(user) {
  // Supabase users carry email_confirmed_at (or the older confirmed_at) once confirmed.
  return Boolean(user?.email_confirmed_at || user?.confirmed_at);
}

/**
 * Handles one `welcome` call. Returns `{ status, body }` with body `{ ok: true, sent }`
 * or an error result. `logError(code)` receives short codes only (no addresses, no names).
 */
export async function handleWelcomeRequest({
  store,
  sendMail,
  jwt,
  payload = {},
  now = () => Date.now(),
  logError = () => {},
  memberMail = true,
  syncSheet = null
}) {
  const auth = await authenticateCaller(store, jwt, payload);
  if (auth.error) return auth.error;
  const user = auth.user;

  // Member register in the Google Sheet: independent of the welcome mail and its claim. Never fails the call.
  if (typeof syncSheet === "function") {
    try { await syncSheet(); } catch (_err) { logError("ERR_MEMBER_SHEET"); }
  }

  // Only ever mail the address on the caller's own, confirmed auth account.
  const to = typeof user.email === "string" ? user.email.trim() : "";
  if (!to || !isEmailConfirmed(user)) {
    return { status: 200, body: { ok: true, sent: false } };
  }

  const claimedAt = new Date(Number(now())).toISOString();
  let claimed;
  try {
    claimed = await store.claimWelcome({ memberId: user.id, claimedAt });
  } catch (_err) {
    logError("ERR_WELCOME_CLAIM");
    return errorResult(500, "ERR_INTERNAL", "Unexpected server error.");
  }
  if (!claimed) {
    // Already sent (or being sent by a concurrent call), or no members row.
    return { status: 200, body: { ok: true, sent: false } };
  }

  const fullName = sanitizeName(claimed.full_name, 200);
  const firstName = fullName.split(" ")[0] || "";

  const releaseClaim = async () => {
    try {
      const released = await store.releaseWelcome({ memberId: user.id, claimedAt });
      if (released === false) logError("ERR_WELCOME_RELEASE_NOOP");
    } catch (_releaseErr) {
      logError("ERR_WELCOME_RELEASE");
    }
  };

  // memberMail=false: only the society notice is sent (no mail to the member).
  if (memberMail) {
    try {
      await sendMail({ to, ...buildWelcomeMail({ firstName }) });
    } catch (err) {
      logError(String(err?.code || "ERR_MAIL_SEND"));
      await releaseClaim();
      // Contract is {ok:true, sent:boolean}; the claim is released so the next sign-in retries.
      return { status: 200, body: { ok: true, sent: false } };
    }
  }

  try {
    let displayName = null;
    try {
      displayName = await store.getDisplayName(user.id);
    } catch (_err) {
      displayName = null;
    }
    await sendMail({
      to: SOCIETY_NOTICE_ADDRESS,
      ...buildSocietyNotice({ displayName: displayName || deriveDisplayName(fullName), at: claimedAt })
    });
  } catch (err) {
    logError(`NOTICE_${String(err?.code || "ERR_MAIL_SEND")}`);
    if (!memberMail) {
      // The notice is the only mail: release the claim so the next sign-in retries.
      await releaseClaim();
      return { status: 200, body: { ok: true, sent: false } };
    }
    // Keep the claim: the member already has their welcome mail.
  }

  return { status: 200, body: { ok: true, sent: true } };
}
