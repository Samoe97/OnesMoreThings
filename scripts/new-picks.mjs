// Prints the picks that are in site/data.js but not in the last committed version, so you can sanity-check
// what the weekly update added (wrong type? wrong match?). Fix anything odd with the local editor or data/curated.json.
//   node scripts/new-picks.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parse = (src) => { const sb = { window: {} }; vm.runInNewContext(src, sb); return sb.window.OMT_DATA.picks; };
const now = parse(fs.readFileSync(path.join(root, "site", "data.js"), "utf8"));
let before = [];
try { before = parse(execFileSync("git", ["show", "HEAD:site/data.js"], { cwd: root, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8")); } catch {}
const had = new Set(before.map((p) => p.id));
const added = now.filter((p) => !had.has(p.id));
if (!added.length) console.log("No new picks.");
else {
  console.log(`${added.length} new pick(s):`);
  for (const p of added) console.log(`  ${p.host.padEnd(6)} ${String(p.type).padEnd(8)} ${p.title}${p.year ? " (" + p.year + ")" : ""}${p.image ? "" : "   <- no cover found"}${p.type === "other" ? "   <- check type" : ""}`);
}
