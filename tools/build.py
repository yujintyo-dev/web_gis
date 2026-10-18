#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
data/ フォルダのGeoJSONを自動で読み取り、公開サイト(_site)を作るスクリプト。
GitHub Actions から自動実行されます(手元でも実行できます)。

  python tools/build.py --out _site --cache .cache

- data/ の中の .geojson / .json / .gz / .zip を全部レイヤーとして扱います
- フォルダ名 = カテゴリ。 data/地番図/筆界.geojson.gz → カテゴリ「地番図」、レイヤー名「筆界」
- 大きいデータは自動で「表示範囲だけ読み込む形式」に分割します
- 前回と同じデータ・同じ変換設定なら、変換をスキップします(.cache を再利用)
- 設定は config.json(管理画面で編集)。変換に関わる設定は layers.<id>.build に書きます
- pdf/ フォルダのファイル(ポップアップからダウンロードさせるPDFなど)は、そのまま公開サイトにコピーします
"""
import argparse
import datetime
import gzip
import hashlib
import io
import json
import math
import os
import shutil
import base64
import sys
import tarfile
import unicodedata
import urllib.request
import zipfile
from collections import Counter, OrderedDict, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_tiles as mt  # 分割・結合の共通部品

PALETTE = ["#e8590c", "#1971c2", "#2f9e44", "#9c36b5", "#c2255c", "#0c8599", "#f08c00", "#5c940d", "#6741d9", "#e03131"]
GEOJSON_MAX_FEATURES = 5000       # これ以下かつ小さければ1ファイルのまま配信
GEOJSON_MAX_BYTES = 6 * 1024 * 1024
UNIQUE_LIMIT = 300
NAME_EXT = (".geojson.gz", ".json.gz", ".geojson", ".json", ".zip", ".gz")


def log(*a):
    print(*a, flush=True)


# ---------------- ソース(入力ファイル) ----------------
class Source:
    def __init__(self, id_, path):
        self.id = id_
        self.path = path
        self._sig = None

    def sig(self):
        if self._sig is None:
            h = hashlib.sha1()
            if self.path.startswith("url:"):
                h.update(self.path.encode())
            else:
                with open(self.path, "rb") as fp:
                    for chunk in iter(lambda: fp.read(1 << 20), b""):
                        h.update(chunk)
            self._sig = h.hexdigest()
        return self._sig

    def open_text(self):
        p = self.path
        with open(p, "rb") as fp:
            magic = fp.read(4)
        if magic[:2] == b"\x1f\x8b":
            return io.TextIOWrapper(gzip.open(p, "rb"), encoding="utf-8-sig")
        if magic[:2] == b"PK":
            zf = zipfile.ZipFile(p)
            names = [n for n in zf.namelist() if n.lower().endswith((".geojson", ".json")) and not n.endswith("/")]
            if not names:
                raise RuntimeError("zipの中にGeoJSONが見つかりません")
            w = io.TextIOWrapper(zf.open(names[0]), encoding="utf-8-sig")
            w._zf = zf
            return w
        return open(p, encoding="utf-8-sig")


def strip_ext(name):
    low = name.lower()
    for e in NAME_EXT:
        if low.endswith(e):
            return name[: -len(e)]
    return name


def discover(data_dir):
    srcs = OrderedDict()
    if not os.path.isdir(data_dir):
        return srcs
    for root, dirs, files in os.walk(data_dir):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and not os.path.islink(os.path.join(root, d)))
        for fn in sorted(files):
            if fn.startswith(".") or fn.lower().startswith("readme"):
                continue
            if not fn.lower().endswith(NAME_EXT):
                continue
            if os.path.islink(os.path.join(root, fn)):   # リンク(別の場所のファイルを指すもの)は、意図しない公開を防ぐため使わない
                log("  ! リンクのファイルは使いません:", fn)
                continue
            rel = os.path.relpath(os.path.join(root, fn), data_dir).replace(os.sep, "/")
            id_ = strip_ext(rel)
            if id_ in srcs:
                log("  ! 同じ名前のファイルが複数あります。最初のものを使います:", rel)
                continue
            srcs[id_] = Source(id_, os.path.join(root, fn))
    return srcs


def download(url, cache_dir):
    dl = os.path.join(cache_dir, "dl")
    os.makedirs(dl, exist_ok=True)
    if not url.lower().startswith("https://"):
        raise SystemExit("build.url は https:// で始まるURLだけ使えます: %s" % url)
    path = os.path.join(dl, hashlib.sha1(url.encode()).hexdigest())
    if not os.path.exists(path):
        log("  ダウンロード中:", url)
        tmp = path + ".part"
        req = urllib.request.Request(url, headers={"User-Agent": "gis-build"})
        with urllib.request.urlopen(req, timeout=300) as r, open(tmp, "wb") as out:
            shutil.copyfileobj(r, out, 1 << 20)
        os.replace(tmp, path)
    return path


# ---------------- 読み込み ----------------
def iter_features(src):
    streamed = 0
    with src.open_text() as fp:
        for line in fp:
            s = line.strip()
            if s.startswith("{") and '"Feature"' in s[:40] and '"geometry"' in s:
                if s.endswith(","):
                    s = s[:-1]
                try:
                    f = json.loads(s)
                except ValueError:
                    if streamed > 0:
                        raise RuntimeError("GeoJSONの形式が読み取れません")
                    break
                streamed += 1
                yield f
    if streamed > 0:
        return
    with src.open_text() as fp:
        data = json.load(fp)
    if data.get("type") == "Feature":
        yield data
        return
    for f in data.get("features", []):
        yield f


def scan(src):
    """件数・図形種別・範囲・属性の統計を調べる(1回目の読み込み)"""
    count = 0
    gtypes = Counter()
    box = [1e9, 1e9, -1e9, -1e9]
    fields = OrderedDict()
    for f in iter_features(src):
        g = f.get("geometry")
        if not g or not g.get("coordinates"):
            continue
        count += 1
        gtypes[g["type"]] += 1
        mt.bbox_of(g["coordinates"], box)
        for k, v in (f.get("properties") or {}).items():
            st = fields.get(k)
            if st is None:
                st = fields[k] = {"types": Counter(), "uniq": Counter(), "over": False, "samples": [], "min": None, "max": None}
            if v is None or v == "":
                continue
            st["types"]["number" if isinstance(v, (int, float)) and not isinstance(v, bool) else "string"] += 1
            if len(st["samples"]) < 3 and v not in st["samples"]:
                st["samples"].append(v)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                st["min"] = v if st["min"] is None else min(st["min"], v)
                st["max"] = v if st["max"] is None else max(st["max"], v)
            if not st["over"]:
                st["uniq"][str(v)] += 1
                if len(st["uniq"]) > UNIQUE_LIMIT:
                    st["over"] = True
                    st["uniq"] = Counter()
    out = []
    for k, st in fields.items():
        t = "number" if st["types"]["number"] and not st["types"]["string"] else "string"
        out.append({
            "name": k, "type": t, "samples": st["samples"],
            "unique": None if st["over"] or not st["uniq"] else [[u, c] for u, c in sorted(st["uniq"].items(), key=lambda x: (-x[1], x[0]))],
            "min": st["min"], "max": st["max"],
        })
    return {"count": count, "gtypes": gtypes, "bbox": box, "fields": out}


def geometry_kind(gtypes):
    kinds = set()
    for t in gtypes:
        if "Polygon" in t:
            kinds.add("polygon")
        elif "Line" in t:
            kinds.add("line")
        elif "Point" in t:
            kinds.add("point")
    return kinds.pop() if len(kinds) == 1 else "mixed"


# ---------------- 変換 ----------------
def load_points(src, fields):
    pts = []
    for f in iter_features(src):
        g = f.get("geometry")
        if not g or g["type"] != "Point":
            continue
        pr = f.get("properties") or {}
        pts.append((g["coordinates"][0], g["coordinates"][1], [pr.get(k) for k in fields]))
    return pts


def join_points_to_polygons(feats, points, jf):
    B = 0.002
    grid = defaultdict(list)
    boxes = []
    for i, f in enumerate(feats):
        bx = mt.bbox_of(f["geometry"]["coordinates"])
        boxes.append(bx)
        x0, x1 = int(bx[0] // B), int(bx[2] // B)
        y0, y1 = int(bx[1] // B), int(bx[3] // B)
        if (x1 - x0 + 1) * (y1 - y0 + 1) > 400:
            x1, y1 = x0, y0
        for xx in range(x0, x1 + 1):
            for yy in range(y0, y1 + 1):
                grid[(xx, yy)].append(i)
    matched = 0
    samples = []
    for (x, y, vals) in points:
        for i in grid.get((int(x // B), int(y // B)), ()):
            bx = boxes[i]
            if bx[0] <= x <= bx[2] and bx[1] <= y <= bx[3] and mt.in_geometry(x, y, feats[i]["geometry"]):
                pr = feats[i]["properties"]
                if jf[0] not in pr:
                    for k, v in zip(jf, vals):
                        pr[k] = v
                    matched += 1
                    if len(samples) < 3:
                        samples.append(vals)
                break
    return matched, samples


def write_tiles(feats, outdir, cell, pack_mb):
    tiles = defaultdict(list)
    box = [1e9, 1e9, -1e9, -1e9]
    for f in feats:
        bx = mt.bbox_of(f["geometry"]["coordinates"])
        box[0] = min(box[0], bx[0]); box[1] = min(box[1], bx[1])
        box[2] = max(box[2], bx[2]); box[3] = max(box[3], bx[3])
        cx, cy = (bx[0] + bx[2]) / 2, (bx[1] + bx[3]) / 2
        tiles[(int(math.floor(cx / cell)), int(math.floor(cy / cell)))].append(f)
    w = mt.PackWriter(outdir, int(pack_mb * 1024 * 1024))
    idx = {}
    for key in sorted(tiles):
        pk, off, ln = w.add(mt.dumps(tiles[key]).encode("utf-8"))
        idx["%d_%d" % key] = [pk, off, ln, len(tiles[key])]
    w.close()
    with open(os.path.join(outdir, "index.json"), "w", encoding="utf-8") as fp:
        fp.write(mt.dumps({"version": 1, "type": "tiles", "cell": cell, "bbox": box, "packs": w.packs, "tiles": idx}))
    return len(tiles)


def write_search(feats, outdir, label, group, precision, pack_mb):
    groups = defaultdict(list)
    n = 0
    for f in feats:
        pr = f["properties"]
        if pr.get(label) in (None, ""):
            continue
        c = f["geometry"]["coordinates"]
        if f["geometry"]["type"] != "Point":
            bx = mt.bbox_of(c)
            c = [(bx[0] + bx[2]) / 2, (bx[1] + bx[3]) / 2]
        groups[str(pr.get(group)) if group else "all"].append([str(pr[label]), round(c[0], precision), round(c[1], precision)])
        n += 1
    os.makedirs(outdir, exist_ok=True)
    w = mt.PackWriter(outdir, int(pack_mb * 1024 * 1024))
    shards = {}
    for g in sorted(groups):
        rows = sorted(groups[g], key=lambda r: r[0])
        pk, off, ln = w.add(mt.dumps(rows).encode("utf-8"))
        shards[g] = [pk, off, ln, len(rows)]
    w.close()
    with open(os.path.join(outdir, "index.json"), "w", encoding="utf-8") as fp:
        fp.write(mt.dumps({"version": 1, "type": "shards", "packs": w.packs, "shards": shards}))
    return n


def convert(src, b, all_srcs, outdir):
    """1レイヤーを変換して outdir に書き出し、マニフェスト用の情報を返す"""
    precision = int(b.get("precision", 6))
    keep = b.get("keep") or None
    cell = float(b.get("cell", 0.005))
    pack_mb = float(b.get("packMB", 20))
    info = {}
    log("  調査中…")
    st = scan(src)
    if st["count"] == 0:
        return {"error": "図形のあるデータが見つかりません"}
    bx = st["bbox"]
    if bx[0] < -180 or bx[2] > 180 or bx[1] < -90 or bx[3] > 90:
        return {"error": "座標が緯度経度(EPSG:4326)ではありません。QGISで EPSG:4326 に変換して書き出してください"}
    info.update(count=st["count"], bbox=bx, geometry=geometry_kind(st["gtypes"]))
    src_fields = [f["name"] for f in st["fields"]]
    fields = [f for f in st["fields"] if keep is None or f["name"] in keep]

    # 地番点との結び付け
    jp = None
    jj = b.get("join") or {}
    if jj.get("points"):
        if jj["points"] not in all_srcs:
            return {"error": "結び付ける点データ「%s」が見つかりません" % jj["points"]}
        jf = jj.get("fields") or []
        if not jf:
            return {"error": "join.fields が空です"}
        log("  結び付け用の点を読み込み中…")
        jp = (load_points(all_srcs[jj["points"]], jf), jf)

    log("  変換中… (%d 件)" % st["count"])
    feats = []
    for f in iter_features(src):
        g = f.get("geometry")
        if not g or not g.get("coordinates"):
            continue
        g = mt.clean_geometry(g, precision)
        if g is None:
            continue
        pr = f.get("properties") or {}
        if keep is not None:
            pr = {k: pr.get(k) for k in keep if k in pr}
        feats.append({"type": "Feature", "properties": pr, "geometry": g})

    if jp:
        matched, samples = join_points_to_polygons(feats, jp[0], jp[1])
        log("  地番を結び付け: %d / %d 件" % (matched, len(feats)))
        info["joined"] = matched
        for k_i, k in enumerate(jp[1]):
            fields.append({"name": k, "type": "string", "samples": [s[k_i] for s in samples if s[k_i] not in (None, "")][:3],
                           "unique": None, "min": None, "max": None, "joined": True})

    os.makedirs(outdir, exist_ok=True)
    use_geojson = len(feats) <= GEOJSON_MAX_FEATURES
    if use_geojson:
        data = mt.dumps({"type": "FeatureCollection", "features": feats})
        if len(data.encode("utf-8")) > GEOJSON_MAX_BYTES:
            use_geojson = False
    if use_geojson:
        with open(os.path.join(outdir, "data.geojson"), "w", encoding="utf-8") as fp:
            fp.write(data)
        info["kind"] = "geojson"
        info["file"] = "data.geojson"
    else:
        n = write_tiles(feats, outdir, cell, pack_mb)
        log("  区画数:", n)
        info["kind"] = "tiles"
        info["index"] = "index.json"

    s = b.get("search")
    if s and s.get("label"):
        n = write_search(feats, os.path.join(outdir, "search"), s["label"], s.get("group", ""), precision, pack_mb)
        info["search"] = {"index": "search/index.json"}
        log("  検索用データ: %d 件" % n)

    info["fields"] = fields
    info["sourceFields"] = src_fields
    rows = [f["properties"] for f in feats[:400] if f["properties"]]
    rows.sort(key=lambda p: -len([v for v in p.values() if v not in (None, "")]))
    info["sampleRows"] = rows[:3]
    return info


def dir_size(p):
    return sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(p) for f in fs)


# ---------------- Leaflet(地図ライブラリ)を同梱 ----------------
LEAFLET_VERSION = "1.9.4"


def vendor_leaflet(out, cache):
    """公開サイトが外部サーバーのスクリプトを読み込まなくて済むよう、Leafletを同梱する。
    npm公式レジストリから、バージョンを固定して取得し、公開されているハッシュと照合する。"""
    dl = os.path.join(cache, "dl")
    os.makedirs(dl, exist_ok=True)
    tgz = os.path.join(dl, "leaflet-%s.tgz" % LEAFLET_VERSION)
    if not os.path.exists(tgz):
        log("Leaflet %s を取得中…" % LEAFLET_VERSION)
        last = None
        for _ in range(3):
            try:
                with urllib.request.urlopen("https://registry.npmjs.org/leaflet/%s" % LEAFLET_VERSION, timeout=60) as r:
                    meta = json.load(r)
                tar_url = meta["dist"]["tarball"]
                if not tar_url.startswith("https://registry.npmjs.org/"):
                    raise RuntimeError("想定外の取得先です: " + tar_url)
                with urllib.request.urlopen(tar_url, timeout=120) as r:
                    data = r.read()
                integ = meta["dist"].get("integrity", "")
                if integ.startswith("sha512-"):
                    ok = base64.b64encode(hashlib.sha512(data).digest()).decode() == integ[7:]
                else:
                    ok = hashlib.sha1(data).hexdigest() == meta["dist"].get("shasum")
                if not ok:
                    raise RuntimeError("Leafletのハッシュが一致しません(改ざんまたは破損の可能性)")
                with open(tgz, "wb") as fp:
                    fp.write(data)
                break
            except Exception as e:  # 通信エラーは数回やり直す
                last = e
        else:
            raise SystemExit("Leafletを取得できませんでした: %s" % last)
    dst = os.path.join(out, "vendor", "leaflet")
    os.makedirs(os.path.join(dst, "images"), exist_ok=True)
    want = {"package/dist/leaflet.js": "leaflet.js", "package/dist/leaflet.css": "leaflet.css", "package/LICENSE": "LICENSE"}
    with tarfile.open(tgz) as tf:
        for m in tf.getmembers():
            if not m.isfile():
                continue
            if m.name in want:
                name = want[m.name]
            elif m.name.startswith("package/dist/images/") and "/" not in m.name[len("package/dist/images/"):]:
                name = "images/" + m.name[len("package/dist/images/"):]
            else:
                continue
            with open(os.path.join(dst, name), "wb") as fp:
                fp.write(tf.extractfile(m).read())
    log("Leaflet %s を同梱しました" % LEAFLET_VERSION)


# ---------------- PDF・資料ファイル ----------------
PDF_WARN_MB = 300
# 公開してよい形式だけをコピーする(HTML・SVG・スクリプトなど、ブラウザ内で動く形式は、サイトの乗っ取りに使われ得るため除外)
PDF_EXT = (".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".csv", ".txt", ".zip")


def copy_pdf(src_dir, out):
    """pdf/ フォルダの中身を公開サイトにコピーし、ファイルの一覧(pdf/… の形)を返す。
    Macで作ったファイル名(濁点が分かれた形)でもリンクできるよう、ファイル名をNFCにそろえる。"""
    files = []
    if not os.path.isdir(src_dir):
        return files
    total = 0
    for root, dirs, fns in os.walk(src_dir):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and not os.path.islink(os.path.join(root, d)))
        for fn in sorted(fns):
            if fn.startswith(".") or fn.lower().startswith("readme"):
                continue
            p = os.path.join(root, fn)
            if os.path.islink(p):
                log("  ! リンクのファイルは公開しません:", fn)
                continue
            if not fn.lower().endswith(PDF_EXT):
                log("  ! この形式のファイルは公開しません(使える形式: %s):" % " ".join(PDF_EXT), fn)
                continue
            rel = unicodedata.normalize("NFC", os.path.relpath(p, src_dir).replace(os.sep, "/"))
            dst = os.path.join(out, "pdf", *rel.split("/"))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copyfile(p, dst)
            total += os.path.getsize(p)
            files.append("pdf/" + rel)
    log("PDF・資料: %d 件 (%.1f MB)" % (len(files), total / 1048576))
    if total > PDF_WARN_MB * 1048576:
        log("  ※ pdf フォルダが %d MB を超えています。GitHub Pages は公開サイト全体で 1GB までです" % PDF_WARN_MB)
    return files


# ---------------- メイン ----------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data")
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--out", default="_site")
    ap.add_argument("--cache", default=".cache")
    ap.add_argument("--root", default=".")
    ap.add_argument("--pdf", default="pdf", help="ポップアップからダウンロードさせるPDFなどを置くフォルダ")
    ap.add_argument("--skip-vendor", action="store_true", help="Leafletの同梱を省略(通信できない環境でのテスト用)")
    a = ap.parse_args()

    config = {}
    if os.path.exists(a.config):
        try:
            with open(a.config, encoding="utf-8-sig") as fp:
                config = json.load(fp)
        except ValueError as e:
            sys.exit("config.json の書き方に誤りがあります: %s" % e)
    cl = config.get("layers") or {}

    srcs = discover(a.data)
    for id_, c in cl.items():  # URLから取得するデータ
        u = (c.get("build") or {}).get("url")
        if u and id_ not in srcs:
            srcs[id_] = Source(id_, download(u, a.cache))
    log("レイヤー数:", len(srcs))

    os.makedirs(a.cache, exist_ok=True)
    now = datetime.date.today().isoformat()
    entries = []
    used = set()
    for id_, src in srcs.items():
        b = (cl.get(id_) or {}).get("build") or {}
        b_for_sig = {k: v for k, v in b.items() if k != "url"}
        extra = ""
        if (b.get("join") or {}).get("points") in srcs:
            extra = srcs[b["join"]["points"]].sig()
        sig = hashlib.sha1((src.sig() + json.dumps(b_for_sig, sort_keys=True, ensure_ascii=False) + extra + "v1").encode()).hexdigest()
        h = hashlib.md5(id_.encode("utf-8")).hexdigest()[:10]
        used.add(h)
        cdir = os.path.join(a.cache, h)
        meta_path = os.path.join(cdir, "meta.json")
        meta = None
        if os.path.exists(meta_path):
            try:
                with open(meta_path, encoding="utf-8") as fp:
                    meta = json.load(fp)
            except ValueError:
                meta = None
        log("■", id_)
        if meta and meta.get("sig") == sig:
            log("  変更なし(前回の変換結果を再利用)")
        else:
            if os.path.exists(cdir):
                shutil.rmtree(cdir)
            try:
                info = convert(src, b, srcs, os.path.join(cdir, "out"))
            except Exception as e:  # 1つのレイヤーが壊れていても他は公開する
                info = {"error": "変換に失敗しました: %s" % e}
            os.makedirs(cdir, exist_ok=True)
            info["updated"] = now
            meta = {"sig": sig, "info": info}
            with open(meta_path, "w", encoding="utf-8") as fp:
                json.dump(meta, fp, ensure_ascii=False)
            if info.get("error"):
                log("  ✗", info["error"])
        info = meta["info"]
        hidden = bool((cl.get(id_) or {}).get("hidden"))   # 管理画面の「サイトに出さない(非公開)」
        parts = id_.split("/")
        entry = {
            "id": id_, "name": parts[-1], "category": "/".join(parts[:-1]),
            "hash": h, "updated": info.get("updated"),
            "autoColor": PALETTE[int(h, 16) % len(PALETTE)],
        }
        jj = b.get("join") or {}
        if jj.get("points") and jj.get("fields"):   # どの点レイヤーのどの属性を取り込んだか(ポップアップ設定の引き継ぎに使う)
            entry["joinFrom"] = {"points": jj["points"], "fields": list(jj["fields"])}
        entry["keepAll"] = not b.get("keep")   # 属性を絞り込んでいない(元データの全属性を公開)
        if info.get("error"):
            entry["error"] = info["error"]
        else:
            base = "generated/%s/" % h
            entry.update({k: info[k] for k in ("kind", "geometry", "count", "bbox", "fields", "sourceFields", "sampleRows") if k in info})
            if info.get("joined") is not None:
                entry["joined"] = info["joined"]
            if entry["keepAll"] and info.get("sourceFields"):
                log("  ※ [%s] 元データの全属性(%d個)を公開します。build.keep で絞り込めます(管理画面の「データ変換」)" % (id_, len(info["sourceFields"])))
            if hidden:
                # 非公開: データ本体・検索データ・サンプル値を公開サイトに入れない(属性名だけ残す。管理画面の設定用)
                entry["unpublished"] = True
                entry.pop("sampleRows", None)
                entry["fields"] = [{"name": f.get("name"), "type": f.get("type"), "joined": f.get("joined")} for f in entry.get("fields") or []]
                log("  非公開のため、公開サイトにデータを入れません")
            elif "file" in info:
                entry["file"] = base + info["file"]
            if "index" in info and not hidden:
                entry["index"] = base + info["index"]
            if "search" in info and not hidden:
                entry["search"] = {"index": base + info["search"]["index"]}
            k = entry["kind"]
            g = entry["geometry"]
            entry["suggest"] = {"minZoom": 0 if k == "geojson" else {"polygon": 16, "line": 15}.get(g, 17)}
        entries.append(entry)

    # サイト出力
    if os.path.exists(a.out):
        shutil.rmtree(a.out)
    os.makedirs(os.path.join(a.out, "generated"))
    for e in entries:
        if "error" in e or e.get("unpublished"):
            continue
        shutil.copytree(os.path.join(a.cache, e["hash"], "out"), os.path.join(a.out, "generated", e["hash"]))
    for fn in os.listdir(a.cache):  # 使われなくなった変換結果を掃除
        p = os.path.join(a.cache, fn)
        if fn != "dl" and fn not in used and os.path.isdir(p):
            shutil.rmtree(p)
    pdf_files = copy_pdf(a.pdf, a.out)
    with open(os.path.join(a.out, "manifest.json"), "w", encoding="utf-8") as fp:
        json.dump({"version": 1, "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                   "layers": entries, "pdfFiles": pdf_files}, fp, ensure_ascii=False)
    for fn in ("index.html", "admin.html", "terms.html"):
        p = os.path.join(a.root, fn)
        if os.path.exists(p):
            shutil.copy(p, a.out)
    for d in ("css", "js"):
        p = os.path.join(a.root, d)
        if os.path.isdir(p):
            shutil.copytree(p, os.path.join(a.out, d))
    if a.skip_vendor:
        log("※ Leafletを同梱していません(--skip-vendor)。公開用には付けないでください")
    else:
        vendor_leaflet(a.out, a.cache)
    if os.path.exists(a.config):
        shutil.copy(a.config, os.path.join(a.out, "config.json"))
    else:
        with open(os.path.join(a.out, "config.json"), "w", encoding="utf-8") as fp:
            fp.write("{}")
    open(os.path.join(a.out, ".nojekyll"), "w").close()
    log("完了: レイヤー %d / 出力 %.1f MB -> %s" % (len(entries), dir_size(a.out) / 1048576, a.out))
    errs = [e for e in entries if "error" in e]
    for e in errs:
        log("  ※ 公開されないレイヤー:", e["id"], "-", e["error"])


if __name__ == "__main__":
    main()
