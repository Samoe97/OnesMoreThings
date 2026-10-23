let DATA = (window.OMT_DATA && window.OMT_DATA.picks) || [];
let CAN_EDIT = false, CURRENT = null, EDITING = false;
const TYPE_LABEL = {game:"Games",movie:"Movies",tv:"TV",book:"Books",music:"Music",podcast:"Podcasts",article:"Articles",video:"Videos",hardware:"Hardware",other:"Other"};
const TYPE_ONE = {game:"Game",movie:"Movie",tv:"TV show",book:"Book",music:"Music",podcast:"Podcast",article:"Article",video:"Video",hardware:"Hardware",other:"Other"};
const st = {hosts:new Set(), types:new Set(), q:"", sort:"new", min:1};
const $ = id => document.getElementById(id);
const enc = encodeURIComponent;
const normT = s => String(s||"").toLowerCase().replace(/&/g," and ").replace(/[^a-z0-9]+/g," ").trim();
const fmtDate = d => new Date(d+"T12:00:00").toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric"});
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./,""); } catch { return "duckduckgo.com"; } };

/* ---------- grouping: the same item picked more than once ---------- */
// Entries are one item when they share a database id (so "Destiny 2" and "Destiny 2 Leviathan raid" merge),
// or else the same title, or an explicit "group".
function groupKey(p){
  if (p.group) return "t:"+normT(p.group);
  const i = p.ids || {};
  if (i.igdb) return "igdb:"+i.igdb;
  if (i.tmdb) return "tmdb:"+p.type+":"+i.tmdb;
  if (i.openlibrary) return "ol:"+i.openlibrary;
  if (i.deezer) return "dz:"+i.deezer;
  if (i.applepodcast) return "ap:"+i.applepodcast;
  return "t:"+normT(p.title);
}
let GROUPS = new Map();
function buildGroups(){
  GROUPS = new Map();
  for (const p of DATA){ const k = groupKey(p); (GROUPS.get(k) || GROUPS.set(k, []).get(k)).push(p); }
  for (const arr of GROUPS.values()) arr.sort((x,y) => y.episode.date.localeCompare(x.episode.date));
}
const timesFor = p => (GROUPS.get(groupKey(p)) || [p]);

/* ---------- link pills ---------- */
function linksFor(p){
  const L = p.links || {}, title = p.searchTitle || p.title, yr = p.year ? " "+p.year : "";
  const q = enc(title), qy = enc(title+yr), qa = enc(title + (p.creator ? " "+p.creator : ""));
  const out = [];
  const add = (name, url, domain) => url && out.push({name, url, domain: domain || hostOf(url)});
  const yt = (extra="") => add("YouTube", `https://www.youtube.com/results?search_query=${enc(title+yr+" "+extra)}`, "youtube.com");
  const wiki = () => add("Wikipedia", L.wikipedia || `https://en.wikipedia.org/w/index.php?search=${q}`, "wikipedia.org");
  if (p.href) add(p.type === "article" ? "Read the article" : p.type === "video" ? "Watch it" : "Show notes link", p.href);
  if ((p.type === "article" || p.type === "video") && !p.href)   // no direct link found: offer what the episode's show notes list
    for (const n of (p.notes || []).slice(0, 6)) add(n.text && n.text.length < 40 ? n.text : hostOf(n.url), n.url);
  switch (p.type){
    case "movie":
      add("IMDb", L.imdb || `https://www.imdb.com/find/?q=${qy}&s=tt`, "imdb.com");
      add("Letterboxd", L.letterboxd || `https://letterboxd.com/search/${q}/`, "letterboxd.com");
      add("TMDB", L.tmdb, "themoviedb.org");
      add("Rotten Tomatoes", `https://www.rottentomatoes.com/search?search=${q}`, "rottentomatoes.com");
      add("JustWatch", `https://www.justwatch.com/us/search?q=${q}`, "justwatch.com");
      yt("trailer"); wiki(); add("Official site", L.official);
      break;
    case "tv":
      add("IMDb", L.imdb || `https://www.imdb.com/find/?q=${qy}&s=tt`, "imdb.com");
      add("TMDB", L.tmdb, "themoviedb.org");
      add("Rotten Tomatoes", `https://www.rottentomatoes.com/search?search=${q}`, "rottentomatoes.com");
      add("JustWatch", `https://www.justwatch.com/us/search?q=${q}`, "justwatch.com");
      add("Letterboxd", `https://letterboxd.com/search/${q}/`, "letterboxd.com");
      yt("trailer"); wiki(); add("Official site", L.official);
      break;
    case "book":
      add("Goodreads", L.goodreads || `https://www.goodreads.com/search?q=${qa}`, "goodreads.com");
      add("StoryGraph", L.storygraph || `https://app.thestorygraph.com/browse?search_term=${q}`, "thestorygraph.com");
      add("Open Library", L.openlibrary, "openlibrary.org");
      add("Bookshop.org", `https://bookshop.org/search?keywords=${qa}`, "bookshop.org");
      add("WorldCat", `https://search.worldcat.org/search?q=${qa}`, "worldcat.org");
      wiki();
      break;
    case "game":
      add("Steam", L.steam || `https://store.steampowered.com/search/?term=${q}`, "steampowered.com");
      add("IGDB", L.igdb, "igdb.com");
      add("HowLongToBeat", `https://howlongtobeat.com/?q=${q}`, "howlongtobeat.com");
      add("Metacritic", `https://www.metacritic.com/search/${q}/?category=13`, "metacritic.com");
      add("OpenCritic", `https://opencritic.com/search?q=${q}`, "opencritic.com");
      add("GOG", L.gog, "gog.com"); add("Epic Games", L.epic, "epicgames.com"); add("itch.io", L.itch, "itch.io");
      add("Official site", L.official);
      yt("trailer"); wiki();
      break;
    case "music":
      add("Deezer", L.deezer, "deezer.com");
      add("Spotify", `https://open.spotify.com/search/${qa}`, "spotify.com");
      add("Apple Music", `https://music.apple.com/us/search?term=${qa}`, "music.apple.com");
      add("YouTube Music", `https://music.youtube.com/search?q=${qa}`, "music.youtube.com");
      add("Bandcamp", `https://bandcamp.com/search?q=${qa}`, "bandcamp.com");
      add("Discogs", `https://www.discogs.com/search/?q=${qa}`, "discogs.com");
      wiki();
      break;
    case "podcast":
      add("Apple Podcasts", L.applepodcasts || `https://podcasts.apple.com/us/search?term=${q}`, "podcasts.apple.com");
      add("Spotify", `https://open.spotify.com/search/${q}/podcasts`, "spotify.com");
      yt(); wiki();
      break;
    case "video":
      yt(); add("Web search", `https://duckduckgo.com/?q=${qa}`, "duckduckgo.com");
      break;
    case "hardware":
      wiki(); yt("review"); add("Web search", `https://duckduckgo.com/?q=${qy}`, "duckduckgo.com");
      break;
    default:
      add("Web search", `https://duckduckgo.com/?q=${enc('"'+title+'"'+(p.creator ? " "+p.creator : ""))}`, "duckduckgo.com");
      if (p.type !== "article") wiki();
  }
  const seen = new Set();
  return out.filter(l => !seen.has(l.url) && seen.add(l.url));
}
function pill(l){
  const a = document.createElement("a");
  a.className = "pill"; a.href = l.url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.title = l.name+" ("+hostOf(l.url)+")";
  const ic = document.createElement("span"); ic.className = "ic";
  const img = new Image(); img.alt = ""; img.loading = "lazy"; img.referrerPolicy = "no-referrer";
  img.src = `https://www.google.com/s2/favicons?domain=${enc(l.domain)}&sz=64`;
  img.onerror = () => { // offline or blocked: a coloured monogram instead
    let h = 0; for (const c of l.name) h = (h*31 + c.charCodeAt(0)) % 360;
    ic.style.background = `hsl(${h} 45% 42%)`; ic.textContent = l.name[0]; img.remove();
  };
  ic.append(img);
  const lb = document.createElement("span"); lb.className = "lb"; lb.textContent = l.name;
  a.append(ic, lb);
  return a;
}

/* ---------- list ---------- */
function filtered(){
  const q = st.q.trim().toLowerCase();
  const r = DATA.filter(p =>
    (!st.hosts.size || st.hosts.has(p.host)) &&
    (!st.types.size || st.types.has(p.type)) &&
    (st.min <= 1 || timesFor(p).length >= st.min) &&
    (!q || (p.title+" "+p.raw+" "+(p.creator||"")).toLowerCase().includes(q)));
  const cmp = {
    new:(a,b)=>b.episode.date.localeCompare(a.episode.date),
    old:(a,b)=>a.episode.date.localeCompare(b.episode.date),
    az:(a,b)=>a.title.localeCompare(b.title),
    most:(a,b)=>timesFor(b).length-timesFor(a).length||b.episode.date.localeCompare(a.episode.date),
    host:(a,b)=>a.host.localeCompare(b.host)||b.episode.date.localeCompare(a.episode.date),
  }[st.sort];
  return r.sort(cmp);
}
function chips(el, values, set, label){
  el.innerHTML = "";
  for (const [v,n] of values){
    const b = document.createElement("button");
    b.className = "chip"; b.setAttribute("aria-pressed", set.has(v));
    b.innerHTML = `${label(v)}<small>${n}</small>`;
    b.onclick = () => { set.has(v) ? set.delete(v) : set.add(v); render(); };
    el.append(b);
  }
}
const countBy = (arr,f)=>[...arr.reduce((m,x)=>m.set(f(x),(m.get(f(x))||0)+1),new Map())].sort((a,b)=>b[1]-a[1]);

function render(){
  buildGroups();
  renderFilters();
  const r = filtered(), ul = $("list");
  ul.innerHTML = "";
  let idx = 0;
  for (const p of r){
    const li = document.createElement("li"), b = document.createElement("button");
    li.style.setProperty("--i", Math.min(idx++, 14));
    b.className = "row";
    const th = document.createElement(p.image ? "img" : "div"); th.className = "thumb";
    if (p.image){ th.loading = "lazy"; th.alt = ""; th.src = p.image; th.onerror = () => th.removeAttribute("src"); }
    const mid = document.createElement("div");
    const t = document.createElement("div"); t.className = "t";
    t.textContent = (p.edited || p.pending ? "• " : "") + p.title + (p.year ? ` (${p.year})` : "");
    const s = document.createElement("div"); s.className = "s"; s.textContent = `${p.host} · ${fmtDate(p.episode.date)}`;
    const n = timesFor(p).length;
    if (n > 1){ const sp = document.createElement("span"); sp.className = "n"; sp.textContent = ` · ${n} picks`; s.append(sp); }
    mid.append(t, s);
    const bd = document.createElement("span"); bd.className = "badge"; bd.textContent = TYPE_LABEL[p.type]||p.type;
    b.append(th, mid, bd);
    b.onclick = () => openCard(p);
    li.append(b); ul.append(li);
  }
  $("count").textContent = `${r.length} of ${DATA.length} picks`;
  $("empty").hidden = r.length > 0;
  renderHero();
}

/* ---------- card ---------- */
const LEADS = [["Director","Directed by"],["Created by","Created by"],["Developer","Developed by"],["Author","By"],["Artist","By"],["Host / publisher","By"]];
function openCard(p){
  CURRENT = p; EDITING = false;
  const meta = (p.meta || []);
  const get = k => (meta.find(([l]) => l === k) || [])[1];

  $("m-type").textContent = p.musicKind ? p.musicKind[0].toUpperCase()+p.musicKind.slice(1) : (TYPE_ONE[p.type] || p.type);
  $("m-title").textContent = p.title;
  const lead = LEADS.map(([k,v]) => get(k) ? `${v} ${get(k)}` : null).find(Boolean) || (p.creator ? `By ${p.creator}` : "");
  $("m-sub").textContent = [p.year, lead].filter(Boolean).join(" · ");
  $("m-tagline").hidden = !p.tagline; $("m-tagline").textContent = p.tagline ? `“${p.tagline}”` : "";

  const rt = get("Rating"), rb = $("m-rating");
  const short = rt && rt.match(/^[\d.]+\/\d+/);
  rb.hidden = !short; if (short){ rb.textContent = "★ "+short[0]; rb.title = rt; }

  const cover = $("m-cover"), img = $("m-img");
  cover.classList.toggle("square", p.type === "music" || p.type === "podcast");
  $("m-ph").textContent = (TYPE_ONE[p.type] || "?")[0];
  img.hidden = !p.image; $("m-ph").hidden = !!p.image;
  img.onerror = () => { img.hidden = true; $("m-ph").hidden = false; };
  if (p.image) img.src = p.image;

  // summary with show more
  const sw = $("m-summary-wrap"), sm = $("m-summary"), more = $("m-more");
  sw.hidden = !p.summary; sm.textContent = p.summary || ""; sm.classList.add("clamp"); more.hidden = true; more.textContent = "Show more";
  more.onclick = () => { const c = sm.classList.toggle("clamp"); more.textContent = c ? "Show more" : "Show less"; };

  // metadata
  const dl = $("m-meta"); dl.innerHTML = "";
  let rows = meta.filter(([l]) => l !== "Rating");
  if (!rows.length){
    rows = [["Type", TYPE_ONE[p.type] || p.type]];
    if (p.year) rows.push(["Year", p.year]);
    if (p.creator) rows.push(["By", p.creator]);
    if (p.note) rows.push(["Note", p.note]);
    if (p.href && (p.type === "article" || p.type === "video")) rows.push(["Source", hostOf(p.href)]);
  }
  for (const [k,v] of rows){
    const dt = document.createElement("dt"), dd = document.createElement("dd");
    dt.textContent = k; dd.textContent = v; dl.append(dt, dd);
  }

  // every time it was a One More Thing
  const all = timesFor(p), ul = $("m-times"); ul.innerHTML = "";
  $("m-times-h").textContent = all.length > 1 ? `One More Thing · ${all.length} times` : "One More Thing";
  for (const x of all){
    const li = document.createElement("li"); if (x.id === p.id) li.className = "me";
    const b = document.createElement("b"); b.textContent = x.host;
    li.append(b, ` · ${fmtDate(x.episode.date)} · `);
    const link = document.createElement(x.episode.url ? "a" : "span");
    link.textContent = `${x.episode.number ? "#"+x.episode.number+" " : ""}${x.episode.title}`;
    if (x.episode.url){ link.href = x.episode.url; link.target = "_blank"; link.rel = "noopener"; }
    li.append(link);
    if (normT(x.raw) !== normT(x.title)){ const s = document.createElement("small"); s.textContent = `listed as “${x.raw}”`; li.append(s); }
    ul.append(li);
  }

  renderSaid(p, all);

  // links
  const box = $("m-links"); box.innerHTML = "";
  for (const l of linksFor(p)) box.append(pill(l));

  setStatus(p.pending ? "Edited. Open Edit and choose Rescan to refresh the details from the databases." : "");
  $("m-view").hidden = false; $("m-edit").hidden = true;
  $("m-edit-btn").hidden = !CAN_EDIT; $("m-edit-btn").textContent = "Edit";
  $("modal").hidden = false; $("close").focus();
  requestAnimationFrame(() => { more.hidden = sm.scrollHeight <= sm.clientHeight + 1; });
}
function closeCard(){ $("modal").hidden = true; CURRENT = null; EDITING = false; }
$("close").onclick = closeCard;
$("modal").onclick = e => { if (e.target.id === "modal") closeCard(); };
addEventListener("keydown", e => { if (e.key === "Escape" && !$("modal").hidden) EDITING ? cancelEdit() : closeCard(); });
$("q").oninput = e => { st.q = e.target.value; render(); };
$("sort").onchange = e => { st.sort = e.target.value; render(); };

/* ---------- editing tools (only when served by scripts/server.mjs) ---------- */
async function api(path, body){
  const r = await fetch(path, {method:"POST", headers:{"content-type":"application/json","x-omt":"1"}, body:JSON.stringify(body)});
  const j = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
function setStatus(msg, err){ const s = $("m-status"); s.textContent = msg || ""; s.className = "status" + (err ? " err" : ""); }
function btn(label, fn, cls=""){ const b = document.createElement("button"); b.type="button"; b.className = "btn "+cls; b.textContent = label; b.onclick = fn; return b; }
const busy = on => document.querySelectorAll("#m-edit .btn").forEach(b => b.disabled = on);

$("m-edit-btn").onclick = () => EDITING ? cancelEdit() : showEdit(CURRENT);
function cancelEdit(){ EDITING = false; $("m-edit").hidden = true; $("m-view").hidden = false; $("m-edit-btn").textContent = "Edit"; setStatus(CURRENT && CURRENT.pending ? "Edited. Open Edit and choose Rescan to refresh the details from the databases." : ""); }
function showEdit(p){
  EDITING = true; setStatus("");
  $("m-view").hidden = true; $("m-edit-btn").textContent = "Cancel";
  const f = $("m-edit"); f.innerHTML = ""; f.hidden = false;
  const field = (name, label, el) => { const l = document.createElement("label"); l.textContent = label; el.name = name; l.append(el); return l; };
  const input = (v, t="text") => { const i = document.createElement("input"); i.type = t; i.value = v ?? ""; return i; };
  const sel = document.createElement("select");
  for (const k of Object.keys(TYPE_LABEL)){ const o = document.createElement("option"); o.value = k; o.textContent = TYPE_ONE[k]; sel.append(o); }
  sel.value = p.type;
  const ta = document.createElement("textarea"); ta.rows = 3; ta.value = p.summary || "";
  const row = document.createElement("div"); row.className = "row2";
  row.append(field("type","Type",sel), field("year","Year",input(p.year,"number")));
  f.append(field("title","Title",input(p.title)), row, field("creator","Creator / artist / author",input(p.creator)),
    field("search","Search term for lookups (if different from title)",input(p.searchTitle !== p.title ? p.searchTitle : "")),
    field("summary","Summary (leave as-is to keep the database's)",ta), field("image","Cover image URL",input(p.image)));
  const collect = () => {
    const out = {}, cur = {title:p.title, type:p.type, year:p.year||"", creator:p.creator||"", search:p.searchTitle!==p.title?p.searchTitle:"", summary:p.summary||"", image:p.image||""};
    for (const el of f.querySelectorAll("[name]")) if (String(el.value).trim() !== String(cur[el.name])) out[el.name] = el.value.trim();
    return out;
  };
  const bs = document.createElement("div"); bs.className = "btns";
  bs.append(
    btn("Save & rescan", () => save(p, collect(), true), "primary"),
    btn("Save only", () => save(p, collect(), false)),
    btn("Rescan", () => rescan(p)),
    btn("Reset to auto", () => reset(p)),
    btn("Cancel", cancelEdit));
  f.append(bs);
}
function applyLocal(p, fields){
  const m = {title:"title", type:"type", year:"year", creator:"creator", summary:"summary", image:"image", search:"searchTitle"};
  for (const [k,v] of Object.entries(fields)) p[m[k]] = k === "year" ? (parseInt(v,10) || null) : v;
}
async function save(p, fields, andRescan){
  if (!Object.keys(fields).length){ if (andRescan) return rescan(p); return setStatus("Nothing changed."); }
  busy(true); setStatus("Saving…");
  try {
    await api("/api/edit", {id:p.id, fields});
    applyLocal(p, fields); p.pending = true; p.edited = true;
    if (andRescan) return rescan(p);
    render(); openCard(p);
  } catch(e){ setStatus("Save failed: "+e.message, true); busy(false); }
}
async function rescan(p){
  busy(true); setStatus("Looking it up…");
  try { const {pick} = await api("/api/rescan", {id:p.id}); replace(p, pick); }
  catch(e){ setStatus("Rescan failed: "+e.message, true); busy(false); }
}
async function reset(p){
  if (!confirm("Discard your edits to this entry and rebuild it from the feed?")) return;
  busy(true); setStatus("Resetting…");
  try { const {pick} = await api("/api/reset", {id:p.id}); replace(p, pick); }
  catch(e){ setStatus("Reset failed: "+e.message, true); busy(false); }
}
function replace(old, pick){
  const i = DATA.findIndex(x => x.id === old.id); if (i >= 0) DATA[i] = pick;
  render(); openCard(pick); setStatus("Updated.");
}
// The editing tools exist only when the page is served by scripts/server.mjs on this computer; the public site never offers them.
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
(LOCAL ? fetch("/api/ping") : Promise.reject()).then(r => r.ok ? r.json() : null).then(j => { if (j && j.ok){ CAN_EDIT = true; if (CURRENT && !$("modal").hidden) $("m-edit-btn").hidden = false; } }).catch(()=>{});


/* ---------- hero carousel: most recent picks per type ---------- */
const HERO_LABEL = {movie:"movies",game:"games",book:"books",tv:"TV shows",music:"music",podcast:"podcasts",article:"articles",video:"videos"};
const HERO_ORDER = ["movie","game","book","tv","music","podcast","article","video"];
const latestOfGroup = arr => arr[0]; // groups are sorted newest-first
let carIdx = 0, carTimer = null, carSig = "";
function uniqueRecent(type, n){
  const seen = new Set(), out = [];
  const sorted = DATA.filter(p => p.type === type).sort((a,b) => b.episode.date.localeCompare(a.episode.date));
  for (const p of sorted){ const k = groupKey(p); if (seen.has(k)) continue; seen.add(k); out.push(p); }
  const withImg = out.filter(p => p.image);
  return (withImg.length >= n ? withImg : out).slice(0, n);
}
function tile(p){
  const b = document.createElement("button"); b.className = "tile"; b.type = "button";
  const c = document.createElement("div"); c.className = "tile-cover" + (p.type === "music" || p.type === "podcast" ? " square" : "");
  if (p.image){ const i = new Image(); i.alt = ""; i.loading = "lazy"; i.src = p.image; i.onerror = () => { i.remove(); c.textContent = p.title; c.classList.add("noimg"); }; c.append(i); }
  else { c.textContent = p.title; c.classList.add("noimg"); }
  const t = document.createElement("div"); t.className = "tile-t"; t.textContent = p.title;
  const s = document.createElement("div"); s.className = "tile-s"; s.textContent = `${p.host} · ${fmtDate(p.episode.date)}`;
  b.append(c, t, s); b.onclick = () => openCard(p); return b;
}
function renderHero(){
  const hero = $("hero"), track = $("car-track");
  const slides = HERO_ORDER.map(t => [t, uniqueRecent(t, 6)]).filter(([,a]) => a.length >= 3);
  const sig = slides.map(([t,a]) => t+":"+a.map(p => p.id+(p.image||"")).join(",")).join("|");
  if (sig === carSig) return; carSig = sig;
  hero.hidden = !slides.length; track.innerHTML = ""; $("car-dots").innerHTML = "";
  slides.forEach(([t, arr], i) => {
    const s = document.createElement("div"); s.className = "slide"; s.setAttribute("role","group"); s.setAttribute("aria-label", `${i+1} of ${slides.length}`);
    const h = document.createElement("h2"); h.textContent = `Most recent ${HERO_LABEL[t]}`;
    const shelf = document.createElement("div"); shelf.className = "shelf";
    arr.forEach(p => shelf.append(tile(p)));
    s.append(h, shelf); track.append(s);
    const d = document.createElement("button"); d.className = "dot"; d.type = "button"; d.setAttribute("aria-label", `Show most recent ${HERO_LABEL[t]}`);
    d.onclick = () => goSlide(i, true); $("car-dots").append(d);
  });
  carIdx = Math.min(carIdx, Math.max(0, slides.length - 1)); goSlide(carIdx, false);
}
function goSlide(i, user){
  const n = $("car-track").children.length; if (!n) return;
  carIdx = (i + n) % n;
  $("car-track").style.transform = `translateX(${-100*carIdx}%)`;
  [...$("car-track").children].forEach((s,k) => s.toggleAttribute("inert", k !== carIdx));
  [...$("car-dots").children].forEach((d,k) => d.setAttribute("aria-current", k === carIdx));
  if (user) startCar();
}
function startCar(){
  clearInterval(carTimer);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  carTimer = setInterval(() => { if (!$("hero").matches(":hover, :focus-within") && $("modal").hidden && !document.hidden) goSlide(carIdx + 1); }, 7000);
}
$("car-prev").onclick = () => goSlide(carIdx - 1, true);
$("car-next").onclick = () => goSlide(carIdx + 1, true);
startCar();

/* ---------- "Recommend me a ..." ---------- */
let lastRec = null;
function initRec(){
  const ts = $("rec-type"), hs = $("rec-host");
  const REC_LABEL = {tv:"TV show",music:"song or album",hardware:"piece of hardware",other:"wildcard",article:"article"};
  const lab = t => REC_LABEL[t] || (TYPE_ONE[t]||t).toLowerCase();
  ts.innerHTML = '<option value="">thing</option>' + countBy(DATA, p => p.type).map(([t]) => `<option value="${t}">${lab(t)}</option>`).join("");
  const art = () => { $("rec-a").textContent = /^[aeiou]/i.test(ts.selectedOptions[0].textContent) ? "an" : "a"; };
  ts.addEventListener("change", art); art();
  hs.innerHTML = '<option value="">any host</option>' + countBy(DATA, p => p.host).map(([h]) => `<option value="${h}">${h}</option>`).join("");
  ts.onchange = hs.onchange = () => roll();
  $("rec-roll").onclick = () => { const d = $("rec-roll").querySelector(".die"); d.classList.remove("spin"); void d.offsetWidth; d.classList.add("spin"); roll(); };
}
function roll(){
  const t = $("rec-type").value, h = $("rec-host").value, out = $("rec-out");
  const seen = new Set(), pool = [];
  for (const p of DATA){ if ((t && p.type !== t) || (h && p.host !== h)) continue; const k = groupKey(p); if (seen.has(k)) continue; seen.add(k); pool.push(p); }
  out.innerHTML = "";
  if (!pool.length){ out.innerHTML = '<p class="rec-none">Nothing matches that combination. Try another host or category.</p>'; lastRec = null; return; }
  let p; do { p = pool[Math.floor(Math.random()*pool.length)]; } while (pool.length > 1 && lastRec && p.id === lastRec.id);
  lastRec = p;
  const b = document.createElement("button"); b.type = "button"; b.className = "rec-card";
  const th = document.createElement(p.image ? "img" : "div"); th.className = "thumb big";
  if (p.image){ th.alt = ""; th.src = p.image; th.onerror = () => th.removeAttribute("src"); }
  const mid = document.createElement("div"); mid.className = "rec-mid";
  const tt = document.createElement("div"); tt.className = "t"; tt.textContent = p.title + (p.year ? ` (${p.year})` : "");
  const ss = document.createElement("div"); ss.className = "s"; ss.textContent = `${TYPE_ONE[p.type]||p.type} · picked by ${p.host} on ${fmtDate(p.episode.date)}`;
  mid.append(tt, ss);
  if (p.summary){ const sm = document.createElement("div"); sm.className = "rec-sum"; sm.textContent = p.summary; mid.append(sm); }
  b.append(th, mid); b.onclick = () => openCard(p); out.append(b);
}
initRec(); roll();
$("minpicks").onchange = e => { st.min = parseInt(e.target.value,10) || 1; render(); };


/* ---------- "What was said": transcript passages from scripts/attach-transcripts.mjs ---------- */
const SAID = () => window.OMT_SAID || {};
const clock = t => { t = Math.round(t); const h = Math.floor(t/3600), m = Math.floor(t%3600/60), s = t%60; return (h ? h+":"+String(m).padStart(2,"0") : m)+":"+String(s).padStart(2,"0"); };
function paragraphs(text){            // the transcript is one long run of text: break it every few sentences
  const s = text.match(/[^.?!…]+(?:[.?!…]+["')\]]*|$)\s*/g) || [text], out = [];
  for (let i = 0; i < s.length; i += 4) out.push(s.slice(i, i+4).join("").trim());
  return out;
}
function renderSaid(p, all){
  const sec = $("m-said"), S = SAID();
  const have = all.filter(x => S[x.id]);
  sec.hidden = !have.length; if (!have.length) return;
  let cur = have.find(x => x.id === p.id) || have[0], open = false;
  const tabs = $("m-said-tabs"), meta = $("m-said-meta"), body = $("m-said-body"), more = $("m-said-more");
  const show = () => {
    const x = cur, s = S[x.id];
    meta.textContent = `${x.host}’s pick · ${x.episode.number ? "episode #"+x.episode.number+" · " : ""}${fmtDate(x.episode.date)} · starts at ${clock(s.t)}`;
    body.innerHTML = ""; body.classList.toggle("open", open);
    const q = document.createElement("blockquote");
    for (const t of paragraphs(open ? s.text : s.lead)){ const para = document.createElement("p"); para.textContent = t; q.append(para); }
    if (open && s.more){ const e = document.createElement("p"); e.className = "said-cut"; e.textContent = `That’s the start of it. Listen from ${clock(s.t)} in the episode to hear the rest.`; q.append(e); }
    body.append(q);
    more.hidden = s.text.length <= s.lead.length + 20;
    more.textContent = open ? "Show less" : "Read the full passage";
    for (const b of tabs.children) b.setAttribute("aria-pressed", b.dataset.id === x.id);
  };
  tabs.innerHTML = "";
  if (have.length > 1) for (const x of have){
    const b = document.createElement("button"); b.className = "chip"; b.dataset.id = x.id; b.type = "button";
    b.textContent = `${x.host} · ${fmtDate(x.episode.date)}`;
    b.onclick = () => { cur = x; open = false; show(); }; tabs.append(b);
  }
  more.onclick = () => { open = !open; show(); };
  show();
}


/* ---------- compact filters ---------- */
let moreOpen = false;
const MAIN_TYPES = ["game","tv","book","movie","music","podcast"];
function renderFilters(){
  // hosts: one segmented control. Hosts with only a handful of picks (guests) share a single "Guests" segment.
  const hc = countBy(DATA, p => p.host), main = hc.filter(([,n]) => n >= 15).map(([h]) => h), guests = hc.filter(([,n]) => n < 15).map(([h]) => h);
  const seg = $("hosts"); seg.innerHTML = "";
  const mk = (label, pressed, title, fn) => { const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.title = title || ""; b.setAttribute("aria-pressed", pressed); b.onclick = fn; seg.append(b); };
  mk("Everyone", !st.hosts.size, "", () => { st.hosts.clear(); render(); });
  for (const [h, n] of hc.filter(([h]) => main.includes(h))) mk(h, st.hosts.has(h), `${n} picks`, () => { st.hosts.has(h) ? st.hosts.delete(h) : st.hosts.add(h); render(); });
  if (guests.length) mk("Guests", guests.every(g => st.hosts.has(g)), guests.join(", "), () => { const on = guests.every(g => st.hosts.has(g)); guests.forEach(g => on ? st.hosts.delete(g) : st.hosts.add(g)); render(); });

  // types: the common ones as small pills, the rest behind "More"
  const tc = new Map(countBy(DATA, p => p.type)), box = $("types"); box.innerHTML = "";
  const first = MAIN_TYPES.filter(t => tc.has(t)), rest = [...tc.keys()].filter(t => !first.includes(t));
  if (rest.some(t => st.types.has(t))) moreOpen = true;
  const pill = t => { const b = document.createElement("button"); b.type = "button"; b.className = "fchip"; b.textContent = TYPE_LABEL[t] || t; b.title = `${tc.get(t)} picks`; b.setAttribute("aria-pressed", st.types.has(t)); b.onclick = () => { st.types.has(t) ? st.types.delete(t) : st.types.add(t); render(); }; return b; };
  first.forEach(t => box.append(pill(t)));
  if (rest.length){
    const m = document.createElement("button"); m.type = "button"; m.className = "fchip more"; m.setAttribute("aria-expanded", moreOpen);
    m.textContent = moreOpen ? "Less" : `+${rest.length} more`; m.onclick = () => { moreOpen = !moreOpen; renderFilters(); };
    box.append(m);
    if (moreOpen) rest.forEach(t => { const p = pill(t); p.classList.add("pop"); box.append(p); });
  }
  $("clear").hidden = !(st.hosts.size || st.types.size || st.q || st.min > 1);
}
$("clear").onclick = () => { st.hosts.clear(); st.types.clear(); st.q = ""; st.min = 1; $("q").value = ""; $("minpicks").value = "1"; render(); };

render();   // keep last: everything above must be defined first
