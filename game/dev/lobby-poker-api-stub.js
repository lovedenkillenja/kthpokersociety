// Offline stand-in for game/lib/poker-api.js for the lobby design harness (import map only). No network.

const offline = async () => ({
  ok: false, status: 0, code: "ERR_HARNESS",
  error: "Design harness: actions are disabled (mock data)."
});

export function setUnauthorizedHandler() {}
export const createTable = offline;
export const joinTable = offline;
export const fetchTableState = offline;
export const leaveTable = offline;
export const closeTable = offline;
export const setTableSeatStatus = offline;
export const tickTable = offline;
export const startHand = offline;
export const sendHandAction = offline;
export async function fetchOwnHoleCards() { return null; }
export function subscribeToTableChannel() { return { unsubscribe() {} }; }
