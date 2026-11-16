// Outgoing mail for Supabase Edge Functions (Deno only; never imported by node tests).
// Transport: Gmail SMTP over implicit TLS (smtp.gmail.com:465) via denomailer (pinned).
// Secrets (Edge Function secrets, never in git): SMTP_USER, SMTP_PASS (Gmail app password),
// MAIL_FROM_NAME. Nothing here logs secrets, recipient addresses or raw SMTP errors.
//
// The transport is swappable: callers only use `sendMail({ to, subject, text, html })`.
// To move to Resend later, add another entry to TRANSPORTS and set MAIL_TRANSPORT=resend.

import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SEND_TIMEOUT_MS = 15000;
const CLOSE_TIMEOUT_MS = 3000;

function env(name) {
  return (Deno.env.get(name) ?? "").trim();
}

function mailError(code) {
  // Only a short code: SMTP server messages can echo the recipient address.
  const err = new Error(code);
  err.code = code;
  return err;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(mailError("ERR_MAIL_TIMEOUT")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function stripHeaderUnsafe(value, max = 200) {
  return String(value ?? "").replace(/[\r\n\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

async function sendViaGmailSmtp({ to, subject, text, html }) {
  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS");
  const fromName = stripHeaderUnsafe(env("MAIL_FROM_NAME") || "KTH Poker Society", 80).replace(/["<>]/g, "");
  if (!user || !pass) throw mailError("ERR_MAIL_CONFIG");

  const client = new SMTPClient({
    connection: {
      hostname: "smtp.gmail.com",
      port: 465,
      tls: true,
      auth: { username: user, password: pass }
    }
  });
  try {
    await withTimeout(
      client.send({
        from: `"${fromName}" <${user}>`,
        to: stripHeaderUnsafe(to, 320),
        subject: stripHeaderUnsafe(subject, 200),
        content: String(text ?? ""),
        html: html ? String(html) : undefined
      }),
      SEND_TIMEOUT_MS
    );
  } catch (err) {
    throw err?.code === "ERR_MAIL_TIMEOUT" ? err : mailError("ERR_MAIL_SEND");
  } finally {
    // Bounded close: a hung connection must not hold the function past its limit.
    try {
      await withTimeout(Promise.resolve().then(() => client.close()), CLOSE_TIMEOUT_MS);
    } catch (_err) {
      // Ignore close errors; the send result is what matters.
    }
  }
}

const TRANSPORTS = {
  smtp: sendViaGmailSmtp
};

/**
 * Sends one mail. Throws an Error whose message is a short code
 * (ERR_MAIL_CONFIG, ERR_MAIL_SEND, ERR_MAIL_TIMEOUT, ERR_MAIL_INPUT) on failure.
 */
export async function sendMail({ to, subject, text, html } = {}) {
  if (!to || !subject || !text) throw mailError("ERR_MAIL_INPUT");
  const transport = TRANSPORTS[env("MAIL_TRANSPORT") || "smtp"];
  if (!transport) throw mailError("ERR_MAIL_CONFIG");
  await transport({ to, subject, text, html });
}
