import test from "node:test";
import assert from "node:assert/strict";
import { chunkSpeechText, prepareSpeechText } from "./speak-text.ts";

test("prepareSpeechText drops fenced code but keeps inline code", () => {
  const markdown = [
    "Before the example.",
    "",
    "```ts",
    "const secret = true;",
    "```",
    "",
    "Run `npm test` afterward.",
  ].join("\n");

  assert.equal(
    prepareSpeechText(markdown),
    "Before the example.\n\nRun npm test afterward.",
  );
});

test("prepareSpeechText keeps link labels and strips markdown decoration", () => {
  const markdown = [
    "# Release notes",
    "",
    "- Read [the guide](https://example.com/guide)",
    "- Keep **important** _details_",
    "> Visit https://example.com directly",
    "",
    "![Build graph](https://example.com/graph.png)",
  ].join("\n");

  assert.equal(
    prepareSpeechText(markdown),
    "Release notes\n\nRead the guide Keep important details Visit directly",
  );
});

test("prepareSpeechText preserves intraword underscores", () => {
  assert.equal(
    prepareSpeechText("Use foo_bar_baz with _care_ and __focus__."),
    "Use foo_bar_baz with care and focus.",
  );
});

test("prepareSpeechText strips table separators, pipes, and HTML tags", () => {
  const markdown = [
    "| Name | Value |",
    "| --- | :---: |",
    "| <strong>A</strong> | ~~old~~ |",
  ].join("\n");

  assert.equal(prepareSpeechText(markdown), "Name Value A old");
});

test("chunkSpeechText packs paragraphs and keeps every chunk within max", () => {
  const text = [
    "First short paragraph.",
    "Second sentence is longer. Third sentence finishes the paragraph.",
    "Last paragraph.",
  ].join("\n\n");

  const chunks = chunkSpeechText(text, 42);
  assert.deepEqual(chunks, [
    "First short paragraph.",
    "Second sentence is longer.",
    "Third sentence finishes the paragraph.",
    "Last paragraph.",
  ]);
  assert.ok(chunks.every((chunk) => chunk.length <= 42));
});

test("chunkSpeechText greedily packs paragraphs when they fit", () => {
  assert.deepEqual(chunkSpeechText("One.\n\nTwo.", 20), ["One.\n\nTwo."]);
});

test("chunkSpeechText splits an overlong sentence without exceeding max", () => {
  const chunks = chunkSpeechText("alpha beta gamma delta epsilon", 12);
  assert.deepEqual(chunks, ["alpha beta", "gamma delta", "epsilon"]);
  assert.ok(chunks.every((chunk) => chunk.length <= 12));
});

test("chunkSpeechText returns no chunks for empty input", () => {
  assert.deepEqual(chunkSpeechText(" \n\n "), []);
});
