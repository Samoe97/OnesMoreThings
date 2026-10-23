"""Test: transcribe the last N minutes of one Triple Click episode with faster-whisper.

Usage (from the project folder; second number = minutes from the end of the episode):
    python scripts/transcribe-test.py            # newest episode
    python scripts/transcribe-test.py 0 35       # newest episode, last 35 minutes
    python scripts/transcribe-test.py 3          # 4th-newest episode
    python scripts/transcribe-test.py 0 cpu      # force CPU

Writes data/transcripts/test-<n>.txt and prints speed so we can size the full run.
"""
import os, re, sys, time, subprocess, urllib.request, html
from pathlib import Path

# --- make the pip-installed NVIDIA libraries visible to CTranslate2 on Windows ---
try:
    import site
    for base in site.getsitepackages() + [site.getusersitepackages()]:
        for sub in ("cublas", "cudnn"):
            d = Path(base) / "nvidia" / sub / "bin"
            if d.is_dir():
                os.add_dll_directory(str(d)); os.environ["PATH"] = str(d) + os.pathsep + os.environ["PATH"]
except Exception:
    pass

FEED = "https://feeds.simplecast.com/6WD3bDj7"
args = [a for a in sys.argv[1:] if a != "cpu"]
idx = int(args[0]) if len(args) > 0 else 0
TAIL_SECONDS = (int(args[1]) if len(args) > 1 else 15) * 60
force_cpu = "cpu" in sys.argv[1:]
root = Path(__file__).resolve().parent.parent
work = root / "data" / "transcripts"; work.mkdir(parents=True, exist_ok=True)

print("Reading feed...")
req = urllib.request.Request(FEED, headers={"User-Agent": "Mozilla/5.0 OnesMoreThings"})
xml = urllib.request.urlopen(req, timeout=60).read().decode("utf8", "replace")
items = re.findall(r"<item>(.*?)</item>", xml, re.S)
it = items[idx]
title = html.unescape(re.search(r"<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</title>", it, re.S).group(1)).strip()
url = html.unescape(re.search(r'<enclosure[^>]*url="([^"]+)"', it).group(1))
print(f"Episode: {title}")

mp3 = work / f"test-{idx}.mp3"; wav = work / f"test-{idx}-{TAIL_SECONDS//60}m.wav"
if not mp3.exists():
    print("Downloading audio..."); 
    urllib.request.urlretrieve(url, mp3)
print(f"Trimming to last {TAIL_SECONDS//60} minutes...")
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-sseof", f"-{TAIL_SECONDS}", "-i", str(mp3),
                "-vn", "-ac", "1", "-ar", "16000", str(wav)], check=True)

from faster_whisper import WhisperModel
device, ctype, model_name = ("cpu", "int8", "small.en") if force_cpu else ("cuda", "float16", "large-v3")
print(f"Loading {model_name} on {device} (first run downloads the model)...")
try:
    model = WhisperModel(model_name, device=device, compute_type=ctype)
except Exception as e:
    print("GPU load failed, falling back to CPU:", e)
    model = WhisperModel("small.en", device="cpu", compute_type="int8")

t0 = time.time()
import numpy as np, wave
with wave.open(str(wav), "rb") as w:   # read the 16 kHz mono wav ourselves so PyAV's version doesn't matter
    audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
segments, info = model.transcribe(audio, language="en", vad_filter=True, beam_size=5)
out = work / f"test-{idx}-{TAIL_SECONDS//60}m.txt"
found = []
with open(out, "w", encoding="utf8") as f:
    f.write(f"{title}\n(last {TAIL_SECONDS//60} min)\n\n")
    for s in segments:
        m, sec = divmod(int(s.start), 60)
        line = f"[{m:02d}:{sec:02d}] {s.text.strip()}"
        f.write(line + "\n"); print(line)
        if re.search(r"one more thing", s.text, re.I): found.append(line)
dt = time.time() - t0
print(f"\nDone in {dt:.0f}s for {TAIL_SECONDS/60:.0f} min of audio ({TAIL_SECONDS/dt:.1f}x real time).")
print("Saved:", out)
print("\nLines mentioning 'one more thing':")
for l in found: print("  ", l)
if not found: print("   (none: the window may not reach the start of the segment)")
