// Production Supabase (`service_role`) adapter for the `welcome` Edge Function.

export function createWelcomeStore(supabaseAdmin) {
  return {
    async verifyUserJwt(jwt) {
      const { data, error } = await supabaseAdmin.auth.getUser(jwt);
      if (error || !data?.user) return null;
      return data.user;
    },

    /**
     * Atomic claim: UPDATE members SET welcome_sent_at = $claimedAt
     * WHERE id = $memberId AND welcome_sent_at IS NULL RETURNING full_name.
     * Returns the row when this call won the claim, otherwise null.
     */
    async claimWelcome({ memberId, claimedAt }) {
      const { data, error } = await supabaseAdmin
        .from("members")
        .update({ welcome_sent_at: claimedAt })
        .eq("id", memberId)
        .is("welcome_sent_at", null)
        .select("full_name")
        .maybeSingle();
      if (error) throw error;
      return data ?? null;
    },

    /**
     * Releases only our own claim (matching timestamp), so a later successful claim is never undone.
     * Returns false when no row matched (the caller logs a short code).
     */
    async releaseWelcome({ memberId, claimedAt }) {
      const { data, error } = await supabaseAdmin
        .from("members")
        .update({ welcome_sent_at: null })
        .eq("id", memberId)
        .eq("welcome_sent_at", claimedAt)
        .select("id");
      if (error) throw error;
      return Array.isArray(data) && data.length > 0;
    },

    async getDisplayName(memberId) {
      const { data, error } = await supabaseAdmin
        .from("chip_profiles")
        .select("display_name")
        .eq("member_id", memberId)
        .maybeSingle();
      if (error) throw error;
      return data?.display_name ?? null;
    }
  };
}
