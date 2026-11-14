// Text-level checks on netlify.toml: security headers, blocked repository paths, game gate.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const toml = readFileSync(new URL("../../netlify.toml", import.meta.url), "utf8");
const lines = toml.split("\n").filter((l) => !l.trim().startsWith("#"));
const body = lines.join("\n");

// Split into [[table]] blocks so each assertion looks at one block.
function blocks(name) {
  const parts = body.split(/^\s*\[\[/m).slice(1);
  return parts.filter((p) => p.startsWith(name + "]]"));
}

function value(block, key) {
  const m = block.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, "m"));
  return m ? m[1].trim() : null;
}

test("CSP header is set for /* with Supabase hosts and frame-ancestors 'none'", () => {
  const all = blocks("headers").find((b) => value(b, "for") === '"/*"');
  assert.ok(all, "headers block for /* exists");
  const csp = value(all, "Content-Security-Policy");
  assert.ok(csp, "Content-Security-Policy present");
  for (const host of ["tibyyjnghhwwcxvlwmiq.supabase.co", "hrdqlaurdzyueviplbmj.supabase.co"]) {
    assert.ok(csp.includes(`https://${host}`), `https ${host}`);
    assert.ok(csp.includes(`wss://${host}`), `wss ${host}`);
  }
  for (const directive of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "default-src 'self'"]) {
    assert.ok(csp.includes(directive), directive);
  }
  assert.ok(value(all, "X-Frame-Options"), "X-Frame-Options present");
  assert.match(value(all, "Permissions-Policy") || "", /fullscreen=\(self\)/);
  assert.ok(value(all, "X-Content-Type-Options"), "X-Content-Type-Options kept");
  assert.ok(value(all, "Referrer-Policy"), "Referrer-Policy kept");
});

const BLOCKED = [
  "/docs/*", "/supabase/*", "/netlify/*", "/AGENTS.md", "/CLAUDE.md", "/README.md",
  "/netlify.toml", "/game/tests/*", "/game/scripts/*", "/game/README.md",
];

test("non-site paths get a forced 404", () => {
  const redirects = blocks("redirects");
  for (const path of BLOCKED) {
    const r = redirects.find((b) => value(b, "from") === `"${path}"`);
    assert.ok(r, `redirect for ${path}`);
    assert.equal(value(r, "status"), "404", `${path} status`);
    assert.equal(value(r, "force"), "true", `${path} force`);
  }
});

test("game engine is not blocked", () => {
  for (const r of blocks("redirects")) {
    const from = (value(r, "from") || "").replace(/"/g, "");
    assert.ok(!["/game/*", "/game/engine/*", "/*"].includes(from), `unexpected broad redirect ${from}`);
  }
});

test("game-gate edge function blocks are still present", () => {
  const fns = blocks("edge_functions").map((b) => [value(b, "function"), value(b, "path")]);
  assert.deepEqual(
    fns.filter(([f]) => f === '"game-gate"').map(([, p]) => p).sort(),
    ['"/game"', '"/game/*"'],
  );
});
