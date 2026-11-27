"""搜尋 YouTube、下載影片、自動挑出動感大的 5~10 秒片段並切出來。

用法（在 repo 根目錄）：
  python .claude/skills/clip-hunt/hunt.py search --out samples/<代號> -q "<人名> 演唱會" -q "<人名> 激動"
  python .claude/skills/clip-hunt/hunt.py fetch  --out samples/<代號> [--ids=id1,id2,...]
  python .claude/skills/clip-hunt/hunt.py clips  --out samples/<代號> [--min 5 --max 10 --per-video 4]
  python .claude/skills/clip-hunt/hunt.py all    --out samples/<代號> -q ...

資料夾：
  <out>/candidates.tsv  搜尋結果（id / 秒數 / 標題 / 用哪個關鍵字找到）
  <out>/raw/            下載的原始影片  {id}_{標題}.mp4
  <out>/clips/          切好的片段     {名次}_{id}_{開始秒}s_{分數}.mp4
  <out>/clips/index.tsv 片段清單（來源、起點、長度、分數、動態、音量、標題）
"""
from __future__ import annotations

import argparse
import csv
import glob
import json
import os
import shutil
import subprocess
import sys

import cv2
import numpy as np

FPS = 10            # 分析用的取樣率
FACE_FPS = 2        # 人臉偵測的取樣率（FPS 要能被它整除）
SIM = 0.4           # SFace 餘弦相似度 ≥ 這個值視為同一人
_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
YUNET = os.path.join(_ROOT, "public", "models", "face_detection_yunet_2023mar.onnx")
SFACE = os.path.join(_ROOT, "public", "models", "face_recognition_sface_2021dec_int8.onnx")
W, H = 64, 36       # 分析用的縮圖大小
CUT_DIFF = 0.16     # 相鄰兩格差異超過這個值視為鏡頭切換

YTDLP = shutil.which("yt-dlp") or "yt-dlp"
FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- search

def cmd_search(args):
    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, "candidates.tsv")
    seen: dict[str, list[str]] = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for row in csv.reader(f, delimiter="\t"):
                if row and row[0] != "id":
                    seen[row[0]] = row
    added = 0
    for q in args.query:
        log(f"搜尋：{q}")
        out = subprocess.run(
            [YTDLP, f"ytsearch{args.per_query}:{q}", "--flat-playlist", "--encoding", "utf-8",
             "--print", "%(id)s\t%(duration)s\t%(title)s"],
            capture_output=True).stdout.decode("utf-8", "replace")
        for line in out.splitlines():
            parts = line.split("\t", 2)
            if len(parts) < 3:
                continue
            vid, dur, title = parts
            try:
                d = float(dur)
            except ValueError:
                continue  # 直播 / 沒有長度
            if d < args.min_dur or d > args.max_dur or vid in seen:
                continue
            seen[vid] = [vid, str(int(d)), title.replace("\t", " "), q]
            added += 1
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, delimiter="\t")
        w.writerow(["id", "duration", "title", "query"])
        w.writerows(seen.values())
    log(f"新增 {added} 部，共 {len(seen)} 部 → {path}")
    for row in seen.values():
        print("\t".join(row))


# ---------------------------------------------------------------- fetch

def read_candidates(out):
    path = os.path.join(out, "candidates.tsv")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return [r for r in csv.DictReader(f, delimiter="\t")]


def cmd_fetch(args):
    raw = os.path.join(args.out, "raw")
    os.makedirs(raw, exist_ok=True)
    ids = [s for s in (args.ids or "").replace(" ", ",").split(",") if s] \
        or [r["id"] for r in read_candidates(args.out)]
    for i, vid in enumerate(ids, 1):
        if glob.glob(os.path.join(raw, glob.escape(vid) + "_*.mp4")):
            continue
        log(f"[{i}/{len(ids)}] 下載 {vid}")
        subprocess.run([
            YTDLP, f"https://www.youtube.com/watch?v={vid}", "--no-playlist", "--encoding", "utf-8",
            "-f", f"bv*[height<={args.height}][vcodec^=avc1]+ba[ext=m4a]/bv*[height<={args.height}]+ba/b",
            "--merge-output-format", "mp4", "--no-mtime", "-q", "--no-warnings",
            "-o", os.path.join(raw, "%(id)s_%(title).60B.%(ext)s"),
        ])


# ---------------------------------------------------------------- analyse

def probe(path):
    out = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height:format=duration", "-of", "json", path],
                         capture_output=True).stdout
    j = json.loads(out or b"{}")
    s = (j.get("streams") or [{}])[0]
    return s.get("width", 0), s.get("height", 0), float(j.get("format", {}).get("duration", 0))


def motion_curve(path):
    """每 1/FPS 秒一個值：相鄰縮圖的平均差異（0~1），以及鏡頭切換的位置。"""
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", path, "-an", "-vf",
                          f"fps={FPS},scale={W}:{H},format=gray", "-f", "rawvideo", "-"],
                         capture_output=True).stdout
    frames = np.frombuffer(raw, np.uint8)
    n = len(frames) // (W * H)
    if n < 2:
        return np.zeros(0), np.zeros(0, bool)
    f = frames[: n * W * H].reshape(n, H, W).astype(np.float32) / 255
    d = np.abs(np.diff(f, axis=0)).mean(axis=(1, 2))
    d = np.concatenate([[d[0]], d])
    cuts = d > CUT_DIFF
    m = d.copy()
    m[cuts] = np.median(d)          # 切換本身不算動態
    return m, cuts


def loud_curve(path, n):
    """每 1/FPS 秒的音量（0~1，-50dB→0、-10dB→1）。"""
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "8000",
                          "-f", "s16le", "-"], capture_output=True).stdout
    a = np.frombuffer(raw, np.int16).astype(np.float32) / 32768
    hop = 8000 // FPS
    k = min(n, len(a) // hop)
    out = np.zeros(n)
    if k:
        rms = np.sqrt((a[: k * hop].reshape(k, hop) ** 2).mean(axis=1) + 1e-10)
        out[:k] = np.clip((20 * np.log10(rms) + 50) / 40, 0, 1)
    return out


def face_pass(path, cache):
    """每秒 FACE_FPS 格，偵測所有人臉。回傳 dict(t, size, feat)：時間、臉高 / 畫面高、SFace 特徵（已正規化）。"""
    if os.path.exists(cache):
        z = np.load(cache)
        return {k: z[k] for k in z.files}
    w, h, _ = probe(path)
    sw = 640
    sh = int(round(h * sw / w / 2) * 2)
    det = cv2.FaceDetectorYN.create(YUNET, "", (sw, sh), 0.8)
    rec = cv2.FaceRecognizerSF.create(SFACE, "")
    p = subprocess.Popen([FFMPEG, "-v", "error", "-i", path, "-an", "-vf", f"fps={FACE_FPS},scale={sw}:{sh}",
                          "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], stdout=subprocess.PIPE)
    ts, sizes, feats = [], [], []
    k = 0
    while True:
        buf = p.stdout.read(sw * sh * 3)
        if len(buf) < sw * sh * 3:
            break
        frame = np.frombuffer(buf, np.uint8).reshape(sh, sw, 3)
        _, faces = det.detect(frame)
        for f in faces if faces is not None else []:
            if f[3] / sh < 0.05:
                continue
            v = rec.feature(rec.alignCrop(frame, f)).flatten()
            ts.append(k / FACE_FPS); sizes.append(f[3] / sh); feats.append(v / (np.linalg.norm(v) + 1e-9))
        k += 1
    p.wait()
    out = dict(t=np.array(ts, np.float32), size=np.array(sizes, np.float32),
               feat=np.array(feats, np.float32).reshape(-1, 128), n=np.array(k))
    np.savez(cache, **out)
    return out


def ref_from_images(paths):
    rec = cv2.FaceRecognizerSF.create(SFACE, "")
    feats = []
    for p in paths:
        img = cv2.imdecode(np.fromfile(p, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            continue
        det = cv2.FaceDetectorYN.create(YUNET, "", (img.shape[1], img.shape[0]), 0.8)
        _, faces = det.detect(img)
        if faces is None:
            log(f"參考圖沒有偵測到臉：{p}")
            continue
        f = max(faces, key=lambda f: f[2] * f[3])
        v = rec.feature(rec.alignCrop(img, f)).flatten()
        feats.append(v / np.linalg.norm(v))
    if not feats:
        sys.exit("參考圖裡都找不到臉")
    m = np.mean(feats, axis=0)
    return m / np.linalg.norm(m)


def ref_auto(faces_by_vid):
    """沒給參考圖時：找「在最多部影片裡都出現」的那張臉，當作主角。"""
    pool_f, pool_v = [], []
    for vi, fc in enumerate(faces_by_vid.values()):
        big = np.argsort(-fc["size"])[:80]           # 每部取最大的 80 張臉
        pool_f.append(fc["feat"][big]); pool_v += [vi] * len(big)
    F = np.concatenate(pool_f)
    V = np.array(pool_v)
    if not len(F):
        sys.exit("所有影片都沒有偵測到臉")
    S = F @ F.T
    nv = V.max() + 1
    spread = [len(np.unique(V[S[i] > SIM])) for i in range(len(F))]
    seed = int(np.argmax(spread))
    ref = F[seed]
    for _ in range(3):                               # 用相似的臉平均，穩定一點
        m = F[F @ ref > SIM].mean(axis=0)
        ref = m / np.linalg.norm(m)
    log(f"自動判定主角：出現在 {spread[seed]}/{nv} 部影片")
    return ref


def ref_sheet(ref, faces_by_vid, files_by_vid, out_path):
    """把每部影片裡最像主角的一張臉拼成一張圖，給人確認主角有沒有認錯。"""
    tiles = []
    for vid, fc in faces_by_vid.items():
        if not len(fc["t"]):
            continue
        sim = fc["feat"] @ ref
        i = int(np.argmax(sim * (fc["size"] > 0.1)))
        if sim[i] < SIM:
            continue
        raw = subprocess.run([FFMPEG, "-v", "error", "-ss", f"{fc['t'][i]:.2f}", "-i", files_by_vid[vid],
                              "-frames:v", "1", "-vf", "scale=-2:180", "-f", "image2pipe", "-vcodec", "png", "-"],
                             capture_output=True).stdout
        img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR) if raw else None
        if img is not None:
            tiles.append(cv2.resize(img, (320, 180)))
        if len(tiles) >= 24:
            break
    if not tiles:
        return
    while len(tiles) % 6:
        tiles.append(np.zeros_like(tiles[0]))
    rows = [np.hstack(tiles[i: i + 6]) for i in range(0, len(tiles), 6)]
    cv2.imencode(".jpg", np.vstack(rows))[1].tofile(out_path)


def presence(fc, ref, n, min_face):
    """每個分析格（1/FPS 秒）主角是否清楚出現，以及臉的大小。"""
    ok = np.zeros(n, bool)
    size = np.zeros(n, np.float32)
    if len(fc["t"]):
        hit = (fc["feat"] @ ref > SIM) & (fc["size"] >= min_face)
        for t, s in zip(fc["t"][hit], fc["size"][hit]):
            a = int(t * FPS)
            b = min(n, a + FPS // FACE_FPS)
            ok[a:b] = True
            size[a:b] = np.maximum(size[a:b], s)
    return ok, size


def best_windows(score, cuts, ok, lo, hi, skip, want, allow_cuts, need):
    """在不跨鏡頭、主角出現比例 ≥ need 的範圍內，找分數最高、互不重疊的窗口。
    回傳 [(start, length, mean)]（單位：格）。"""
    n = len(score)
    edges = [0] + ([] if allow_cuts else [i for i in np.nonzero(cuts)[0] if i > 0]) + [n]
    cs = np.concatenate([[0], np.cumsum(score)])
    co = np.concatenate([[0], np.cumsum(ok)])
    cands = []
    for a, b in zip(edges[:-1], edges[1:]):
        a = max(a, skip)
        b = min(b, n - FPS)  # 結尾一秒常是片尾
        if b - a < lo:
            continue
        for L in range(lo, min(hi, b - a) + 1, FPS // 2):
            s = np.arange(a, b - L + 1, FPS // 2)
            s = s[(co[s + L] - co[s]) / L >= need]
            means = (cs[s + L] - cs[s]) / L
            bonus = 1 + 0.03 * (L - lo) / FPS     # 分數差不多時偏好長一點
            cands += [(float(m * bonus), int(st), L, float(m)) for st, m in zip(s, means)]
    cands.sort(reverse=True)
    taken, used = [], np.zeros(n, bool)
    for _, st, L, m in cands:
        if used[st: st + L].any():
            continue
        taken.append((st, L, m))
        used[max(0, st - FPS): st + L + FPS] = True   # 前後各留一秒
        if len(taken) >= want:
            break
    return taken


def cmd_clips(args):
    raw = os.path.join(args.out, "raw")
    clips = os.path.join(args.out, "clips")
    os.makedirs(clips, exist_ok=True)
    cache = os.path.join(args.out, "cache")
    os.makedirs(cache, exist_ok=True)
    titles = {r["id"]: r["title"] for r in read_candidates(args.out)}
    lo, hi = int(args.min * FPS), int(args.max * FPS)

    files = {}
    for path in sorted(glob.glob(os.path.join(raw, "*.mp4"))):
        w, h, _ = probe(path)
        if args.landscape and h > w:
            log(f"略過直式 {os.path.basename(path)}")
            continue
        files[os.path.basename(path)[:11]] = path

    faces = {}
    for i, (vid, path) in enumerate(files.items(), 1):
        log(f"[{i}/{len(files)}] 人臉 {os.path.basename(path)}")
        faces[vid] = face_pass(path, os.path.join(cache, vid + "_face.npz"))
    ref = ref_from_images(args.ref) if args.ref else ref_auto(faces)
    sheet = os.path.join(args.out, "ref.jpg")
    ref_sheet(ref, faces, files, sheet)
    log(f"主角確認圖 → {sheet}")

    found = []
    for i, (vid, path) in enumerate(files.items(), 1):
        name = os.path.basename(path)
        mc = os.path.join(cache, vid + "_ml.npz")
        if os.path.exists(mc):
            z = np.load(mc); m, cuts, loud = z["m"], z["cuts"], z["loud"]
        else:
            log(f"[{i}/{len(files)}] 動態 {name}")
            m, cuts = motion_curve(path)
            loud = loud_curve(path, len(m))
            np.savez(mc, m=m, cuts=cuts, loud=loud)
        if len(m) < lo:
            continue
        ok, fsize = presence(faces[vid], ref, len(m), args.min_face)
        # 動態為主、音量（喊叫、歡呼）為輔，臉越大越加分；動態 0.05 左右就算很大
        mot = np.clip(m / 0.05, 0, 1.5)
        score = 0.55 * mot + 0.3 * loud + 0.15 * np.clip(fsize / 0.3, 0, 1)
        for st, L, mean in best_windows(score, cuts, ok, lo, hi, int(args.skip_head * FPS),
                                        args.per_video, args.allow_cuts, args.presence):
            found.append(dict(src=path, id=vid, start=st / FPS, dur=L / FPS, score=mean,
                              motion=float(m[st: st + L].mean()), loud=float(loud[st: st + L].mean()),
                              face=float(ok[st: st + L].mean()),
                              title=titles.get(vid, name[12:-4])))
    found.sort(key=lambda c: -c["score"])
    found = [c for c in found if c["score"] >= args.threshold][: args.limit]
    for old in glob.glob(os.path.join(clips, "*.mp4")):
        os.remove(old)
    for rank, c in enumerate(found, 1):
        c["file"] = f"{rank:02d}_{c['id']}_{int(c['start'])}s_{c['score']:.2f}.mp4"
        log(f"切 {c['file']}  ({c['dur']:.1f}s)")
        subprocess.run([FFMPEG, "-v", "error", "-y", "-ss", f"{c['start']:.2f}", "-i", c["src"],
                        "-t", f"{c['dur']:.2f}", "-c:v", "libx264", "-preset", "medium", "-crf", "21",
                        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
                        os.path.join(clips, c["file"])])
    with open(os.path.join(clips, "index.tsv"), "w", encoding="utf-8", newline="") as f:
        wr = csv.writer(f, delimiter="\t")
        wr.writerow(["file", "start", "dur", "score", "motion", "loud", "face", "url", "title"])
        for c in found:
            wr.writerow([c["file"], f"{c['start']:.1f}", f"{c['dur']:.1f}", f"{c['score']:.2f}",
                         f"{c['motion']:.3f}", f"{c['loud']:.2f}", f"{c['face']:.2f}",
                         f"https://youtu.be/{c['id']}?t={int(c['start'])}", c["title"]])
    log(f"共 {len(found)} 段 → {clips}")
    for c in found:
        print(f"{c['file']}\t{c['dur']:.1f}s\t{c['title']}")


# ---------------------------------------------------------------- main

def main():
    for s in (sys.stdout, sys.stderr):
        s.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--out", required=True, help="輸出資料夾，例如 samples/<代號>")

    def search_args(sp):
        sp.add_argument("-q", "--query", action="append", required=True)
        sp.add_argument("--per-query", type=int, default=10)
        sp.add_argument("--min-dur", type=float, default=15)
        sp.add_argument("--max-dur", type=float, default=900, help="太長的（整場直播）跳過")

    def fetch_args(sp):
        sp.add_argument("--ids", help="逗號分隔；id 可能以 - 開頭，所以寫成 --ids=a,b,c")
        sp.add_argument("--height", type=int, default=720)

    def clip_args(sp):
        sp.add_argument("--min", type=float, default=5)
        sp.add_argument("--max", type=float, default=10)
        sp.add_argument("--per-video", type=int, default=4)
        sp.add_argument("--limit", type=int, default=60)
        sp.add_argument("--threshold", type=float, default=0.45)
        sp.add_argument("--skip-head", type=float, default=3, help="略過開頭幾秒（片頭）")
        sp.add_argument("--allow-cuts", action="store_true", help="允許片段跨鏡頭切換")
        sp.add_argument("--portrait", dest="landscape", action="store_false", help="也收直式影片")
        sp.add_argument("--ref", nargs="*", help="主角照片（不給就自動判定：出現在最多部影片裡的臉）")
        sp.add_argument("--min-face", type=float, default=0.16, help="臉高至少佔畫面高的比例")
        sp.add_argument("--presence", type=float, default=0.9, help="片段中主角清楚出現的時間比例")

    search_args(sub.add_parser("search", parents=[common]))
    fetch_args(sub.add_parser("fetch", parents=[common]))
    clip_args(sub.add_parser("clips", parents=[common]))
    a = sub.add_parser("all", parents=[common])
    search_args(a); fetch_args(a); clip_args(a)
    args = p.parse_args()
    if args.cmd in ("search", "all"):
        cmd_search(args)
    if args.cmd in ("fetch", "all"):
        cmd_fetch(args)
    if args.cmd in ("clips", "all"):
        cmd_clips(args)


if __name__ == "__main__":
    main()
