// Production Supabase (`service_role`) adapter for the `table` and `act` Edge Functions.
// Reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` exclusively from the Edge Function environment.

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSupabaseStore(supabaseAdmin) {
  return {
    async verifyUserJwt(jwt) {
      const { data, error } = await supabaseAdmin.auth.getUser(jwt);
      if (error || !data?.user) return null;
      return data.user;
    },

    async createTable({ code, hostId, sb, bb, minBuyIn, maxBuyIn, maxSeats }) {
      const { data, error } = await supabaseAdmin
        .from("poker_tables")
        .insert({
          code: String(code).toUpperCase(),
          host_id: hostId,
          sb,
          bb,
          min_buyin: minBuyIn,
          max_buyin: maxBuyIn,
          max_seats: maxSeats,
          status: "open"
        })
        .select("*")
        .single();

      if (error) throw error;
      return data;
    },

    async getTableContext(tableIdOrCode) {
      const ref = String(tableIdOrCode || "").trim();
      const isUuid = UUID_REGEX.test(ref);

      const tableQuery = supabaseAdmin.from("poker_tables").select("*");
      const { data: table, error: tableErr } = await (isUuid
        ? tableQuery.eq("id", ref)
        : tableQuery.eq("code", ref.toUpperCase())
      ).maybeSingle();

      if (tableErr || !table) return null;

      const [seatsRes, handsRes] = await Promise.all([
        supabaseAdmin
          .from("table_seats")
          .select("*")
          .eq("table_id", table.id)
          .order("seat_no", { ascending: true }),
        supabaseAdmin
          .from("hands")
          .select("*")
          .eq("table_id", table.id)
          .order("hand_no", { ascending: false })
          .limit(1)
      ]);

      const seats = seatsRes.data || [];
      const latestHand = handsRes.data?.[0] || null;
      const lastHandNo = latestHand ? latestHand.hand_no : 0;

      // Load display names from `chip_profiles` (service_role bypasses own-row RLS so public broadcast has chosen display names)
      const memberIds = [...new Set(seats.map((s) => s.member_id).filter(Boolean))];
      const displayNamesByMemberId = new Map();

      if (memberIds.length > 0) {
        const { data: profiles } = await supabaseAdmin
          .from("chip_profiles")
          .select("member_id, display_name")
          .in("member_id", memberIds);

        for (const p of profiles || []) {
          displayNamesByMemberId.set(p.member_id, p.display_name);
        }
      }

      return {
        table,
        seats,
        hand: latestHand,
        lastHandNo,
        displayNamesByMemberId
      };
    },

    async sitDown({ tableId, memberId, seatNo, buyIn }) {
      const { data, error } = await supabaseAdmin.rpc("sit_down", {
        p_table_id: tableId,
        p_member_id: memberId,
        p_seat_no: seatNo,
        p_buyin: buyIn
      });
      if (error) throw error;
      return data;
    },

    async leaveSeat({ tableId, memberId }) {
      const { data, error } = await supabaseAdmin.rpc("leave_seat", {
        p_table_id: tableId,
        p_member_id: memberId
      });
      if (error) throw error;
      return data;
    },

    async updateSeatStatus(tableId, seatNo, status) {
      const { error } = await supabaseAdmin
        .from("table_seats")
        .update({ status })
        .eq("table_id", tableId)
        .eq("seat_no", seatNo);
      if (error) throw error;
    },

    async syncSeatStacks(tableId, seatStacks) {
      for (const { seatNo, stack } of seatStacks) {
        const { error } = await supabaseAdmin
          .from("table_seats")
          .update({ stack: Math.trunc(Number(stack)) })
          .eq("table_id", tableId)
          .eq("seat_no", seatNo);
        if (error) throw error;
      }
    },

    async updateTableStatus(tableId, status) {
      const { error } = await supabaseAdmin
        .from("poker_tables")
        .update({ status })
        .eq("id", tableId);
      if (error) throw error;
    },

    async insertHand({ tableId, handNo, dealerSeat, board, pot, state, showdown, endedAt }) {
      const { data, error } = await supabaseAdmin
        .from("hands")
        .insert({
          table_id: tableId,
          hand_no: handNo,
          dealer_seat: dealerSeat,
          board,
          pot,
          state,
          showdown,
          ended_at: endedAt
        })
        .select("*")
        .single();
      if (error) throw error;
      return data;
    },

    async updateHand({ handId, expectedActionSeq, board, pot, state, showdown, endedAt }) {
      const { data, error } = await supabaseAdmin
        .from("hands")
        .update({
          board,
          pot,
          state,
          showdown,
          ended_at: endedAt
        })
        .eq("id", handId)
        .is("ended_at", null)
        .eq("state->>actionSeq", String(expectedActionSeq))
        .select("*")
        .maybeSingle();

      if (error) throw error;
      return data;
    },

    async insertHoleCards(rows) {
      if (!Array.isArray(rows) || rows.length === 0) return;
      const { error } = await supabaseAdmin.from("hole_cards").insert(rows);
      if (error) throw error;
    },

    async insertHandActions(rows) {
      if (!Array.isArray(rows) || rows.length === 0) return;
      const { error } = await supabaseAdmin.from("hand_actions").insert(rows);
      if (error) throw error;
    },

    async broadcastTableState(tableCode, publicState) {
      try {
        const channel = supabaseAdmin.channel(`table:${tableCode}`);
        await channel.send({
          type: "broadcast",
          event: "state",
          payload: publicState
        });
        await supabaseAdmin.removeChannel(channel);
      } catch (_err) {
        // Non-fatal if Realtime broadcast fails transiently; state is persisted in DB
      }
    }
  };
}
