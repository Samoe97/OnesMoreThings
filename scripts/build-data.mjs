// Fetches the Triple Click RSS feed, extracts every "One More Thing" pick,
// optionally enriches it (TMDB / IGDB / Open Library), and writes site/data.js.
//
// Usage:   node scripts/build-data.mjs [--feed <url-or-file>] [--no-enrich]
// Needs Node 18+. API keys (all optional) are read from .env or the environment:
//   TMDB_API_KEY=...            (movies + TV)   https://www.themoviedb.org/settings/api
//   IGDB_CLIENT_ID=...          (games)         https://dev.twitch.tv/console  (register an app)
//   IGDB_CLIENT_SECRET=...
// Open Library (books) needs no key.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FEED_DEFAULT = "https://feeds.simplecast.com/6WD3bDj7";
const args = process.argv.slice(2);
const argVal = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const FEED = argVal("--feed") || FEED_DEFAULT;
const ENRICH = !args.includes("--no-enrich");
const ONLY = argVal("--only"); // pick id: re-process just that pick from site/data.js

// ---------- .env (tiny loader) ----------
for (const f of [".env", "keys.env"]) {
  if (!existsSync(path.join(ROOT, f))) continue;
  for (const line of (await readFile(path.join(ROOT, f), "utf8")).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// ---------- helpers ----------
const decode = (s) =>
  s
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&apos;|&#39;|&rsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"');
const stripTags = (s) => decode(s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
const cdata = (s) => (s || "").replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "");
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? cdata(m[1]) : "";
};

// ---------- feed ----------
async function loadFeed() {
  if (existsSync(FEED)) return readFile(FEED, "utf8");
  const res = await fetch(FEED, { headers: { "user-agent": "OneMoreThings/1.0" } });
  if (!res.ok) throw new Error(`Feed fetch failed: ${res.status}`);
  return res.text();
}

const STOP_LABELS = /^(corrections?|links?|credits?|show notes|support|membership|merch|follow|ethics|transcript|sponsor|ad|ads|discord|join|become|the show|production)/i;

/** Pull the "One More Thing" picks out of an episode's description HTML. */
function extractPicks(html) {
  const headRe = /one\s+more\s+things?\s*:?/i;
  const idx = html.search(new RegExp(`<strong[^>]*>\\s*${headRe.source}`, "i"));
  let region;
  if (idx >= 0) region = html.slice(idx);
  else {
    const plain = html.search(headRe);
    if (plain < 0) return [];
    region = html.slice(plain);
  }
  // Drop the heading itself.
  region = region.replace(/^[\s\S]*?one\s+more\s+things?\s*:?\s*(<\/strong>)?\s*(<\/p>)?/i, "");

  const paras = region.split(/<\/p>|<br\s*\/?>|<\/li>/i);
  const picks = [];
  for (const p of paras) {
    const m = p.match(/<strong[^>]*>\s*([^<:]{1,40}?)\s*:\s*<\/strong>\s*([\s\S]*)$/i) ||
              p.match(/<strong[^>]*>\s*([^<:]{1,40}?)\s*<\/strong>\s*:\s*([\s\S]*)$/i);
    if (!m) {
      if (picks.length && stripTags(p).length > 0 && !/^\s*$/.test(p)) break; // prose after picks: done
      continue;
    }
    const host = stripTags(m[1]);
    if (STOP_LABELS.test(host)) break;
    const text = stripTags(m[2]);
    if (!text) continue;
    const href = (m[2].match(/<a[^>]+href="([^"]+)"/i) || [])[1];
    picks.push({ host, text, href });
  }
  return picks;
}

// Breaks a raw pick like "Silo Season 3 (Apple)" or "Ender's Game by Orson Scott Card"
// into a clean searchable title plus whatever hints we can recover.
const PLATFORM_WORDS = /\b(hbo|max|netflix|hulu|disney|apple|prime|amazon|peacock|paramount|starz|youtube|nebula|steam|switch|ps[345]|xbox|pc|ios|android|vr|dlc|demo|beta|audiobook|link|update|spoilers?)\b/i;
const PERSON = /^[A-Z][\w.'’-]+(?: [A-Z][\w.'’-]+){1,3}$/;
function splitTitle(text) {
  let t = text.replace(/\s+/g, " ").trim();
  const notes = [];
  let m;
  while ((m = t.match(/^(.*?)\s*[(\[]([^()\[\]]{1,80})[)\]]\s*$/)) && m[1]) {
    t = m[1].trim();
    notes.unshift(m[2].trim());
  }
  let year = null, creator = null, hint = null, soft = false;
  for (const n of notes) {
    const y = n.match(/\b(19|20)\d{2}\b/);
    if (y && !year) year = +y[0];
    const byNote = n.match(/^by\s+(.+)$/i);
    if (byNote && !creator) { creator = byNote[1].trim(); hint = hint || "book"; soft = true; }
    else if (PERSON.test(n) && !/^(the|a|an)\s/i.test(n) && !PLATFORM_WORDS.test(n) && !creator) { creator = n; hint = hint || "book"; soft = true; }
  }
  // “Quoted Title” by/- Someone  ->  article
  let quoted = false;
  const q = t.match(/^[“"](.+?)[”"]\s*,?\s*(.*)$/) || t.match(/^‘(.+?)’(?=\s|$)\s*,?\s*(.*)$/); // apostrophes inside titles are fine
  if (q && q[1]) {
    quoted = true;
    const rest = q[2].trim();
    t = q[1].replace(/[,.]\s*$/, "").trim();
    if (rest) {
      const b = rest.match(/\bby\s+(.+)$/) || rest.match(/^[-–—]\s*(.+?)(?:\s+for\s.*|,.*)?$/);
      if (b) creator = creator || b[1].trim(); else notes.push(rest);
    }
    hint = "article"; soft = true;
  }
  // " by " only counts when lowercase, so titles like "Death By Lightning" survive
  const by = quoted ? null : t.match(/^(.*?)\s+by\s+(.+)$/);
  if (by && by[1]) {
    t = by[1].trim();
    creator = creator || by[2].replace(/\s*[,;].*$/, "").trim();
    hint = /^[“"‘]/.test(by[1]) ? "article" : "book";
    soft = true;
  }
  if (/^[“"‘'].+[”"’']$/.test(t)) { t = t.slice(1, -1).trim(); hint = hint || "article"; soft = true; }
  t = t.replace(/^["“]|["”]$/g, "").replace(/[,;:]\s*$/, "").trim();
  const se = t.match(/^(.*?)\s+(?:season\s+(?:\w+)|s\d+(?:\s*-\s*s?\d+)?)\b\s*(.*)$/i);
  let seasonBase = null;
  if (se && se[1]) { seasonBase = se[1].trim(); hint = "tv"; soft = false; } // title keeps the season; lookups use the bare show name
  if (/youtube/i.test(notes.join(" ") + text)) hint = hint === "book" ? "video" : hint || "video";
  const searchTitle = (seasonBase || t).replace(/\s+(remake|remaster(?:ed)?|dlc|demo|beta|technical test|update|ultra deluxe)$/i, "").replace(/\s*[:\-–]\s*(some thoughts|a review).*$/i, "").trim();
  return { title: t, note: notes.join("; "), year, creator, hint, soft, searchTitle };
}

// ---------- type guessing ----------
const NOTE_HINTS = [
  [/\b(hbo|netflix|hulu|disney\+?|apple tv\+?|prime video|amazon|peacock|paramount\+?|season|series|tv|show|anime|episode)\b/i, "tv"],
  [/\b(film|movie|dir\.|directed|theatrical)\b/i, "movie"],
  [/\b(book|novel|memoir|author|by [A-Z])/i, "book"],
  [/\b(ps[345]|switch|xbox|pc|steam|ios|android|vr|game|dlc|roguelike|nintendo|playstation)\b/i, "game"],
  [/\b(album|song|single|band|music|soundtrack|ost|lp|discography|mixtape)\b/i, "music"],
  [/\b(podcast)\b/i, "podcast"],
];
const HARDWARE = /\b(steam (deck|machine|controller|families)|switch (2|oled|sports)|ps5|oculus|quest 2|gpu|rtx|monitor|pc build|console|headset|keyboard|mouse|widescreen)\b/i;
const guessType = (note, raw = "") => {
  if (/youtube/i.test(raw)) return "video";
  if (/\bpodcast\b/i.test(raw)) return "podcast";
  if (HARDWARE.test(raw)) return "hardware";
  for (const [re, t] of NOTE_HINTS) if (re.test(note)) return t;
  return null;
};

// ---------- enrichment ----------
const cachePath = path.join(ROOT, "data", "enrichment-cache.json");
const cache = existsSync(cachePath) ? JSON.parse(await readFile(cachePath, "utf8")) : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jfetch = async (url, opts) => {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status} ${url.split("?")[0]}`);
  return r.json();
};

// ---- shared helpers for building card metadata ----
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const ROMAN = { ii: 2, iii: 3, iv: 4, vi: 6, vii: 7, viii: 8, ix: 9 };
const nt = (s) => norm(s.replace(/&/g, " and ")).replace(/\b(ii|iii|iv|vi|vii|viii|ix)\b/g, (m) => ROMAN[m]);
const titleScore = (a, b) => (nt(a) === nt(b) ? 2 : nt(b).startsWith(nt(a)) || nt(a).startsWith(nt(b)) ? 1 : 0);
const uniq = (a) => [...new Set(a.filter(Boolean))];
const list = (a, n = 99) => uniq(a).slice(0, n).join(", ");
const pairs = (...p) => p.filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== "").map(([k, v]) => [k, String(v)]);
const names = { lang: new Intl.DisplayNames(["en"], { type: "language" }), region: new Intl.DisplayNames(["en"], { type: "region" }) };
const langName = (c) => { try { return c ? names.lang.of(c) : ""; } catch { return c || ""; } };
const regionName = (c) => { try { return c ? names.region.of(c) : ""; } catch { return c || ""; } };
const mins = (m) => (m ? `${Math.floor(m / 60) ? Math.floor(m / 60) + "h " : ""}${m % 60}m`.replace(/ 0m$/, "") : "");
const nice = (d) => (d ? new Date(d + (d.length === 10 ? "T12:00:00" : "")).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "");
const num = (n) => (n ? Number(n).toLocaleString("en-US") : "");

// ---- TMDB: movies + TV ----
async function tmdb(title, year, kind) {
  const key = process.env.TMDB_API_KEY;
  if (!key) return null;
  const bearer = key.length > 40;
  const headers = bearer ? { Authorization: `Bearer ${key}` } : {};
  const withKey = (o) => new URLSearchParams(bearer ? o : { ...o, api_key: key });
  const ep = kind === "tv" ? "search/tv" : kind === "movie" ? "search/movie" : "search/multi";
  const data = await jfetch(`https://api.themoviedb.org/3/${ep}?${withKey({ query: title, include_adult: "false" })}`, { headers });
  let r = (data.results || []).filter((x) => x.media_type !== "person");
  if (year) {
    const near = r.filter((x) => Math.abs(+(x.release_date || x.first_air_date || "0").slice(0, 4) - year) <= 1);
    if (near.length) r = near;
  }
  r.sort((x, y) => titleScore(title, y.title || y.name || "") - titleScore(title, x.title || x.name || "") || (y.popularity || 0) - (x.popularity || 0));
  const hit = r[0];
  if (!hit) return null;
  const type = hit.media_type === "tv" || kind === "tv" ? "tv" : "movie";
  let d = null;
  try {
    const extra = type === "tv" ? "credits,external_ids,content_ratings" : "credits,external_ids,release_dates";
    d = await jfetch(`https://api.themoviedb.org/3/${type}/${hit.id}?${withKey({ append_to_response: extra })}`, { headers });
  } catch (e) { console.warn(`  ! TMDB details failed for "${title}": ${e.message}`); }
  d = d || hit;
  const crew = d.credits?.crew || [];
  const cast = list((d.credits?.cast || []).map((c) => c.name), 5);
  const genres = list((d.genres || []).map((g) => g.name));
  const imdb = d.imdb_id || d.external_ids?.imdb_id;
  const rating = d.vote_count > 20 ? `${d.vote_average.toFixed(1)}/10 (${num(d.vote_count)} votes on TMDB)` : "";
  const country = list((d.production_countries || []).map((c) => c.name).concat((d.origin_country || []).map(regionName)), 3);
  const links = { tmdb: `https://www.themoviedb.org/${type}/${hit.id}`, ...(imdb ? { imdb: `https://www.imdb.com/title/${imdb}/` } : {}), ...(d.homepage ? { official: d.homepage } : {}) };
  let meta;
  if (type === "movie") {
    const cert = (d.release_dates?.results || []).find((x) => x.iso_3166_1 === "US")?.release_dates?.find((x) => x.certification)?.certification;
    meta = pairs(
      ["Director", list(crew.filter((c) => c.job === "Director").map((c) => c.name), 3)],
      ["Writer", list(crew.filter((c) => ["Screenplay", "Writer", "Story", "Novel", "Author"].includes(c.job)).map((c) => c.name), 3)],
      ["Studio", list((d.production_companies || []).map((c) => c.name), 3)],
      ["Starring", cast],
      ["Genre", genres],
      ["Released", nice(d.release_date)],
      ["Runtime", mins(d.runtime)],
      ["Rated", cert],
      ["Country", country],
      ["Language", langName(d.original_language)],
      ["Rating", rating]
    );
    links.letterboxd = `https://letterboxd.com/tmdb/${hit.id}/`;
  } else {
    const cert = (d.content_ratings?.results || []).find((x) => x.iso_3166_1 === "US")?.rating;
    meta = pairs(
      ["Created by", list((d.created_by || []).map((c) => c.name), 3)],
      ["Network", list((d.networks || []).map((n) => n.name), 3)],
      ["Starring", cast],
      ["Genre", genres],
      ["Seasons", d.number_of_seasons ? `${d.number_of_seasons} season${d.number_of_seasons > 1 ? "s" : ""}, ${d.number_of_episodes} episodes` : ""],
      ["Status", d.status],
      ["First aired", nice(d.first_air_date)],
      ["Last aired", d.status === "Ended" || d.status === "Canceled" ? nice(d.last_air_date) : ""],
      ["Episode length", mins((d.episode_run_time || [])[0])],
      ["Rated", cert],
      ["Country", country],
      ["Language", langName(d.original_language)],
      ["Studio", list((d.production_companies || []).map((c) => c.name), 2)],
      ["Rating", rating]
    );
  }
  return {
    type,
    matchedTitle: hit.title || hit.name,
    year: +(hit.release_date || hit.first_air_date || "0").slice(0, 4) || null,
    summary: d.overview || hit.overview || "",
    tagline: d.tagline || "",
    image: hit.poster_path ? `https://image.tmdb.org/t/p/w500${hit.poster_path}` : null,
    ids: { tmdb: hit.id },
    meta,
    links,
  };
}

// ---- IGDB: games ----
let igdbToken;
async function igdb(title, year) {
  const id = process.env.IGDB_CLIENT_ID, secret = process.env.IGDB_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (!igdbToken) {
    const t = await jfetch(`https://id.twitch.tv/oauth2/token?client_id=${id}&client_secret=${secret}&grant_type=client_credentials`, { method: "POST" });
    igdbToken = t.access_token;
  }
  const esc = title.replace(/"/g, '\\"');
  const fields = "name,slug,summary,storyline,first_release_date,cover.image_id,total_rating,total_rating_count,url,genres.name,themes.name,game_modes.name,platforms.abbreviation,platforms.name,franchises.name,involved_companies.developer,involved_companies.publisher,involved_companies.company.name,websites.url";
  let r = await jfetch("https://api.igdb.com/v4/games", {
    method: "POST",
    headers: { "Client-ID": id, Authorization: `Bearer ${igdbToken}`, "Content-Type": "text/plain" },
    body: `search "${esc}"; fields ${fields}; where version_parent = null; limit 25;`,
  });
  if (year) {
    const near = r.filter((g) => g.first_release_date && Math.abs(new Date(g.first_release_date * 1000).getFullYear() - year) <= 1);
    if (near.length) r = near;
  }
  r = [...r].sort((x, y) => titleScore(title, y.name) - titleScore(title, x.name) || (y.total_rating_count || 0) - (x.total_rating_count || 0));
  const g = r[0];
  if (!g) return null;
  const co = g.involved_companies || [];
  const sites = (g.websites || []).map((w) => w.url);
  const find = (re) => sites.find((u) => re.test(u));
  const released = g.first_release_date ? new Date(g.first_release_date * 1000).toISOString().slice(0, 10) : "";
  const links = {
    igdb: g.url,
    ...(find(/store\.steampowered\.com\/app/) ? { steam: find(/store\.steampowered\.com\/app/) } : {}),
    ...(find(/gog\.com/) ? { gog: find(/gog\.com/) } : {}),
    ...(find(/epicgames\.com/) ? { epic: find(/epicgames\.com/) } : {}),
    ...(find(/itch\.io/) ? { itch: find(/itch\.io/) } : {}),
    ...(find(/^https?:\/\/(?!.*(wikipedia|twitter|x\.com|facebook|youtube|twitch|instagram|reddit|discord|steam|gog|epic|itch|apple|google|fandom|wikia))/) ? { official: find(/^https?:\/\/(?!.*(wikipedia|twitter|x\.com|facebook|youtube|twitch|instagram|reddit|discord|steam|gog|epic|itch|apple|google|fandom|wikia))/) } : {}),
  };
  return {
    type: "game",
    matchedTitle: g.name,
    year: released ? +released.slice(0, 4) : null,
    summary: g.summary || g.storyline || "",
    image: g.cover ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${g.cover.image_id}.jpg` : null,
    ids: { igdb: g.slug },
    meta: pairs(
      ["Developer", list(co.filter((c) => c.developer).map((c) => c.company?.name), 3)],
      ["Publisher", list(co.filter((c) => c.publisher).map((c) => c.company?.name), 3)],
      ["Released", nice(released)],
      ["Platforms", list((g.platforms || []).map((p) => p.abbreviation || p.name), 8)],
      ["Genre", list((g.genres || []).map((x) => x.name))],
      ["Themes", list((g.themes || []).map((x) => x.name), 4)],
      ["Modes", list((g.game_modes || []).map((x) => x.name))],
      ["Franchise", list((g.franchises || []).map((x) => x.name), 2)],
      ["Rating", g.total_rating ? `${Math.round(g.total_rating)}/100 (${num(g.total_rating_count)} ratings on IGDB)` : ""]
    ),
    links,
  };
}

// ---- Open Library: books ----
async function openLibrary(title, creator) {
  const fields = "key,title,author_name,first_publish_year,cover_i,first_sentence,publisher,subject,number_of_pages_median,language,ratings_average,ratings_count,isbn,edition_count,id_goodreads";
  const author = (creator || "").split(/\s+(?:and|&)\s+|,/)[0].trim();
  let d = null;
  if (author) d = await jfetch(`https://openlibrary.org/search.json?${new URLSearchParams({ title, author, limit: "3", fields })}`);
  if (!d || !(d.docs || []).length) d = await jfetch(`https://openlibrary.org/search.json?${new URLSearchParams({ title, limit: "3", fields })}`);
  const b = (d.docs || [])[0];
  if (!b) return null;
  let description = Array.isArray(b.first_sentence) ? b.first_sentence[0] : b.first_sentence || "";
  try {
    const w = await jfetch(`https://openlibrary.org${b.key}.json`);
    const raw = typeof w.description === "string" ? w.description : w.description?.value;
    if (raw) description = raw.split(/\r?\n\r?\n|----------/)[0].replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
  } catch {}
  const isbn = (b.isbn || []).find((x) => x.startsWith("978") && x.length === 13) || (b.isbn || [])[0];
  const subjects = uniq((b.subject || []).filter((s) => s.length < 28 && !/^(fiction|in library|accessible book|protected daisy|large type books|open library|overdrive|reading level)/i.test(s))).slice(0, 5);
  const links = {
    openlibrary: `https://openlibrary.org${b.key}`,
    ...(b.id_goodreads?.[0] ? { goodreads: `https://www.goodreads.com/book/show/${b.id_goodreads[0]}` } : isbn ? { goodreads: `https://www.goodreads.com/book/isbn/${isbn}` } : {}),
    ...(isbn ? { storygraph: `https://app.thestorygraph.com/browse?search_term=${isbn}` } : {}),
  };
  return {
    type: "book",
    matchedTitle: b.title,
    year: b.first_publish_year || null,
    creator: (b.author_name || []).slice(0, 3).join(", "),
    summary: description,
    image: b.cover_i ? `https://covers.openlibrary.org/b/id/${b.cover_i}-L.jpg` : null,
    ids: { openlibrary: b.key },
    meta: pairs(
      ["Author", list(b.author_name, 3)],
      ["Genre", list(subjects, 5)],
      ["Publisher", list(b.publisher, 2)],
      ["First published", b.first_publish_year],
      ["Pages", num(b.number_of_pages_median)],
      ["Language", langName((b.language || [])[0])],
      ["Editions", num(b.edition_count)],
      ["ISBN", isbn],
      ["Rating", b.ratings_count > 10 ? `${b.ratings_average.toFixed(1)}/5 (${num(b.ratings_count)} ratings on Open Library)` : ""]
    ),
    links,
  };
}

// ---- Deezer: albums, songs, artists ----
async function deezer(title, creator) {
  for (const kind of ["album", "track", "artist"]) {
    const d = await jfetch(`https://api.deezer.com/search/${kind}?q=${encodeURIComponent(title)}&limit=15`);
    for (const r of d.data || []) {
      const name = kind === "artist" ? r.name : r.title;
      if (nt(name) !== nt(title)) continue;
      const artist = kind === "artist" ? r.name : r.artist?.name || "";
      if (creator && kind !== "artist" && !nt(artist).includes(nt(creator)) && !nt(creator).includes(nt(artist))) continue;
      let full = null;
      try { full = await jfetch(`https://api.deezer.com/${kind}/${r.id}`); } catch {}
      const art = kind === "artist" ? r.picture_big : kind === "album" ? r.cover_big : r.album?.cover_big;
      const rel = full?.release_date || "";
      const meta = kind === "artist"
        ? pairs(["Type", "Artist"], ["Fans", num(full?.nb_fan || r.nb_fan)], ["Albums", num(full?.nb_album || r.nb_album)])
        : pairs(
            ["Artist", artist],
            kind === "track" ? ["Album", full?.album?.title || r.album?.title] : ["Type", full?.record_type ? full.record_type[0].toUpperCase() + full.record_type.slice(1) : "Album"],
            ["Released", nice(rel)],
            ["Label", full?.label],
            ["Genre", list((full?.genres?.data || []).map((g) => g.name))],
            ["Tracks", kind === "album" ? full?.nb_tracks : ""],
            ["Length", full?.duration ? mins(Math.round(full.duration / 60)) || `${full.duration}s` : ""]
          );
      return {
        type: "music",
        musicKind: kind === "track" ? "song" : kind,
        matchedTitle: name,
        year: rel ? +rel.slice(0, 4) : null,
        creator: kind === "artist" ? null : artist,
        summary: "",
        image: art || null,
        ids: { deezer: r.link },
        meta,
        links: { deezer: r.link },
      };
    }
    await sleep(100);
  }
  return null;
}

// ---- Apple Podcasts (iTunes search; keyless, ~20 requests/minute) ----
async function applePodcast(title) {
  const term = title.replace(/\bpodcast\b/gi, "").replace(/\s+/g, " ").trim();
  const d = await jfetch(`https://itunes.apple.com/search?${new URLSearchParams({ media: "podcast", entity: "podcast", term, limit: "8" })}`);
  const hits = (d.results || []).map((x) => ({ x, s: titleScore(term, x.collectionName || "") })).filter((h) => h.s > 0).sort((a, b) => b.s - a.s);
  await sleep(3200);
  const x = hits[0]?.x;
  if (!x) return null;
  return {
    type: "podcast",
    matchedTitle: x.collectionName,
    year: null,
    summary: "",
    image: x.artworkUrl600 || null,
    ids: { applepodcast: String(x.collectionId) },
    meta: pairs(
      ["Host / publisher", x.artistName],
      ["Genre", list((x.genres || []).filter((g) => g !== "Podcasts"), 3)],
      ["Episodes", num(x.trackCount)],
      ["Latest episode", nice((x.releaseDate || "").slice(0, 10))]
    ),
    links: { applepodcasts: x.collectionViewUrl },
  };
}

// ---- Wikipedia summary (hardware) ----
async function wikipedia(title) {
  const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}?redirect=true`, { headers: { "user-agent": "OneMoreThings/1.0" } });
  if (!r.ok) return null;
  const d = await r.json();
  if (d.type !== "standard" || !(nt(d.title).includes(nt(title)) || nt(title).includes(nt(d.title)))) return null;
  return {
    type: "hardware",
    matchedTitle: d.title,
    year: null,
    summary: d.extract || "",
    image: d.thumbnail?.source || null,
    ids: {},
    meta: pairs(["Also known as", d.description]),
    links: { wikipedia: d.content_urls?.desktop?.page },
  };
}

const ENRICH_VERSION = "v2"; // bump to invalidate cached lookups when the stored fields change
async function enrich(title, year, hint, creator, force = false) {
  const sig = `${ENRICH_VERSION}${process.env.TMDB_API_KEY ? 1 : 0}${process.env.IGDB_CLIENT_ID ? 1 : 0}`; // cache is per set of configured providers
  const key = `${sig}|${norm(title)}|${year || ""}|${hint || ""}|${norm(creator || "")}`;
  if (!force && cache[key]) return cache[key]; // misses are retried each run
  const order = { game: ["game"], movie: ["video"], tv: ["video"], book: ["book"], music: ["music"], podcast: ["podcast"], hardware: ["wiki"] }[hint] || ["game", "video", "book", "music"];
  const cands = [];
  for (const o of order) {
    try {
      let c = null;
      if (o === "game") c = await igdb(title, year);
      if (o === "video") c = await tmdb(title, year, hint);
      if (o === "book") c = await openLibrary(title, creator);
      if (o === "music") c = await deezer(title, creator);
      if (o === "podcast") c = await applePodcast(title);
      if (o === "wiki") c = await wikipedia(title);
      if (c) {
        const score = o === "wiki" ? Math.max(1, titleScore(title, c.matchedTitle)) : titleScore(title, c.matchedTitle);
        // Open Library matches almost anything loosely; without a book hint, require an exact title.
        if (o === "book" && hint !== "book" && score < 2) continue;
        if (o === "music" && score < 2) continue;
        cands.push({ ...c, score });
      }
    } catch (e) {
      console.warn(`  ! ${o} lookup failed for "${title}": ${e.message}`);
    }
    await sleep(120);
  }
  // Prefer exact title matches; ties go in order game > video > book (this is a games show).
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0] && cands[0].score > 0 ? cands[0] : null;
  cache[key] = best;
  return best;
}

// ---------- main ----------
const dataDir = path.join(ROOT, "data");
const overridesPath = path.join(dataDir, "overrides.json");   // YOUR edits (from the web UI or by hand)
const classifiedPath = path.join(dataDir, "classified.json"); // pre-classified types (normalised raw text -> type)
const legacyPath = path.join(dataDir, "legacy.json");         // picks imported from the old spreadsheet
const readJson = async (f, d) => (existsSync(f) ? JSON.parse(await readFile(f, "utf8")) : d);
const overrides = await readJson(overridesPath, {});
const classified = await readJson(classifiedPath, {});
const curated = await readJson(path.join(dataDir, "curated.json"), {}); // reviewed fixes, keyed by normalised raw text; overrides.json wins over these
const splits = await readJson(path.join(dataDir, "splits.json"), {}); // normalised raw text -> [{title,type,year,creator}]
const NON_LOOKUP = ["article", "video", "other"];

/** Splits one raw pick into several: explicit entries in data/splits.json first, then "X 1 + 2" / "X 2-4" sequel numbering. */
function splitPick(text) {
  const explicit = splits[norm(text)];
  if (explicit) return explicit.map((x) => ({ ...x }));
  const m = text.trim().match(/^(.+?)\s+(\d{1,2})\s*(\+|&|and|\/|,|-|–)\s*(\d{1,2})$/i);
  if (!m || /season|series|book|vol|episode|chapter|\bs\d|part/i.test(m[1])) return null;
  const a = +m[2], b = +m[4];
  if (b <= a || b - a > 4) return null;
  const range = m[3] === "-" || m[3] === "–";
  const nums = range ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a, b];
  return nums.map((n) => ({ title: n === 1 ? m[1].trim() : `${m[1].trim()} ${n}` }));
}

/** Links in an episode's show notes (anchors and bare URLs), minus the usual membership/social boilerplate. */
const BOILER = /(maximumfun\.org|simplecast|patreon\.com|discord\.(gg|com)|bsky\.app|twitter\.com|x\.com\/|instagram\.com|facebook\.com|threads\.net|tiktok\.com|mastodon|ko-fi|redcircle|apple\.com\/.*podcast|spotify\.com\/show|podcasts\.apple)/i;
function extractLinks(html) {
  const out = [], seen = new Set();
  const add = (url, text) => {
    url = decode(url).replace(/[)\].,;]+$/, "");
    if (!/^https?:\/\//.test(url) || BOILER.test(url) || seen.has(url)) return;
    seen.add(url); out.push({ text: text.slice(0, 120), url });
  };
  for (const m of html.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) add(m[1], stripTags(m[2]));
  for (const m of stripTags(html).matchAll(/https?:\/\/[^\s<>"]+/g)) add(m[0], "");
  return out;
}
const STOPW = new Set(["the", "and", "from", "with", "that", "this", "when", "what", "your", "have", "about", "into", "just"]);
function bestLink(p, links) {
  const toks = (s) => norm(s).split(" ").filter((w) => w.length > 3 && !STOPW.has(w));
  const want = new Set(toks(`${p.title} ${p.creator || ""}`));
  if (!want.size) return null;
  let best = null, bs = 0;
  for (const l of links) {
    let slug = l.url; try { slug = decodeURIComponent(l.url); } catch {}
    const have = new Set(toks(`${l.text} ${slug.replace(/^https?:\/\/(www\.)?/, "").replace(/[\/_\-.?=&]/g, " ")}`));
    let n = 0; for (const w of want) if (have.has(w)) n++;
    const score = n / want.size;
    if (score > bs) { bs = score; best = l; }
  }
  return bs >= 0.5 ? best : null;
}
const notesByEpisode = new Map(); // episode key -> show-notes links (full build only)

/**
 * Fills in everything derived for one pick: parsed fields (p.auto) < pre-classification < your overrides,
 * plus API data from the provider that matches the type. Returns the pick.
 */
async function processPick(p, { force = false } = {}) {
  const a = p.auto;
  const ov = { ...(curated[norm(p.raw)] || {}), ...(overrides[norm(a.title)] || {}), ...(overrides[p.id] || {}) };
  const cls = p.cls || classified[norm(p.raw)];
  const hard = ov.type || cls || guessType(a.note, p.raw);
  const hint = hard || a.hint;
  const soft = !hard && a.soft;
  let e = null;
  const q = ov.search || ov.title || a.searchTitle || a.title;
  const year = ov.year || a.year;
  const creator = ov.creator || a.creator;
  if (ENRICH && ov.enrich !== false && !NON_LOOKUP.includes(hint)) {
    e = await enrich(q, year, hint, creator, force);
    if (!e && soft) e = await enrich(q, year, null, creator, force); // soft hint missed: try everything
  }
  p.title = ov.title || a.title;
  p.note = a.note;
  p.type = ov.type || e?.type || hint || "other";
  p.year = ov.year || a.year || e?.year || null;
  p.creator = ov.creator || e?.creator || a.creator || null;
  p.summary = ov.summary ?? e?.summary ?? "";
  p.image = ov.image || e?.image || null;
  p.ids = { ...(e?.ids || {}), ...(ov.ids || {}) };
  p.matched = e?.matchedTitle || null;
  p.musicKind = e?.musicKind || null;
  p.meta = e?.meta || [];
  p.links = e?.links || {};
  p.tagline = e?.tagline || "";
  p.searchTitle = q;
  p.group = ov.group || null;
  if (ov.tabletop) p.tabletop = true; // also listed under the Tabletop filter (board games, TTRPGs and their digital versions)
  if (ov.href) p.href = ov.href;
  // Articles and videos: link straight to the piece, using the episode's show notes when we have no link yet.
  if (p.type === "article" || p.type === "video") {
    const notes = notesByEpisode.get(p.epKey) || p.notes || [];
    if (!p.href && notes.length) { const m = bestLink(p, notes); if (m) p.href = m.url; }
    p.notes = p.href ? [] : notes.slice(0, 8); // keep the raw list only when we couldn't pick one
  } else delete p.notes;
  p.edited = Object.keys(overrides[p.id] || {}).length > 0;
  return p;
}

const dataJsPath = path.join(ROOT, "site", "data.js");
const writeData = async (picks) => {
  picks.sort((a, b) => b.episode.date.localeCompare(a.episode.date) || a.host.localeCompare(b.host));
  await mkdir(path.join(ROOT, "site"), { recursive: true });
  await writeFile(cachePath, JSON.stringify(cache, null, 1));
  // Leave data.js untouched when no pick changed, so the scheduled GitHub run only commits when there is something new.
  if (existsSync(dataJsPath)) {
    try {
      const prev = JSON.parse((await readFile(dataJsPath, "utf8")).replace(/^window\.OMT_DATA\s*=\s*/, "").replace(/;\s*$/, ""));
      if (JSON.stringify(prev.picks) === JSON.stringify(picks)) { console.log("No changes to site/data.js"); return; }
    } catch {}
  }
  await writeFile(dataJsPath, `window.OMT_DATA = ${JSON.stringify({ generated: new Date().toISOString(), picks })};\n`);
};

if (ONLY) {
  // ---- single-pick rescan (used by the web UI) ----
  const txt = await readFile(dataJsPath, "utf8");
  const data = JSON.parse(txt.replace(/^window\.OMT_DATA\s*=\s*/, "").replace(/;\s*$/, ""));
  const p = data.picks.find((x) => x.id === ONLY);
  if (!p) { console.error(`No pick with id ${ONLY}`); process.exit(2); }
  await processPick(p, { force: true });
  await writeData(data.picks);
  console.log("RESULT:" + JSON.stringify(p));
} else {
  // ---- full build ----
  const legacy = await readJson(legacyPath, []);
  const xml = await loadFeed();
  const items = xml.split(/<item[\s>]/i).slice(1).map((s) => s.split(/<\/item>/i)[0]);
  console.log(`Feed: ${items.length} items`);

  const picks = [];
  let noPicks = 0;
  for (const it of items) {
    const title = decode(tag(it, "title")).trim();
    const guid = tag(it, "guid").trim();
    const date = new Date(tag(it, "pubDate"));
    const epNum = +tag(it, "itunes:episode") || null;
    const type = tag(it, "itunes:episodeType");
    if (type === "bonus" || isNaN(date)) continue;
    const link = tag(it, "link").trim();
    const html = tag(it, "content:encoded") || tag(it, "description");
    notesByEpisode.set(guid || title, extractLinks(html));
    const found = extractPicks(html);
    if (!found.length) { noPicks++; console.log(`  (no picks) ${title}`); continue; }
    for (const f of found) {
      const parts = splitPick(f.text);
      const entries = parts
        ? parts.map((x) => ({ ...splitTitle(x.title), ...(x.year ? { year: x.year } : {}), ...(x.creator ? { creator: x.creator } : {}), cls: x.type }))
        : [{ ...splitTitle(f.text), cls: undefined }];
      for (const { cls, ...sp } of entries) {
        picks.push({
          id: `${guid || title}#${f.host}#${norm(sp.title)}`,
          epKey: guid || title,
          auto: sp,
          cls,
          splitFrom: parts ? f.text : null,
          host: f.host,
          raw: f.text,
          href: f.href || null,
          episode: { title, number: epNum, date: date.toISOString().slice(0, 10), url: link || null },
        });
      }
    }
  }
  for (const l of legacy) {
    picks.push({ raw: l.title, ...l, auto: { title: l.title, note: l.note || "", year: l.year || null, creator: l.creator || null, hint: l.type || null, soft: false, searchTitle: l.title } });
  }
  console.log(`Extracted ${picks.length} picks (${noPicks} episodes without a recognisable section)`);

  let n = 0;
  for (const p of picks) {
    await processPick(p);
    if (++n % 25 === 0) console.log(`  processed ${n}/${picks.length}`);
  }
  await writeData(picks);
  const other = picks.filter((p) => p.type === "other").length;
  console.log(`Wrote site/data.js — ${picks.length} picks, ${other} typed "other" (fix in the web UI or data/overrides.json)`);
}
