import assert from "node:assert/strict";
import test from "node:test";
import { apply as install } from "../lib/index.js";

// The patch is Windows-only (AGENTS.md). Run every wiring test as win32 so the
// suite is meaningful on Linux CI, and let the platform tests below switch the
// reported platform explicitly.
const withPlatform = (platform, fn) => {
	const original = process.platform;
	if (original !== platform) Object.defineProperty(process, "platform", { value: platform, configurable: true });
	try {
		return fn();
	} finally {
		if (original !== platform) Object.defineProperty(process, "platform", { value: original, configurable: true });
	}
};
const apply = (ctx) => withPlatform("win32", () => install(ctx));

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
/* ---- robustness: window races, malformed state, lifecycle ---- */

test("a window slide between read and snapshot does not duplicate bytes", () => {
	const collector = (() => {
		let full = Buffer.from("a".repeat(100), "utf8");
		let appended = false;
		return {
			snapshot() {
				const bytes = full.subarray(full.length - 60);
				return { bytes, totalBytes: full.length };
			},
			readFrom(fromByte) {
				const windowStart = full.length - 60;
				const bytes = full.subarray(windowStart);
				const result = { text: bytes.subarray(fromByte - windowStart).toString("utf8"), lossy: fromByte < windowStart, nextOffset: full.length };
				if (!appended) {
					appended = true;
					full = Buffer.concat([full, Buffer.from("bbbbbbbb")]);
				}
				return result;
			},
			finalize() {
				return { text: "", truncated: false };
			},
		};
	})();
	const service = { spawn: () => ({ collected: { stdout: collector, stderr: null } }) };
	apply({ get: (name) => (name === "subprocess" ? service : undefined) });
	const r = service.spawn().collected.stdout.readFrom(44);
	assert.equal(r.text.length, 56, "only the requested slice, never the larger tail");
	assert.equal(r.lossy, false);
});

test("a total shorter than the retained window does not shift offsets", () => {
	const bytes = Buffer.from("测试中文", "utf8");
	const collector = {
		snapshot: () => ({ bytes, totalBytes: 4 }),
		readFrom: () => ({ text: bytes.toString("utf8"), lossy: false, nextOffset: bytes.length }),
		finalize: () => ({ text: bytes.toString("utf8"), truncated: false }),
	};
	const service = { spawn: () => ({ collected: { stdout: collector, stderr: null } }) };
	apply({ get: (name) => (name === "subprocess" ? service : undefined) });
	assert.equal(service.spawn().collected.stdout.readFrom(0).text, "测试中文");
	assert.equal(service.spawn().collected.stdout.finalize().text, "测试中文");
});

test("a non-finite offset leaves the stock result untouched", () => {
	const ctx = makeCtx(GBK_ZHONGWEN);
	const stdout = ctx.get("subprocess").spawn().collected.stdout;
	const r = stdout.readFrom(Number.NaN);
	assert.equal(r.text, GBK_ZHONGWEN.toString("utf8"), "no whole-tail re-send");
});

test("a frozen service warns once and keeps the stock behaviour", () => {
	const warnings = [];
	const service = Object.freeze({ spawn: () => ({ collected: { stdout: makeCollector(GBK_ZHONGWEN), stderr: null } }) });
	const ctx = { get: () => service, logger: { warn: (...args) => warnings.push(args) } };
	assert.doesNotThrow(() => apply(ctx));
	assert.equal(warnings.length, 1);
	assert.match(String(warnings[0][0]), /frozen/);
});

test("a promise-returning spawn is patched after it settles", async () => {
	const service = { spawn: async () => ({ collected: { stdout: makeCollector(GBK_ZHONGWEN), stderr: null } }) };
	apply({ get: () => service });
	const handle = await service.spawn();
	assert.equal(handle.collected.stdout.readFrom(0).text, "测试中文");
});

test("dispose restores the original spawn", () => {
	const collected = makeCollector(GBK_ZHONGWEN);
	const service = { spawn: () => ({ collected: { stdout: collected, stderr: null } }) };
	const handlers = {};
	const ctx = { get: () => service, on: (event, fn) => { handlers[event] = fn; } };
	const original = service.spawn;
	apply(ctx);
	assert.notEqual(service.spawn, original);
	handlers.dispose();
	assert.equal(service.spawn, original);
	assert.equal(service.spawn().collected.stdout.readFrom(0).text, GBK_ZHONGWEN.toString("utf8"));
});

test("dispose clears the bridge marker so a reload re-installs the patch", () => {
	const collected = makeCollector(GBK_ZHONGWEN);
	const service = { spawn: () => ({ collected: { stdout: collected, stderr: null } }) };
	const handlers = {};
	const ctx = { get: () => service, on: (event, fn) => { handlers[event] = fn; } };
	const original = service.spawn;
	apply(ctx);
	handlers.dispose();
	assert.equal(service.__utf8OutputBridged, undefined, "dispose must not leave a stale bridge marker");
	apply(ctx);
	assert.equal(service.__utf8OutputBridged, true);
	assert.notEqual(service.spawn, original, "a reload must bridge again");
	assert.equal(service.spawn().collected.stdout.readFrom(0).text, "测试中文");
	handlers.dispose();
	assert.equal(service.spawn, original);
});

test("apply is a no-op on non-Windows platforms", () => {
	for (const platform of ["linux", "darwin", "freebsd"]) {
		const service = { spawn: () => ({ collected: { stdout: makeCollector(GBK_ZHONGWEN), stderr: null } }) };
		const original = service.spawn;
		withPlatform(platform, () => install({ get: () => service }));
		assert.equal(service.spawn, original, `spawn must stay untouched on ${platform}`);
		assert.equal(service.__utf8OutputBridged, undefined);
		assert.equal(service.spawn().collected.stdout.readFrom(0).text, GBK_ZHONGWEN.toString("utf8"));
	}
});

test("on win32 the bridge is installed and dispose still restores it", () => {
	const service = { spawn: () => ({ collected: { stdout: makeCollector(GBK_ZHONGWEN), stderr: null } }) };
	const handlers = {};
	const original = service.spawn;
	apply({ get: () => service, on: (event, fn) => { handlers[event] = fn; } });
	assert.equal(service.__utf8OutputBridged, true);
	assert.equal(service.spawn().collected.stdout.readFrom(0).text, "测试中文");
	handlers.dispose();
	assert.equal(service.spawn, original);
});
