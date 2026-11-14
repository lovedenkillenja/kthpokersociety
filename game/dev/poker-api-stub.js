// Offline stand-in for game/lib/poker-api.js, used only by the design harness through an import map.
// It exports the same names the table controller imports, but never touches the network or Supabase.

let mockHoleCards = null;

/** Called by the harness to set the self seat's private cards for the current mock state. */
export function setMockHoleCards(cards) {
  mockHoleCards = Array.isArray(cards) ? [...cards] : null;
}

const offline = async () => ({
  ok: false,
  status: 0,
  code: "ERR_HARNESS",
  error: "Design harness: actions are disabled (mock data)."
});

export const fetchTableState = offline;
export const joinTable = offline;
export const leaveTable = offline;
export const closeTable = offline;
export const setTableSeatStatus = offline;
export const tickTable = offline;
export const startHand = offline;
export const sendHandAction = offline;

/** Same contract as the real one: resolves to two card codes, or null. */
export async function fetchOwnHoleCards(handId, userId) {
  if (!handId || !userId) return null;
  return mockHoleCards;
}

export function subscribeToTableChannel() {
  return { unsubscribe() {} };
}
