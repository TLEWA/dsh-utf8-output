import assert from "node:assert/strict";
import test from "node:test";
import { apply } from "../lib/index.js";

const REPLACEMENT = "\uFFFD";
const GBK_ZHONGWEN = Buffer.from([0xb2, 0xe2, 0xca, 0xd4, 0xd6, 0xd0, 0xce, 0xc4]);

/**
 * Minimal stand-in for the host OutputCollector: a bounded tail window plus
 * the same readFrom/finalize/snapshot contract the plugin relies on.
 */
function makeCollector(full, maxBytes = 4096) {
	const bytes = full.length > maxBytes ? full.subarray(full.length - maxBytes) : full;
	const windowStart = full.length - bytes.length;
	return {
		snapshot: () => ({ bytes, totalBytes: full.length }),
		readFrom(fromByte) {
			const offset = Math.max(0, fromByte - windowStart);
			return { text: bytes.subarray(offset).toString("utf8"), lossy: fromByte < windowStart };
		},
		finalize() {
			return { text: bytes.toString("utf8"), lossy: false };
		},
	};
}

function makeCtx(full, maxBytes = 4096) {
	const service = {
		spawn() {
			return { collected: { stdout: makeCollector(full, maxBytes), stderr: makeCollector(Buffer.alloc(0)) } };
		},
	};
	const ctx = { get: (name) => (name === "subprocess" ? service : undefined) };
	apply(ctx);
	return ctx;
}

const count = (text) => (text.match(/\uFFFD/g) || []).length;
const cjk = (text) => (text.match(/[\u4e00-\u9fff]/g) || []).length;

test("colon: gbk output is repaired through the service", () => {
	const ctx = makeCtx(GBK_ZHONGWEN);
	const handle = ctx.get("subprocess").spawn();
	assert.equal(handle.collected.stdout.readFrom(0).text, "测试中文");
});

test("finalize is repaired too", () => {
	const ctx = makeCtx(GBK_ZHONGWEN);
	const handle = ctx.get("subprocess").spawn();
	assert.equal(handle.collected.stdout.finalize().text, "测试中文");
});

test("gbk output larger than the window stays clean", () => {
	const full = Buffer.concat(Array(20000).fill(GBK_ZHONGWEN));
	const ctx = makeCtx(full, 4096);
	const handle = ctx.get("subprocess").spawn();
	const r = handle.collected.stdout.readFrom(0);
	assert.equal(count(r.text), 0, "no replacement characters");
	assert.equal(cjk(r.text), 2048);
	assert.equal(r.lossy, true);
});

test("utf-8 output larger than the window is not mistaken for gbk", () => {
	const full = Buffer.from("测试中文".repeat(5000), "utf8");
	const ctx = makeCtx(full, 4097);
	const handle = ctx.get("subprocess").spawn();
	const r = handle.collected.stdout.readFrom(0);
	assert.ok(count(r.text) <= 3);
	assert.ok(cjk(r.text) > 1000);
	assert.ok(r.text.endsWith("测试中文"));
});

test("plain utf-8 and ascii pass through", () => {
	const ctx = makeCtx(Buffer.from("hello 测试中文\n", "utf8"));
	const handle = ctx.get("subprocess").spawn();
	assert.equal(handle.collected.stdout.readFrom(0).text, "hello 测试中文\n");
});

test("partial readFrom gets the same clean decode", () => {
	const ctx = makeCtx(Buffer.concat([GBK_ZHONGWEN, Buffer.from("tail\n")]));
	const handle = ctx.get("subprocess").spawn();
	const r = handle.collected.stdout.readFrom(8);
	assert.equal(r.text, "tail\n");
});

test("apply is idempotent and keeps the handle identity", () => {
	const full = GBK_ZHONGWEN;
	const ctx = makeCtx(full);
	const svc = ctx.get("subprocess");
	const before = svc.spawn;
	apply(ctx);
	assert.equal(svc.spawn, before, "second apply must not re-wrap");
	const marker = new Date();
	assert.ok(svc.spawn({ marker }) !== undefined);
});
/**
 * Older published cores (e.g. @deepseek-ai/dsh-subprocess-local 0.0.1-rc.1)
 * keep the chunks/total fields but expose no snapshot(); the plugin must fall
 * back to them instead of silently returning the stock lossy text.
 */
function makeLegacyCollector(full, maxBytes = 4096) {
	const bytes = full.length > maxBytes ? full.subarray(full.length - maxBytes) : full;
	const windowStart = full.length - bytes.length;
	return {
		chunks: [bytes],
		bytes: bytes.length,
		total: full.length,
		readFrom(fromByte) {
			const offset = Math.max(0, fromByte - windowStart);
			return { text: bytes.subarray(offset).toString("utf8"), lossy: fromByte < windowStart };
		},
		finalize() {
			return { text: bytes.toString("utf8"), lossy: false };
		},
	};
}

test("collector without snapshot() still decodes from chunks/total", () => {
	const service = {
		spawn() {
			return { collected: { stdout: makeLegacyCollector(GBK_ZHONGWEN), stderr: makeLegacyCollector(Buffer.alloc(0)) } };
		},
	};
	const ctx = { get: (name) => (name === "subprocess" ? service : undefined) };
	apply(ctx);
	const handle = ctx.get("subprocess").spawn();
	assert.equal(handle.collected.stdout.readFrom(0).text, "测试中文");
	assert.equal(handle.collected.stdout.finalize().text, "测试中文");
});

test("legacy collector keeps a large gbk window clean", () => {
	const full = Buffer.concat(Array(20000).fill(GBK_ZHONGWEN));
	const service = {
		spawn() {
			return { collected: { stdout: makeLegacyCollector(full, 4096), stderr: makeLegacyCollector(Buffer.alloc(0)) } };
		},
	};
	const ctx = { get: (name) => (name === "subprocess" ? service : undefined) };
	apply(ctx);
	const r = ctx.get("subprocess").spawn().collected.stdout.readFrom(0);
	assert.equal(count(r.text), 0);
	assert.equal(cjk(r.text), 2048);
});
