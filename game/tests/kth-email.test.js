import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isKthEmail, isValidOtp, normalizeOtp } from "../lib/kth-email.js";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("isKthEmail accepts only @kth.se addresses", () => {
  assert.equal(isKthEmail("anna@kth.se"), true);
  assert.equal(isKthEmail("  Anna.Svensson@KTH.se "), true);
  for (const bad of ["a@gmail.com", "a@kth.se.evil.com", "a@evil.com/kth.se", "a@ug.kth.se", "a@sub.kth.se", "@kth.se", "a b@kth.se", "", null, undefined]) {
    assert.equal(isKthEmail(bad), false, String(bad));
  }
});

test("OTP validation", () => {
  assert.equal(isValidOtp("123456"), true);
  assert.equal(isValidOtp(" 123 456 "), true);
  assert.equal(normalizeOtp("123 456"), "123456");
  for (const bad of ["12345", "abcdef", "", "12345678901"]) assert.equal(isValidOtp(bad), false, bad);
});

test("migration enforces kth.se on insert and email change", () => {
  const sql = read("../../supabase/migrations/20261119120000_require_kth_email.sql");
  assert.match(sql, /before insert on auth\.users/i);
  assert.match(sql, /before update of email on auth\.users/i);
  assert.match(sql, /kth\\\.se/);
  assert.match(sql, /revoke all on function public\.enforce_kth_email/i);
});

test("both sign-up UIs require kth.se and verify with an OTP code", () => {
  for (const p of ["../../index.html", "../ui/auth-dialog.js"]) {
    const src = read(p);
    assert.match(src, /verifyOtp\(/, p);
    assert.match(src, /type: ?"signup"/, p);
    assert.match(src, /auth\.resend\(/, p);
  }
  assert.match(read("../../index.html"), /@kth\\\.se\$/);
  assert.match(read("../ui/auth-dialog.js"), /isKthEmail\(email\)/);
  assert.match(read("../index.html"), /id="verify-form"/);
});
