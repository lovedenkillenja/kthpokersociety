// Cloudflare Pages config: header and block-list parity with netlify.toml, and the
// functions/_middleware.js behaviour (game gate, forced 404, security headers).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SECURITY_HEADERS, BLOCKED, normalizePath, isBlocked } from "../../shared/site-policy.js";
import { onRequest } from "../../functions/_middleware.js";

const read = (p) => readFileSync(new URL("../../" + p, import.meta.url), "utf8");
const toml = read("netlify.toml").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
const tomlBlocks = (name) => toml.split(/^\s*\[\[/m).slice(1).filter((p) => p.startsWith(name + "]]"));
const tomlValue = (block, key) => {
  const m = block.match(new RegExp(`^\\s*${key}\\s*=\\s*"(.*)"\\s*$`, "m"));
  return m ? m[1] : null;
};

function netlifyHeaders() {
  const all = tomlBlocks("headers").find((b) => tomlValue(b, "for") === "/*");
  assert.ok(all, "netlify.toml has a /* headers block");
  const values = all.split(/\[headers\.values\]/)[1];
  const out = {};
  for (const m of values.matchAll(/^\s*([A-Za-z-]+)\s*=\s*"(.*)"\s*$/gm)) out[m[1]] = m[2];
  return out;
}

function cloudflareHeaders() {
  const rules = {};
  let current = null;
  for (const line of read("_headers").split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    assert.ok(line.length <= 2000, "Pages limit: 2000 characters per line");
    if (!/^\s/.test(line)) { current = line.trim(); rules[current] = {}; continue; }
    const i = line.indexOf(":");
    rules[current][line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return rules;
}

test("_headers has exactly the netlify.toml /* headers, identical values", () => {
  const cf = cloudflareHeaders();
  assert.deepEqual(Object.keys(cf), ["/*"]);
  assert.deepEqual(cf["/*"], netlifyHeaders());
});

test("middleware security headers equal netlify.toml", () => {
  assert.deepEqual(SECURITY_HEADERS, netlifyHeaders());
});

test("netlify.toml has no other headers or redirects that Cloudflare would miss", () => {
  assert.equal(tomlBlocks("headers").length, 1);
  for (const r of tomlBlocks("redirects")) {
    assert.equal(tomlValue(r, "to"), "/404.html");
    assert.match(r, /^\s*status\s*=\s*404\s*$/m);
    assert.match(r, /^\s*force\s*=\s*true\s*$/m);
  }
});

test("block list equals the forced-404 list in netlify.toml", () => {
  const netlify = tomlBlocks("redirects").map((b) => tomlValue(b, "from")).sort();
  assert.deepEqual([...BLOCKED].sort(), netlify);
});

test("_redirects has no active rules (Pages cannot return 404 from _redirects)", () => {
  const active = read("_redirects").split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
  assert.deepEqual(active, []);
});

test("path normalisation catches encoded, doubled, dotted and upper-case variants", () => {
  for (const p of ["/docs/PROJECT.md", "/%64ocs/x", "/Docs/x", "//docs/x", "/assets/%2e%2e/docs/x", "/docs",
    "/supabase/migrations/a.sql", "/AGENTS.md", "/agents.md", "/game/tests/a.js", "/game/%73cripts/a",
    "/functions/_middleware.js", "/shared/site-policy.js", "/_headers", "/.gitignore", "/%zz"]) {
    assert.equal(isBlocked(normalizePath(p)), true, p);
  }
  for (const p of ["/", "/index.html", "/assets/a.png", "/game/", "/game/engine/deck.js", "/game/app.js", "/docsx"]) {
    assert.equal(isBlocked(normalizePath(p)), false, p);
  }
});

// ---- middleware behaviour ----
const env = { DEV_CODE: "4321", DEV_COOKIE_SECRET: "test-secret" };
const run = async (request, e = env) => {
  const c = { passed: false };
  const response = await onRequest({
    request, env: e,
    next() { c.passed = true; return Promise.resolve(new Response("ASSET", { headers: { "content-type": "text/plain" } })); },
  });
  return { response, passed: c.passed };
};
const get = (path, headers = {}) => new Request("https://kthpokersociety.se" + path, { headers });
const post = (code, next = "/game/") => new Request("https://kthpokersociety.se/game/__unlock", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ code, next }).toString(),
});
const assertSecurityHeaders = (r) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(r.headers.get(k), v, k);
};
const cookieFrom = async () => (await run(post("4321"))).response.headers.get("set-cookie").split(";")[0];

test("missing env vars: gate is closed, no form, no pass-through", async () => {
  for (const e of [{}, { DEV_CODE: "4321" }, { DEV_COOKIE_SECRET: "s" }]) {
    const { response, passed } = await run(get("/game/"), e);
    assert.equal(passed, false); assert.equal(response.status, 403);
    assert.doesNotMatch(await response.text(), /<form/);
    assertSecurityHeaders(response);
    const unlock = await run(post("4321"), e);
    assert.equal(unlock.response.status, 403); assert.equal(unlock.response.headers.get("set-cookie"), null);
  }
});

test("no cookie: 401 code form with security headers and noindex", async () => {
  for (const p of ["/game", "/game/", "/game/app.js", "/%67ame/app.js"]) {
    const { response, passed } = await run(get(p));
    assert.equal(passed, false, p); assert.equal(response.status, 401, p);
    assert.match(await response.text(), /Developer code/);
    assert.equal(response.headers.get("x-robots-tag"), "noindex");
    assertSecurityHeaders(response);
  }
});

test("wrong code: 401, no cookie", async () => {
  const { response } = await run(post("0000"));
  assert.equal(response.status, 401); assert.equal(response.headers.get("set-cookie"), null);
  assert.match(await response.text(), /Wrong code/);
});

test("right code: kps_dev cookie, 30 days, HttpOnly Secure SameSite=Lax, safe redirect", async () => {
  const { response } = await run(post("4321", "/game/?ref=ABCD2345"));
  assert.equal(response.status, 303); assert.equal(response.headers.get("location"), "/game/?ref=ABCD2345");
  assert.match(response.headers.get("set-cookie"),
    /^kps_dev=[0-9a-f]{64}; Path=\/game; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/);
  const evil = await run(post("4321", "//evil.com"));
  assert.equal(evil.response.headers.get("location"), "/game/");
});

test("GET on the unlock path redirects to /game/", async () => {
  const { response } = await run(get("/game/__unlock"));
  assert.equal(response.status, 303); assert.equal(new URL(response.headers.get("location")).pathname, "/game/");
});

test("valid cookie passes through, forged cookie does not, cookie signed with another secret does not", async () => {
  const cookie = await cookieFrom();
  const ok = await run(get("/game/app.js", { cookie }));
  assert.equal(ok.passed, true); assert.equal(await ok.response.text(), "ASSET");
  assertSecurityHeaders(ok.response);
  const bad = await run(get("/game/", { cookie: "kps_dev=" + "0".repeat(64) }));
  assert.equal(bad.passed, false); assert.equal(bad.response.status, 401);
  const other = await run(get("/game/", { cookie }), { ...env, DEV_COOKIE_SECRET: "rotated" });
  assert.equal(other.passed, false); assert.equal(other.response.status, 401);
});

test("blocked paths: 404 without calling next, even with a valid game cookie", async () => {
  const cookie = await cookieFrom();
  for (const p of ["/docs/PROJECT.md", "/%64ocs/PROJECT.md", "/supabase/", "/netlify/edge-functions/game-gate.js",
    "/functions/_middleware.js", "/AGENTS.md", "/_headers"]) {
    const { response, passed } = await run(get(p));
    assert.equal(passed, false, p); assert.equal(response.status, 404, p);
    assertSecurityHeaders(response);
  }
  for (const p of ["/game/tests/engine.test.js", "/game/scripts/x.js", "/game/README.md"]) {
    const locked = await run(get(p));
    assert.equal(locked.response.status, 401, p);
    const unlocked = await run(get(p, { cookie }));
    assert.equal(unlocked.passed, false, p); assert.equal(unlocked.response.status, 404, p);
  }
});

test("normal site paths pass through with security headers, also with no env vars", async () => {
  for (const e of [env, {}]) {
    const { response, passed } = await run(get("/"), e);
    assert.equal(passed, true); assert.equal(response.status, 200);
    assertSecurityHeaders(response);
  }
});
