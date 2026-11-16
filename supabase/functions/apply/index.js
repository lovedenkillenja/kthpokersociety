// Supabase Edge Function `apply` (applications project hrdqlaurdzyueviplbmj, NOT the members project).
// Public board-application form: validates, rate-limits per hashed IP, inserts with the service role,
// then mails a short notice (name + first-choice role only) to the society inbox.
//
// No JWT: the form is public and sends only the publishable key as `apikey`. Deploy with
//   supabase functions deploy apply --project-ref hrdqlaurdzyueviplbmj --no-verify-jwt
// (the entrypoint is index.js; if the CLI does not pick it up, set
//  [functions.apply] verify_jwt = false, entrypoint = "./functions/apply/index.js" in supabase/config.toml).
//
// Secrets (Edge Function secrets, never in git): SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (provided by
// Supabase), APPLY_IP_SALT (optional, a long random string used as the HMAC key for IP hashes; falls back
// to the service role key), plus whatever ../_shared/mail.js needs.
// Optional: SHEET_WEBHOOK_URL and SHEET_WEBHOOK_TOKEN copy each accepted application to the board's Google
// Sheet through an Apps Script web app (docs/APPLICATIONS_SHEET.md). Unset = no copy.
// Before deploying, apply the migration that adds board_applications.ip_hash (see supabase/migrations,
// file *_applications_ip_hash.sql). Until then inserts fall back to rows without ip_hash and the rate
// limit fails open.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { sendMail } from "../_shared/mail.js";
import { createApplyHandler, hmacIp, reply } from "./handler.js";
import { createSheetPoster } from "./sheet.js";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ipSalt = Deno.env.get("APPLY_IP_SALT") || serviceRoleKey;

const admin = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

function missingColumn(error) {
  return !!error && (error.code === "PGRST204" || error.code === "42703");
}

const store = {
  async countRecentByIpHash(ipHash, sinceIso) {
    const { count, error } = await admin
      .from("board_applications")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ipHash)
      .gte("created_at", sinceIso);
    if (error) throw new Error("count failed");
    return count ?? 0;
  },
  async insertApplication(row) {
    let { error } = await admin.from("board_applications").insert(row);
    if (missingColumn(error)) {
      // ip_hash migration not applied yet: keep the application rather than lose it.
      const { ip_hash: _drop, ...rest } = row;
      ({ error } = await admin.from("board_applications").insert(rest));
    }
    if (error) throw new Error("insert failed");
  }
};

const handle = createApplyHandler({
  store,
  sendMail,
  hashIp: (ip) => hmacIp(ipSalt, ip),
  sheet: { url: Deno.env.get("SHEET_WEBHOOK_URL") ?? "", token: Deno.env.get("SHEET_WEBHOOK_TOKEN") ?? "" },
  postSheet: createSheetPoster(fetch),
  log: (msg) => console.error(msg)
});

Deno.serve(async (req) => {
  if (!admin && req.method !== "OPTIONS") {
    return reply(req.headers.get("origin"), 500, { ok: false, error: "server_error" });
  }
  try {
    return await handle(req);
  } catch {
    return reply(req.headers.get("origin"), 500, { ok: false, error: "server_error" });
  }
});
