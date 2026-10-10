import { test } from "node:test";
import assert from "node:assert/strict";
import { partitionQuote, quotedReply } from "../client/quotes.js";

test("partitioning keeps replies after their passage and emits alternating Markdown blocks", () => {
  const parts = [{ body: "First passage.\n\nSecond passage.", answer: "After both." }];
  const split = partitionQuote(parts, 0, 16);
  assert.deepEqual(split, [{ body: "First passage.", answer: "" }, { body: "Second passage.", answer: "After both." }]);
  split[0].answer = "First answer.";
  assert.equal(quotedReply(split, "Closing."), "> First passage.\n\nFirst answer.\n\n> Second passage.\n\nAfter both.\n\nClosing.");
  assert.equal(parts.length, 1);
});

test("empty partitions are rejected and removed quote text leaves its answer intact", () => {
  const parts = [{ body: "One passage", answer: "My reply" }];
  assert.equal(partitionQuote(parts, 0, 0), parts);
  assert.equal(partitionQuote(parts, 0, 11), parts);
  assert.equal(partitionQuote(parts, 7, 3), parts);
  assert.equal(quotedReply([{ body: "", answer: "My reply" }], ""), "My reply");
});
