import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

test("docs advertise only the implemented code page range", () => {
	const zh = read("README.md");
	const en = read("README.en.md");
	assert.match(zh, /只实现 GB18030\/GBK\/CP936/, "Chinese README names the code pages it implements");
	assert.match(en, /only GB18030\/GBK\/CP936/i, "English README names the code pages it implements");
	const pkg = JSON.parse(read("package.json"));
	assert.doesNotMatch(pkg.description, /CP932|CP949|Big5/, "the package description must not advertise unsupported code pages");
	assert.match(pkg.description, /GBK|GB18030|CP936/);
});
