// Supabase Edge Function `welcome` (deploy with JWT verification on).
// Called by the site after a member signs in. Sends the welcome mail once per member
// (claim on members.welcome_sent_at) and a minimal notice to the society inbox.
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SMTP_USER, SMTP_PASS, MAIL_FROM_NAME.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { CORS_HEADERS, jsonResponse, extractBearerToken } from "../_shared/cors.js";
import { createWelcomeStore } from "../_shared/welcome-store.js";
import { handleWelcomeRequest } from "../_shared/welcome.js";
import { sendMail } from "../_shared/mail.js";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, code: "ERR_METHOD_NOT_ALLOWED", error: "Use POST." }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(
      { ok: false, code: "ERR_SERVER_CONFIG", error: "Server configuration incomplete." },
      500
    );
  }

  // The body is optional; nothing in it is trusted (never a recipient address).
  let payload = {};
  try {
    const raw = await req.text();
    payload = raw ? JSON.parse(raw) : {};
  } catch (_err) {
    return jsonResponse({ ok: false, code: "ERR_INVALID_JSON", error: "Invalid JSON body." }, 400);
  }

  const jwt = extractBearerToken(req);
  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const store = createWelcomeStore(supabaseAdmin);

  try {
    const result = await handleWelcomeRequest({
      store,
      sendMail,
      jwt,
      payload,
      logError: (code) => console.error(`welcome: ${code}`)
    });
    return jsonResponse(result.body, result.status);
  } catch (_err) {
    return jsonResponse({ ok: false, code: "ERR_INTERNAL", error: "Unexpected server error." }, 500);
  }
});
