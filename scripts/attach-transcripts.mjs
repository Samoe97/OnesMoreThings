// Attach "what was said" to each pick, using the transcripts made by transcribe-all.py.
//
//   node scripts/attach-transcripts.mjs
//
// Reads  site/data.js (the picks) and data/transcripts/*.json
// Writes site/said.js (loaded by the page), data/said.json (full text), data/said-report.txt (what couldn't be matched)
//
// How it works: for each episode it finds where the "one more thing" section begins (the line after the ad break),
// then locates each pick by where its title is first spoken, walks back to the hand-off ("Maddy, what's your one more
// thing?" / "I'll go next"), and cuts the passage there up to the next pick's hand-off (or the sign-off).
// Safe to re-run any time; it never touches data.js, so a rebuild of the data doesn't lose anything.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const siteDir = path.resolve(root, arg("site", "site"));
const trDir = path.resolve(root, arg("transcripts", "data/transcripts"));
const MAX_WORDS = +arg("max-words", 800);   // words stored per pick; the rest is cut at a sentence end
const LEAD_WORDS = 70;

/* ---------- inputs ---------- */
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(siteDir, "data.js"), "utf8"), sandbox);
const picks = sandbox.window.OMT_DATA.picks;
const byGuid = new Map();
for (const p of picks) { const g = p.id.split("#")[0]; (byGuid.get(g) || byGuid.set(g, []).get(g)).push(p); }

/* ---------- text helpers ---------- */
const STOP = new Set("the a an of in on at and or to for is was it its her his he she with by from as that this i you we are be".split(" "));
const stem = w => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
const norm = s => s.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
function within(a, b, k) {                  // edit distance <= k ?
  if (Math.abs(a.length - b.length) > k) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] <= k;
}
const tokMatch = (t, w) => t === w || (t.length >= 6 && w.length >= 6 && within(t, w, t.length >= 7 ? 2 : 1));
const titleTokens = p => [...new Set(norm(p.title || "").split(" ").filter(w => w && !STOP.has(w)).map(stem))];

const JUNK = /^(thank you for watching|thanks for watching|we'?ll see you next time|see you next time|we'?ll be right back|bye)[.!]*$/i;  // Whisper filler over music/silence
const ANCHOR = /\b(?:(?:we(?:'ll| will)? be|we(?:'re| are)|come|coming|and we(?:'re| are)) back,? (?:for|with|to|in time for) (?:the )?one more thing|time for (?:the )?one more thing)/i;
const CUE_A = /(?:what(?:'s| is) your (?:very )?one more thing|(?:start|kick) us off|close us off|take it away|you(?:'re| are) (?:up|last|next)|your turn)[^.?!]*[.?!]/gi;   // a question to the next speaker: pick starts after it
const CUE_B = /\b(?:my (?:very )?one more thing|I(?:'ll| will|'m going to| am going to) go (?:first|next|last)|I(?:'ll| will) (?:go|take|kick|close))/gi;                         // the speaker announcing themselves: pick starts at this sentence
const WRAP = /(?:(?:we|they) did another episode|another episode of triple click|that(?:'s| is) (?:another|it for|that for)|that is that|well,? that is it|thank you for coming on|thanks for coming on|see you (?:both )?next|until next time)/i;

const fix = s => s.replace(/’/g, "'");
function sentenceStart(text, pos) {
  for (let i = pos - 1; i > 0; i--) if (/[.?!]/.test(text[i]) && /\s/.test(text[i + 1] || " ")) { let j = i + 1; while (/\s/.test(text[j])) j++; return j; }
  return 0;
}
function trimWords(text, max) {            // cut at the last sentence end before `max` words
  const words = text.split(/\s+/); if (words.length <= max) return { text, cut: false, total: words.length };
  let end = 0, n = 0; const re = /\S+/g; let m, last = -1;
  while ((m = re.exec(text))) { if (++n > max) break; end = m.index + m[0].length; if (/[.?!]["')\]]*$/.test(m[0])) last = end; }
  const at = last > end * 0.6 ? last : end;
  return { text: text.slice(0, at).trim() + (last > end * 0.6 ? "" : "…"), cut: true, total: words.length };
}
function lead(text) {
  const s = text.match(/[^.?!]+[.?!]+["')\]]*\s*/g) || [text]; let out = "", n = 0;
  for (const x of s) { out += x; n += x.split(/\s+/).length; if (n >= LEAD_WORDS) break; }
  return out.trim();
}
const clock = t => { t = Math.round(t); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60; return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0"); };

/* ---------- per episode ---------- */
const report = [], said = {}, full = {};
const files = fs.readdirSync(trDir).filter(f => /^\d.*\.json$/.test(f) && !f.startsWith("test"));
let matched = 0, total = 0;
for (const f of files) {
  let ep; try { ep = JSON.parse(fs.readFileSync(path.join(trDir, f), "utf8")); } catch { continue; }
  const eps = byGuid.get(ep.guid); if (!eps) continue;
  total += eps.length;
  const segs = ep.segments.filter(s => !JUNK.test(s.text.trim()));
  // where the picks section starts: the last "we're back / time for one more thing" within 10 min of the first one
  const hits = []; segs.forEach((s, i) => { const t = fix(s.text + " " + (segs[i + 1]?.text || "")); const m = ANCHOR.exec(t); if (m && m.index < s.text.length) hits.push(s.start); });
  let zoneStart = hits.length ? hits.filter(t => t <= hits[0] + 600).pop() : (ep.firstPickAt != null ? ep.firstPickAt - 120 : null);
  if (zoneStart == null) { report.push(`${f}: could not find where the picks start`); continue; }
  const zone = segs.filter(s => s.end > zoneStart);
  // one flat string, remembering which time each character belongs to
  let flat = ""; const marks = [];
  for (const s of zone) { marks.push([flat.length, s.start]); flat += fix(s.text.trim()) + " "; }
  const timeAt = pos => { let lo = 0, hi = marks.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (marks[m][0] <= pos) lo = m; else hi = m - 1; } return marks[lo][1]; };
  const words = []; { const re = /[A-Za-z0-9À-ɏ'’]+/g; let m; while ((m = re.exec(flat))) words.push({ w: stem(norm(m[0])), pos: m.index }); }
  const pairs = words.map((x, i) => (words[i + 1] ? x.w + words[i + 1].w : ""));

  // 1. where is each pick first spoken?
  const found = [];
  for (const p of eps) {
    const T = titleTokens(p); if (!T.length) continue;
    const need = T.length === 1 ? 1 : Math.max(2, Math.ceil(T.length * 0.6));
    let at = null;
    for (let i = 0; i < words.length && at == null; i++) {
      if (!T.some(t => tokMatch(t, words[i].w) || tokMatch(t, pairs[i]))) continue;
      const seen = new Set();
      for (let j = i; j < Math.min(words.length, i + 16); j++) for (const t of T) if (tokMatch(t, words[j].w) || tokMatch(t, pairs[j])) seen.add(t);
      if (seen.size >= need) at = words[i].pos;
    }
    if (at != null) found.push({ p, at });
  }
  // 2. picks whose title was never recognised: use the hand-off naming their host ("Maddy, what's your one more thing?")
  for (const p of eps) {
    if (found.some(x => x.p === p)) continue;
    const re = new RegExp(`\\b${p.host}\\b[^.?!]{0,60}(?:what(?:'s| is) your (?:very )?one more thing|start us off|close us off|take it away|you(?:'re| are) (?:up|last|next))[^.?!]*[.?!]`, "gi");
    let m, got = null; while ((m = re.exec(flat))) if (!found.some(x => Math.abs(x.at - m.index) < 300)) { got = m; break; }
    if (got) found.push({ p, at: got.index + got[0].length, viaHost: true });
  }
  found.sort((a, b) => a.at - b.at);

  // 3. walk each back to its hand-off
  const starts = [], cuts = [];
  found.forEach((x, k) => {
    const lo = Math.max(k ? found[k - 1].at + 1 : 0, x.at - 1800); let best = null, cutAt = null, m;
    for (const [re, kind] of [[CUE_A, "A"], [CUE_B, "B"]]) {
      re.lastIndex = 0;
      while ((m = re.exec(flat))) {
        const st = kind === "A" ? m.index + m[0].length : sentenceStart(flat, m.index);
        if (m.index < lo || st > x.at + 1) continue;
        if (!best || st > best) { best = st; cutAt = kind === "A" ? sentenceStart(flat, m.index) : st; }
      }
    }
    if (best != null) {                      // a hand-off question sitting right before the start belongs to the previous pick's end, not this one
      CUE_A.lastIndex = 0;
      while ((m = CUE_A.exec(flat))) { const end = m.index + m[0].length; if (end <= best && end >= lo && !flat.slice(end, best).trim()) cutAt = sentenceStart(flat, m.index); }
    }
    const st = x.viaHost ? x.at : best ?? sentenceStart(flat, x.at);
    starts.push(st); cuts.push(cutAt != null && cutAt < st ? cutAt : st);   // `cut` = where the previous pick ends (before the hand-off question)
  });
  // 4. cut passages
  found.forEach((x, k) => {
    let a = starts[k], b = flat.length;
    const ni = starts.findIndex((s, i) => i > k && s > a + 40);
    if (ni >= 0) b = Math.max(a, cuts[ni]);
    else { const w = WRAP.exec(flat.slice(a + 800)); if (w) b = sentenceStart(flat, a + 800 + w.index); }
    let text = flat.slice(a, b).replace(/\s+/g, " ").trim();
    for (let i = 0; i < 4; i++) { const m = text.match(/^(.*[.?!])\s+([^.?!]{0,25}[.?!])$/); if (m && m[2].split(" ").length <= 3) text = m[1]; else break; }   // drop trailing "Cool." / "All right."
    if (text.split(" ").length < 25) { report.push(`${f}: "${x.p.title}" matched but the passage was too short`); return; }
    const t = trimWords(text, MAX_WORDS);
    full[x.p.id] = { text, start: timeAt(a), end: timeAt(Math.max(a, b - 1)) };
    said[x.p.id] = { t: Math.round(timeAt(a)), e: Math.round(timeAt(Math.max(a, b - 1))), lead: lead(t.text), text: t.text, more: t.cut ? t.total : 0 };
    matched++;
  });
  for (const p of eps) if (!said[p.id]) report.push(`${f}: no passage for "${p.title}" (${p.host})`);
}

fs.writeFileSync(path.join(root, "data", "said.json"), JSON.stringify(full));
fs.writeFileSync(path.join(siteDir, "said.js"), "window.OMT_SAID = " + JSON.stringify(said) + ";\n");
fs.writeFileSync(path.join(root, "data", "said-report.txt"), report.join("\n") + "\n");
console.log(`Matched ${matched} of ${total} picks in ${files.length} transcripts. ${report.length} notes in data/said-report.txt`);
