// Supabase Edge Function `act`:
// Handles gameplay intents (`start`, `fold`, `check`, `call`, `raise`, `bet`, `all-in`, plus `join`/`leave`).
// Verifies member JWT, locks table, applies engine transitions, writes `hole_cards` & `hand_actions`,
// keeps `table_seats.stack` in sync with `hands.pot`, and broadcasts sanitized public state on `table:<code>`.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { CORS_HEADERS, jsonResponse, extractBearerToken } from "../_shared/cors.js";
import { createSupabaseStore } from "../_shared/supabase-store.js";
import { handleActRequest } from "../_shared/handlers.js";

Deno.serve(async (req: Request) => {
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

  let payload: Record<string, unknown> = {};
  try {
    payload = await req.json();
  } catch (_err) {
    return jsonResponse({ ok: false, code: "ERR_INVALID_JSON", error: "Invalid JSON body." }, 400);
  }

  const jwt = extractBearerToken(req);
  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const store = createSupabaseStore(supabaseAdmin);

  const result = await handleActRequest({ store, jwt, payload });
  return jsonResponse(result.body, result.status);
});
