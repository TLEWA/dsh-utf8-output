/**
 * Test entry: Node 20's --test does not expand globs, and a bare directory
 * argument is resolved as a module. Discover the *.test.mjs files here and
 * hand explicit paths to the runner so every supported Node version works.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir)
	.filter((file) => file.endsWith(".test.mjs"))
	.sort()
	.map((file) => join(dir, file));

if (files.length === 0) {
	console.error("no *.test.mjs files found in " + dir);
	process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
