import assert from "node:assert/strict";
import test from "node:test";
import { decodeStreamText } from "../lib/index.js";

const utf8 = new TextEncoder();
const REPLACEMENT = "\uFFFD";

/** GBK bytes for 测试中文 (the classic CP936 mojibake trigger). */
const GBK_ZHONGWEN = Buffer.from([0xb2, 0xe2, 0xca, 0xd4, 0xd6, 0xd0, 0xce, 0xc4]);

test("ascii passes through", () => {
	assert.equal(decodeStreamText(Buffer.from("hello\nworld\n"), false), "hello\nworld\n");
});

test("plain utf-8 passes through", () => {
	const text = "测试中文 😀 emoji\n";
	assert.equal(decodeStreamText(Buffer.from(text, "utf8"), false), text);
});

test("empty input", () => {
	assert.equal(decodeStreamText(Buffer.alloc(0), false), "");
	assert.equal(decodeStreamText(null, false), "");
});

test("gbk bytes are recovered", () => {
	assert.equal(decodeStreamText(GBK_ZHONGWEN, false), "测试中文");
});

test("gbk window cut mid-character at the head", () => {
	// Window starts at byte 1: the first GBK character is truncated.
	const window = GBK_ZHONGWEN.subarray(1);
	const out = decodeStreamText(window, true);
	assert.ok(out.includes("试中文"), "head-truncated GBK must still decode: " + out);
	assert.ok(out.split(REPLACEMENT).length - 1 <= 1, "at most the cut edge is lost: " + out);
});

test("utf-8 window cut mid-character at the head is not mistaken for GBK", () => {
	// Regression: a long UTF-8 run with one damaged head byte used to be
	// classified as GBK and turn the whole window into mojibake.
	const text = "测试中文".repeat(5000);
	const bytes = Buffer.from(text, "utf8");
	const window = bytes.subarray(1); // start inside the first character
	const out = decodeStreamText(window, true);
	const bad = out.split(REPLACEMENT).length - 1;
	assert.ok(bad <= 3, "only the cut head character may be lost, got " + bad);
	assert.ok(out.length > text.length * 0.99, "text must survive: " + out.length);
});

test("utf-8 window cut at the tail keeps the head", () => {
	const bytes = Buffer.from("测试中文".repeat(100), "utf8");
	const window = bytes.subarray(0, bytes.length - 2);
	const out = decodeStreamText(window, false);
	assert.ok(out.startsWith("测试中文"));
	assert.ok(out.split(REPLACEMENT).length - 1 <= 3);
});

test("a single remaining gbk byte is not silently dropped", () => {
	// 测 = B2 E2; keep only the lead byte. It must not be exempted as a
	// "cut tail character" and disappear without a trace.
	const out = decodeStreamText(Buffer.from([0xb2]), false);
	assert.equal(out, REPLACEMENT);
});

test("a dangling gbk lead byte at the head is dropped, not garbled", () => {
	// 测 = B2 E2; the window starts at E2, the stray byte cannot be a character.
	assert.equal(decodeStreamText(Buffer.from([0xe2, 0xca, 0xd4]), true), "试");
});

test("a very short gbk window never throws", () => {
	const out = decodeStreamText(GBK_ZHONGWEN.subarray(0, 7), false);
	assert.ok(out.length > 0);
});