// Membership requires a verified @kth.se address. The database enforces this too
// (migration 20261119120000_require_kth_email.sql); this is only for fast feedback.

export const KTH_EMAIL_REGEX = /^[^\s@]+@kth\.se$/;

export function isKthEmail(value) {
  return KTH_EMAIL_REGEX.test(String(value || "").trim().toLowerCase());
}

// Verification codes are numeric (Supabase default is 6 digits, configurable up to 10).
export function normalizeOtp(value) {
  return String(value || "").replace(/\s+/g, "");
}

export function isValidOtp(value) {
  return /^\d{6,10}$/.test(normalizeOtp(value));
}
