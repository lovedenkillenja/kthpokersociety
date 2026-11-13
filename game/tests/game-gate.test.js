import test from "node:test";
import assert from "node:assert/strict";

const env = { DEV_CODE: "4321", DEV_COOKIE_SECRET: "test-secret" };
globalThis.Netlify = { env: { get: (k) => env[k] } };
const { default: gate, safeNext } = await import("../../netlify/edge-functions/game-gate.js");

const ctx = () => { const c = { passed: false, next() { c.passed = true; return new Response("GAME"); } }; return c; };
const get = (path, headers = {}) => new Request("https://kthpokersociety.se" + path, { headers });
const post = (code, next = "/game/") => new Request("https://kthpokersociety.se/game/__unlock", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ code, next }).toString(),
});

test("without cookie the game is blocked and shows the code form", async () => {
  const c = ctx(); const r = await gate(get("/game/"), c);
  assert.equal(c.passed, false); assert.equal(r.status, 401);
  assert.match(await r.text(), /Developer code/);
  assert.equal(r.headers.get("x-robots-tag"), "noindex");
});

test("wrong code is rejected and sets no cookie", async () => {
  const r = await gate(post("0000"), ctx());
  assert.equal(r.status, 401); assert.equal(r.headers.get("set-cookie"), null);
  assert.match(await r.text(), /Wrong code/);
});

test("right code sets a secure httpOnly cookie and redirects back", async () => {
  const r = await gate(post("4321", "/game/?ref=ABCD2345"), ctx());
  assert.equal(r.status, 303); assert.equal(r.headers.get("location"), "/game/?ref=ABCD2345");
  const cookie = r.headers.get("set-cookie");
  assert.match(cookie, /^kps_dev=[0-9a-f]{64}; Path=\/game; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
});

test("the issued cookie lets requests through, a forged one does not", async () => {
  const cookie = (await gate(post("4321"), ctx())).headers.get("set-cookie").split(";")[0];
  const c1 = ctx(); const ok = await gate(get("/game/app.js", { cookie }), c1);
  assert.equal(c1.passed, true); assert.equal(await ok.text(), "GAME");
  const c2 = ctx(); const bad = await gate(get("/game/", { cookie: "kps_dev=" + "0".repeat(64) }), c2);
  assert.equal(c2.passed, false); assert.equal(bad.status, 401);
});

test("redirect target cannot leave /game", () => {
  assert.equal(safeNext("//evil.com"), "/game/");
  assert.equal(safeNext("https://evil.com"), "/game/");
  assert.equal(safeNext("/game/__unlock"), "/game/");
  assert.equal(safeNext("/other"), "/game/");
  assert.equal(safeNext("/game/?ref=X"), "/game/?ref=X");
});

test("gate fails closed when the secrets are not configured", async () => {
  const saved = { ...env }; delete env.DEV_CODE;
  const c = ctx(); const r = await gate(get("/game/"), c);
  Object.assign(env, saved);
  assert.equal(c.passed, false); assert.equal(r.status, 403);
  assert.doesNotMatch(await r.text(), /<form/);
});
