// Production Supabase (`service_role`) adapter for the `table` and `act` Edge Functions.
// Reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` exclusively from the Edge Function environment.
// Uses atomic SECURITY DEFINER RPCs (`sit_down`, `leave_seat`, `start_hand_tx`, `apply_hand_tx`).

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_OPEN_TABLES_PER_HOST = 3;

export function createSupabaseStore(supabaseAdmin) {
  return {
    async verifyUserJwt(jwt) {
      const { data, error } = await supabaseAdmin.auth.getUser(jwt);
      if (error || !data?.user) return null;
      return data.user;
    },

    async countOpenTablesByHost(hostId) {
      const { count, error } = await supabaseAdmin
        .from("poker_tables")
        .select("id", { count: "exact", head: true })
        .eq("host_id", hostId)
        .in("status", ["open", "playing"]);

      if (error) throw error;
      return Number(count ?? 0);
    },

    async createTable({ code, hostId, sb, bb, minBuyIn, maxBuyIn, maxSeats }) {
      const openCount = await this.countOpenTablesByHost(hostId);
      if (openCount >= MAX_OPEN_TABLES_PER_HOST) {
        const err = new Error(
          `ERR_TOO_MANY_OPEN_TABLES: Host already has ${openCount} open tables (max ${MAX_OPEN_TABLES_PER_HOST}).`
        );
        err.code = "ERR_TOO_MANY_OPEN_TABLES";
        throw err;
      }

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

    async startHandTx({
      tableId,
      handNo,
      dealerSeat,
      board,
      pot,
      state,
      showdown = null,
      endedAt = null,
      seatStacks = [],
      holeCards = [],
      actions = [],
      tableStatus = "playing"
    }) {
      const { data, error } = await supabaseAdmin.rpc("start_hand_tx", {
        p_table_id: tableId,
        p_hand_no: handNo,
        p_dealer_seat: dealerSeat,
        p_board: board,
        p_pot: pot,
        p_state: state,
        p_showdown: showdown,
        p_ended_at: endedAt,
        p_seat_stacks: seatStacks,
        p_hole_cards: holeCards,
        p_actions: actions,
        p_table_status: tableStatus
      });
      if (error) throw error;
      return data;
    },

    async applyHandTx({
      handId,
      expectedActionSeq,
      board,
      pot,
      state,
      showdown = null,
      endedAt = null,
      seatStacks = [],
      holeCards = [],
      actions = [],
      tableStatus = null
    }) {
      const { data, error } = await supabaseAdmin.rpc("apply_hand_tx", {
        p_hand_id: handId,
        p_expected_action_seq: expectedActionSeq,
        p_board: board,
        p_pot: pot,
        p_state: state,
        p_showdown: showdown,
        p_ended_at: endedAt,
        p_seat_stacks: seatStacks,
        p_hole_cards: holeCards,
        p_actions: actions,
        p_table_status: tableStatus
      });
      if (error) throw error;
      return data;
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
