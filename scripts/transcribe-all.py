"""Transcribe the "One More Thing" end of every Triple Click episode (local, GPU).

For each episode it works backwards from the end of the audio in chunks until it has
heard the host say "we are back for/with one more thing" plus a little lead-in, then
saves the timestamped transcript of that tail to data/transcripts/<number> - <title>.json.

    python scripts/transcribe-all.py --limit 5     # try the 5 newest episodes first
    python scripts/transcribe-all.py               # everything (resumable: skips finished ones)
    python scripts/transcribe-all.py --force       # redo episodes that already have a file

Episodes where the phrase was never found are listed in data/transcripts/_review.txt.
"""
import os, re, sys, json, time, html, subprocess, urllib.request, argparse
from pathlib import Path

try:  # make pip-installed NVIDIA libraries visible on Windows
    import site
    for base in site.getsitepackages() + [site.getusersitepackages()]:
        for sub in ("cublas", "cudnn"):
            d = Path(base) / "nvidia" / sub / "bin"
            if d.is_dir():
                os.add_dll_directory(str(d)); os.environ["PATH"] = str(d) + os.pathsep + os.environ["PATH"]
except Exception:
    pass

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
FEED = "https://feeds.simplecast.com/6WD3bDj7"
SR = 16000
# Anchors: the line before the ad break ("...come back for one more thing") or after it ("we are back for one more thing",
# "it is time for one more thing"). Picks: any line where a host introduces their own pick.
ANCHOR = re.compile(r"\b(?:(?:we(?:'ll| will)? be|we(?:'re| are)|come|coming|and we(?:'re| are)) back,? (?:for|with|to|in time for) (?:the )?one more thing|time for (?:the )?one more thing)", re.I)
PICK = re.compile(r"\b(?:my|your|her|his|their|what's your|what is your) (?:very )?one more thing\b|\bone more thing (?:is|this week)\b", re.I)
PROMPT = "Triple Click, a games podcast with Kirk Hamilton, Jason Schreier, and Maddy Myers."  # never include the phrase itself: Whisper echoes prompts

ap = argparse.ArgumentParser()
ap.add_argument("--limit", type=int, default=0)
ap.add_argument("--force", action="store_true")
ap.add_argument("--first-chunk", type=int, default=30, help="minutes transcribed first")
ap.add_argument("--chunk", type=int, default=10, help="minutes added each step back")
ap.add_argument("--max-tail", type=int, default=75, help="never go further back than this many minutes")
ap.add_argument("--lead-in", type=int, default=45, help="seconds of audio wanted before the phrase")
ap.add_argument("--cpu", action="store_true")
args = ap.parse_args()

root = Path(__file__).resolve().parent.parent
out_dir = root / "data" / "transcripts"; out_dir.mkdir(parents=True, exist_ok=True)

def fetch(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 OnesMoreThings"})
            return urllib.request.urlopen(req, timeout=120)
        except Exception as e:
            if i == tries - 1: raise
            time.sleep(3 * (i + 1))

def tag(it, name):
    m = re.search(rf"<{name}[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</{name}>", it, re.S)
    return html.unescape(m.group(1)).strip() if m else ""

print("Reading feed...")
xml = fetch(FEED).read().decode("utf8", "replace")
episodes = []
items = re.findall(r"<item>(.*?)</item>", xml, re.S)
for pos_i, it in enumerate(items):
    enc = re.search(r'<enclosure[^>]*url="([^"]+)"', it)
    guid = tag(it, "guid")
    if enc and guid:
        num = tag(it, "itunes:episode")
        # use the feed's own episode number when it has one, else count from the oldest episode (1)
        number = int(num) if num.isdigit() else len(items) - pos_i
        episodes.append({"guid": guid, "number": number, "title": tag(it, "title"), "date": tag(it, "pubDate"), "url": html.unescape(enc.group(1))})
print(f"{len(episodes)} episodes in feed.")
if args.limit: episodes = episodes[:args.limit]

import numpy as np
from faster_whisper import WhisperModel
try:
    from faster_whisper import BatchedInferencePipeline
except Exception:
    BatchedInferencePipeline = None
if args.cpu: model = WhisperModel("small.en", device="cpu", compute_type="int8")
else:
    try: model = WhisperModel("large-v3", device="cuda", compute_type="float16")
    except Exception as e:
        print("GPU unavailable, using CPU:", e); model = WhisperModel("small.en", device="cpu", compute_type="int8")
batched = BatchedInferencePipeline(model=model) if BatchedInferencePipeline and not args.cpu else None

def transcribe(audio):
    kw = dict(language="en", initial_prompt=PROMPT, beam_size=5)
    if batched:
        try:
            segs, _ = batched.transcribe(audio, batch_size=8, **kw)
            return list(segs)
        except Exception as e:
            print("  (batched mode failed, using normal mode:", e, ")")
    segs, _ = model.transcribe(audio, vad_filter=True, condition_on_previous_text=False, **kw)
    return list(segs)

def decode_all(path):
    p = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"],
                       stdout=subprocess.PIPE, check=True)
    return np.frombuffer(p.stdout, dtype=np.int16)

def times(segs, rx):
    """Start times of segments where rx matches (a phrase may run into the next segment)."""
    out = []
    for i, s in enumerate(segs):
        txt = s["text"].replace("\u2019", "'")
        joined = txt + " " + (segs[i + 1]["text"].replace("\u2019", "'") if i + 1 < len(segs) else "")
        m = rx.search(joined)
        if m and m.start() < len(txt): out.append(s["start"])
    return out

def find_phrase(segs, total):
    """(first anchor time, first pick-intro time). Either may be None."""
    a = times(segs, ANCHOR)
    p = [t for t in times(segs, PICK) if t >= total - 2400]   # picks are always in the last 40 min; ignores "my one more thing last year..." asides
    return (a[0] if a else None), (p[0] if p else None)

def file_name(ep):
    title = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", ep["title"]).replace("\u2019", "'")
    title = re.sub(r"\s+", " ", title).strip(" .")[:80].strip(" .")
    return f"{ep['number']:04d} - {title}.json"

# files already written (including older ones named by guid): guid -> path
existing = {}
for p in out_dir.glob("*.json"):
    try: existing[json.loads(p.read_text(encoding="utf8"))["guid"]] = p
    except Exception: pass

review = []
for n, ep in enumerate(episodes, 1):
    dest = out_dir / file_name(ep)
    old_path = existing.get(ep["guid"])
    if old_path and not args.force:
        if old_path != dest:                      # rename earlier guid-named files to the new scheme
            if dest.exists(): dest.unlink()
            old_path.rename(dest); existing[ep["guid"]] = dest
            print(f"[{n}/{len(episodes)}] renamed -> {dest.name}")
        continue
    t0 = time.time()
    print(f"[{n}/{len(episodes)}] {ep['title']}")
    mp3 = out_dir / "_tmp.mp3"
    try:
        with fetch(ep["url"]) as r, open(mp3, "wb") as f:
            while True:
                b = r.read(1 << 20)
                if not b: break
                f.write(b)
        pcm = decode_all(mp3)
    except Exception as e:
        print("  download/decode failed:", e); review.append(f"{ep['title']} -- download failed: {e}"); continue
    finally:
        try: mp3.unlink()
        except Exception: pass
    total = len(pcm) / SR
    segs, pos, size = [], total, args.first_chunk * 60
    while True:
        start = max(0.0, pos - size)
        audio = pcm[int(start * SR):int(pos * SR)].astype(np.float32) / 32768.0
        chunk = [{"start": round(start + s.start, 2), "end": round(start + s.end, 2), "text": s.text.strip()} for s in transcribe(audio)]
        segs = chunk + segs
        anchor, pick = find_phrase(segs, total)
        covered = total - start
        if anchor is not None and anchor - start >= args.lead_in: break      # heard the break/return line, with lead-in
        if anchor is None and pick is not None and pick - start >= 600 and covered >= 2400: break  # no anchor heard: 10 min before the first pick intro, at least 40 min back
        if start <= 0 or covered >= args.max_tail * 60: break
        pos, size = start, args.chunk * 60
    anchor, pick = find_phrase(segs, total)
    hit, strict = (anchor, True) if anchor is not None else (pick, False)
    data = {"guid": ep["guid"], "episode": ep["number"], "title": ep["title"], "date": ep["date"], "duration": round(total, 1),
            "tailStart": round(total - covered, 1), "phraseAt": hit, "phraseStrict": strict, "anchorAt": anchor, "firstPickAt": pick, "segments": segs}
    dest.write_text(json.dumps(data, ensure_ascii=False), encoding="utf8")
    if old_path and old_path != dest and old_path.exists(): old_path.unlink()   # replaced an older-named file
    existing[ep["guid"]] = dest
    seg_len = f"{(total - hit)/60:.1f} min before the end" if hit is not None else "NOT FOUND"
    print(f"  done in {time.time()-t0:.0f}s; transcribed last {covered/60:.0f} min; segment starts {seg_len}")
    if hit is None or not strict:
        review.append(f"{ep['title']} -- {'no one-more-thing intro found' if hit is None else 'no break/return line heard (used first pick intro)'} ({dest.name})")

if review:
    with open(out_dir / "_review.txt", "a", encoding="utf8") as f:
        f.write("\n".join(review) + "\n")
    print(f"\n{len(review)} episode(s) need a look: data/transcripts/_review.txt")
print("All done.")
