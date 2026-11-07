/**
 * End-to-end check against the real DSH subprocess service.
 *
 * Needs a local DSH install (the cordis + dsh-subprocess-local modules live
 * inside app.asar). Point DSH_ASAR_BASE at the "node_modules/" directory
 * inside app.asar, e.g.
 *
 *   DSH_ASAR_BASE=file:///D:/DSH/resources/app.asar/dsh/node_modules/ node test/integration.mjs
 */
const base = process.env.DSH_ASAR_BASE ?? "file:///D:/DSH/resources/app.asar/dsh/node_modules/";
const { Context } = await import(base + "@deepseek-ai/cordis/lib/index.js");
const { default: LocalSubprocessRuntime } = await import(base + "@deepseek-ai/dsh-subprocess-local/lib/index.js");
const plugin = await import(new URL("../lib/index.js", import.meta.url).href);

const ctx = new Context();
ctx.plugin(LocalSubprocessRuntime);
await new Promise((r) => setTimeout(r, 100));
ctx.plugin(plugin);
await new Promise((r) => setTimeout(r, 100));
const svc = ctx.get("subprocess");

let failures = 0;

async function run(label, code, maxBytes) {
	const h = svc.spawn({
		argv: ["node", "-e", code],
		cwd: process.cwd(),
		stdio: { stdin: { data: "" }, stdout: { maxBytes }, stderr: { maxBytes: 4096 } },
		graceMs: 10000,
	});
	await h.done;
	const r = h.collected.stdout.readFrom(0);
	const t = r.text;
	const fffd = (t.match(/\uFFFD/g) || []).length;
	const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
	console.log(
		label.padEnd(18),
		"len", String(t.length).padStart(8),
		"FFFD", String(fffd).padStart(4),
		"CJK", String(cjk).padStart(8),
		"lossy", r.lossy ? "Y" : "N",
		"| head", JSON.stringify(t.slice(0, 6)),
		"tail", JSON.stringify(t.slice(-6)),
	);
	return { t, fffd, cjk };
}

const a = await run("gbk-window-4k", 'process.stdout.write(Buffer.concat(Array(20000).fill(Buffer.from("b2e2cad4","hex"))))', 4096);
if (a.fffd !== 0 || a.cjk !== 2048) { failures += 1; console.error("FAIL gbk-window-4k"); }

const b = await run("utf8-window-4k", 'process.stdout.write("测试中文".repeat(5000))', 4097);
if (b.fffd > 3) { failures += 1; console.error("FAIL utf8-window-4k"); }

const c = await run("gbk-small", 'process.stdout.write(Buffer.from("b2e2cad4d6d0cec4","hex"))', 4096);
if (!c.t.includes("测试中文")) { failures += 1; console.error("FAIL gbk-small"); }

await run("gbk-2byte", 'process.stdout.write(Buffer.from("b2e2","hex"))', 4096);
await run("gbk-4byte", 'process.stdout.write(Buffer.from("b2e2cad4","hex"))', 4096);
await run("utf8-plain", 'process.stdout.write("测试中文")', 4096);
await run("ascii", 'process.stdout.write("hello world")', 4096);

const d = await run("gbk-1mb", 'process.stdout.write(Buffer.concat(Array(250000).fill(Buffer.from("b2e2cad4","hex"))))', 4 * 1024 * 1024);
if (d.fffd !== 0 || d.cjk !== 500000) { failures += 1; console.error("FAIL gbk-1mb"); }

const i = await run("utf8-1mb", 'process.stdout.write("测试中文".repeat(125000))', 4 * 1024 * 1024);
if (i.fffd !== 0 || i.cjk !== 500000) { failures += 1; console.error("FAIL utf8-1mb"); }

if (failures) {
	console.error("integration failures:", failures);
	process.exitCode = 1;
} else {
	console.log("integration OK");
}
