// Pure formatting, validation, and normalization helpers for the KTH Poker game.
// Dependency-free so it runs in both the browser and Node (`node --test`).

const numberFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0
});

/**
 * Formats an integer chip amount with thousands separators (e.g. 1250 -> "1,250").
 * Never prefixes with currency symbols (chips have no cash value).
 */
export function formatChips(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "0";
  return numberFormat.format(Math.trunc(n));
}

/**
 * Formats a signed chip delta (e.g. 100 -> "+100", -400 -> "−400").
 */
export function formatDelta(delta) {
  const n = Number(delta);
  if (!Number.isFinite(n) || n === 0) return "0";
  const absFormatted = formatChips(Math.abs(n));
  return n > 0 ? `+${absFormatted}` : `−${absFormatted}`;
}



/**
 * Validates a member's chosen display name (1..40 chars, no control characters).
 */
export function validateDisplayName(raw) {
  const cleaned = String(raw ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length < 1) {
    return {
      valid: false,
      value: "",
      error: "Enter a display name between 1 and 40 characters."
    };
  }
  if (cleaned.length > 40) {
    return {
      valid: false,
      value: cleaned.slice(0, 40),
      error: "Display name must be at most 40 characters."
    };
  }
  return { valid: true, value: cleaned, error: "" };
}

/**
 * Derives a privacy-friendly default display name (first name + last initial, or email handle)
 * within the 1..40 character constraint of `public.chip_profiles`.
 */
export function deriveDefaultDisplayName(fullName, email) {
  const cleanFull = String(fullName ?? "").replace(/\s+/g, " ").trim();
  if (cleanFull) {
    const parts = cleanFull.split(" ");
    if (parts.length >= 2) {
      const first = parts[0];
      const lastInitial = parts[parts.length - 1].charAt(0).toUpperCase();
      const candidate = `${first} ${lastInitial}.`.slice(0, 40).trim();
      if (candidate.length >= 1) return candidate;
    }
    return cleanFull.slice(0, 40);
  }
  const handle = String(email ?? "").split("@")[0].trim();
  if (handle) return handle.slice(0, 40);
  return "KTH Member";
}

/**
 * Normalizes rows returned by `get_leaderboard(p_limit)` so UI rendering is resilient
 * regardless of exact SQL output column names.
 */
export function normalizeLeaderboardRows(rows, currentUserId = null, currentDisplayName = null) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row, idx) => {
    const rankNum = Number(row?.rank ?? row?.position ?? idx + 1);
    const displayName = String(
      row?.display_name ?? row?.name ?? row?.full_name ?? "Member"
    ).trim() || "Member";
    const balance = Number(row?.balance ?? row?.chips ?? row?.total ?? 0);
    const memberId = row?.member_id ?? row?.id ?? null;
    const isSelfById = Boolean(currentUserId && memberId && String(memberId) === String(currentUserId));
    const isSelfByFlag = Boolean(row?.is_me || row?.is_self || row?.is_current_user);
    const isSelfByName = Boolean(
      !memberId &&
      currentDisplayName &&
      displayName.toLowerCase() === String(currentDisplayName).trim().toLowerCase()
    );

    return {
      rank: Number.isFinite(rankNum) && rankNum > 0 ? rankNum : idx + 1,
      displayName,
      balance: Number.isFinite(balance) ? Math.trunc(balance) : 0,
      memberId,
      isCurrentUser: isSelfById || isSelfByFlag || isSelfByName
    };
  });
}

/**
 * Formats a human-friendly source label for `chip_ledger` rows.
 */
export function formatLedgerSource(source) {
  switch (source) {
    case "welcome":
      return "Welcome";
    case "referral":
      return "Referral";
    case "daily":
      return "Daily";
    case "event":
      return "Event";
    case "game":
      return "Table";
    case "admin":
      return "Society";
    default:
      return "Chips";
  }
}

/**
 * Maps Supabase auth and network errors to clear, actionable instructions per STYLE_GUIDE.md.
 */
export function friendlyAuthError(err) {
  const m = String(err?.message || "").toLowerCase();
  if (m.includes("invalid login")) {
    return "Email or password is wrong. Check them and try again.";
  }
  if (m.includes("not confirmed")) {
    return "Confirm your email first. Open the link we sent to your inbox.";
  }
  if (m.includes("rate limit") || m.includes("too many")) {
    return "Too many attempts right now. Wait a minute and try again.";
  }
  if (m.includes("already registered")) {
    return "An account with this email already exists. Switch to Log in.";
  }
  if (m.includes("password") && m.includes("character")) {
    return "Use a password with at least 8 characters.";
  }
  if (m.includes("failed to fetch") || m.includes("network")) {
    return "Connection lost. Check your internet connection and try again.";
  }
  return err?.message
    ? `Could not complete that action (${err.message}). Try again.`
    : "Something went wrong. Check your connection and try again.";
}
