import assert from "node:assert/strict";
import test from "node:test";
import { __test } from "../src/index.js";

test("accepts only root HTTPS Quick Tunnel origins", () => {
  assert.equal(
    __test.parseAllowedOrigin("https://alpha-bravo-charlie.trycloudflare.com"),
    "https://alpha-bravo-charlie.trycloudflare.com",
  );
  for (const value of [
    "http://safe.trycloudflare.com",
    "https://safe.trycloudflare.com/path",
    "https://safe.trycloudflare.com?query=1",
    "https://safe.trycloudflare.com:443",
    "https://safe.trycloudflare.com.evil.example",
    "https://evil.example",
    "not-a-url",
  ]) {
    assert.equal(__test.parseAllowedOrigin(value), null, value);
  }
});

test("HMAC proof is deterministic and timing-safe comparison rejects changes", async () => {
  const signature = await __test.hmacHex("x".repeat(40), "1\nnonce\nbody");
  assert.match(signature, /^[a-f0-9]{64}$/);
  assert.equal(__test.timingSafeEqual(signature, signature), true);
  assert.equal(__test.timingSafeEqual(signature, `${signature.slice(0, -1)}0`), false);
  assert.equal(__test.timingSafeEqual(signature, "short"), false);
});
