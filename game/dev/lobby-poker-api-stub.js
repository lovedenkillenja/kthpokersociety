// Offline stand-in for game/lib/poker-api.js for the lobby design harness (import map only). No network.

const offline = async () => ({
  ok: false, status: 0, code: "ERR_HARNESS",
  error: "Design harness: actions are disabled (mock data)."
});

export function setUnauthorizedHandler() {}
export const createTable = offline;
export const joinTable = offline;
// Join flow demo: room codes MICRO (1/2) and STDRD (10/20) answer with their own stakes; others stay offline.
const DEMO_TABLES = {
  MICRO: { code: "MICRO", status: "open", sb: 1, bb: 2, minBuyIn: 40, maxBuyIn: 200, seats: [] },
  STDRD: { code: "STDRD", status: "open", sb: 10, bb: 20, minBuyIn: 400, maxBuyIn: 2000, seats: [] }
};
export async function fetchTableState(code) {
  const table = DEMO_TABLES[String(code || "").toUpperCase()];
  return table ? { ok: true, table } : offline();
}
export const leaveTable = offline;
export const closeTable = offline;
export const setTableSeatStatus = offline;
export const tickTable = offline;
export const startHand = offline;
export const sendHandAction = offline;
export async function fetchOwnHoleCards() { return null; }
export function subscribeToTableChannel() { return { unsubscribe() {} }; }
