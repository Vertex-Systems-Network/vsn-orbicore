import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const roots = ["backlog", "knowledge-bank"];
const files = [];
async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const next = join(path, entry.name);
    if (entry.isDirectory()) await walk(next);
    else if (entry.name.endsWith(".json")) files.push(next);
  }
}
for (const root of roots) await walk(root);
for (const file of files) {
  try { JSON.parse(await readFile(file, "utf8")); }
  catch (error) { console.error(`Invalid JSON ${file}: ${error.message}`); process.exitCode = 1; }
}
if (!process.exitCode) console.log(`Validated JSON syntax for ${files.length} files.`);
