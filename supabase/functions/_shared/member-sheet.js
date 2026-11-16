// Copies new members (name, email, join date) to the society's private Google Sheet.
// Pure ES module (no Deno imports); store, postSheet and the sheet config are injected.
// Reuses the allowlist, sanitizing and poster from the apply function's sheet.js.
//
// Each call claims a few not yet synced members (any member, not only the caller), so existing members are
// backfilled over time without anyone selecting names or emails by hand. A claim is released when the copy
// fails so a later call retries. Off (and claims nothing) unless both URL and token are set.

import { buildMemberSheetBody, isAllowedSheetUrl } from "../apply/sheet.js";

export const SHEET_SYNC_BATCH = 3;

/**
 * store: { claimMembersForSheet(limit, claimedAt) -> [{id, full_name, email, created_at}],
 *          releaseMembersSheetClaim(ids, claimedAt) -> void }
 * sheet: { url, token }; postSheet: (url, body) -> Promise (throws on failure)
 */
export async function syncMembersToSheet({
  store, sheet, postSheet, now = () => Date.now(), log = () => {}, limit = SHEET_SYNC_BATCH
}) {
  const url = sheet && typeof sheet.url === "string" ? sheet.url.trim() : "";
  const token = sheet && typeof sheet.token === "string" ? sheet.token.trim() : "";
  if (!url || !token || typeof postSheet !== "function") return { synced: 0 };
  if (!isAllowedSheetUrl(url)) { log("member sheet skipped (bad_url)"); return { synced: 0 }; }

  const claimedAt = new Date(Number(now())).toISOString();
  let members;
  try {
    members = await store.claimMembersForSheet(limit, claimedAt);
  } catch {
    log("member sheet claim failed");
    return { synced: 0 };
  }
  if (!Array.isArray(members) || members.length === 0) return { synced: 0 };

  const failed = [];
  await Promise.all(members.map(async (m) => {
    try {
      await postSheet(url, buildMemberSheetBody(m, token));
    } catch (err) {
      const code = err && typeof err.code === "string" && /^[a-z0-9_]{1,32}$/.test(err.code) ? err.code : "error";
      log("member sheet failed (" + code + ")"); // never the member, the URL or the error text
      failed.push(m.id);
    }
  }));
  if (failed.length) {
    try { await store.releaseMembersSheetClaim(failed, claimedAt); } catch { log("member sheet release failed"); }
  }
  return { synced: members.length - failed.length };
}
