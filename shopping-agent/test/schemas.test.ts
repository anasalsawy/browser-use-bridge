import assert from "node:assert/strict";
import test from "node:test";
import { createRunSchema, isSameMerchant } from "../src/schemas.js";

test("accepts a constrained HTTPS shopping run", () => {
  const parsed = createRunSchema.parse({
    listId: "c2b5dd5a-2bd2-4e95-aed5-b8f75c1ad345",
    merchantUrl: "https://shop.example.com",
    items: [{ query: "unscented baby wipes", quantity: 2 }],
    budget: 50,
    currency: "usd",
  });
  assert.equal(parsed.currency, "USD");
  assert.equal(parsed.paymentMode, "secure_handoff");
});

test("rejects non-HTTPS merchants", () => {
  assert.throws(() => createRunSchema.parse({
    listId: "c2b5dd5a-2bd2-4e95-aed5-b8f75c1ad345",
    merchantUrl: "http://shop.example.com",
    items: [{ query: "paper towels" }],
    budget: 50,
    currency: "USD",
  }));
});

test("prevents cross-merchant redirects", () => {
  assert.equal(isSameMerchant("https://checkout.shop.example.com/cart", "https://shop.example.com"), true);
  assert.equal(isSameMerchant("https://example.com.evil.test/cart", "https://example.com"), false);
});
