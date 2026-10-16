#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
大きなGeoJSONを「表示範囲だけ読み込める形」に変換するスクリプト(Python標準ライブラリのみ)

使い方(コマンドプロンプト/ターミナルで実行):

  # 1) 面・線・点データを分割する(例: 筆界)
  python make_tiles.py tiles 入力.geojson 出力フォルダ --keep FUDEID

  # 筆界に、地番点データの「地番(label)・大字コード(oazacd)」を結び付ける場合
  python make_tiles.py tiles 筆界.geojson 出力フォルダ --keep FUDEID \
         --join-points 地番点.geojson --join-fields label,oazacd

  # 2) 地番検索用データを作る(大字ごとに分割)
  python make_tiles.py search 地番点.geojson 出力フォルダ --label label --group oazacd

オプション:
  --cell 0.005      分割する区画の大きさ(度)。0.005 ≒ 約450m×550m
  --precision 6     座標の小数桁数(6桁≒11cm)。小さいほど軽い
  --keep a,b,c      残す属性(省略すると全部残す)
  --pack-mb 20      1ファイルの最大サイズ(MB)。GitHubのWeb画面からアップロードする場合は25以下に
"""
import argparse
import json
import math
import os
import sys
from collections import defaultdict


# ---------- 入力 ----------
def iter_features(path):
    """QGIS形式(1行1地物)なら1行ずつ読む=省メモリ。それ以外は丸ごと読む。"""
    streamed = 0
    with open(path, encoding="utf-8") as fp:
        for line in fp:
            s = line.strip()
            if s.startswith("{") and '"Feature"' in s[:40] and '"geometry"' in s:
                if s.endswith(","):
                    s = s[:-1]
                try:
                    yield json.loads(s)
                    streamed += 1
                except ValueError:
                    streamed = -1
                    break
    if streamed > 0:
        return
    with open(path, encoding="utf-8") as fp:
        data = json.load(fp)
    for f in data.get("features", []):
        yield f


# ---------- 座標処理 ----------
def round_coords(c, p):
    if isinstance(c[0], (int, float)):
        return [round(c[0], p), round(c[1], p)]
    return [round_coords(x, p) for x in c]


def clean_ring(ring):
    out = []
    for pt in ring:
        if not out or pt != out[-1]:
            out.append(pt)
    return out


def clean_geometry(g, p):
    """丸めた結果、同じ点が続く部分を取り除く。つぶれた図形は None。"""
    t = g["type"]
    c = round_coords(g["coordinates"], p)
    if t == "Point":
        return {"type": t, "coordinates": c}
    if t == "LineString":
        c = clean_ring(c)
        return {"type": t, "coordinates": c} if len(c) >= 2 else None
    if t == "MultiLineString":
        c = [r for r in (clean_ring(r) for r in c) if len(r) >= 2]
        return {"type": t, "coordinates": c} if c else None
    if t == "Polygon":
        rings = [r for r in (clean_ring(r) for r in c) if len(r) >= 4]
        return {"type": t, "coordinates": rings} if rings else None
    if t == "MultiPolygon":
        polys = []
        for poly in c:
            rings = [r for r in (clean_ring(r) for r in poly) if len(r) >= 4]
            if rings:
                polys.append(rings)
        return {"type": t, "coordinates": polys} if polys else None
    return {"type": t, "coordinates": c}


def bbox_of(coords, box=None):
    if box is None:
        box = [1e9, 1e9, -1e9, -1e9]
    if isinstance(coords[0], (int, float)):
        x, y = coords[0], coords[1]
        if x < box[0]: box[0] = x
        if y < box[1]: box[1] = y
        if x > box[2]: box[2] = x
        if y > box[3]: box[3] = y
    else:
        for c in coords:
            bbox_of(c, box)
    return box


# ---------- 点in多角形 ----------
def in_ring(x, y, ring):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def in_polygon(x, y, rings):
    if not in_ring(x, y, rings[0]):
        return False
    for h in rings[1:]:
        if in_ring(x, y, h):
            return False
    return True


def in_geometry(x, y, g):
    if g["type"] == "Polygon":
        return in_polygon(x, y, g["coordinates"])
    if g["type"] == "MultiPolygon":
        return any(in_polygon(x, y, p) for p in g["coordinates"])
    return False


# ---------- パック書き出し ----------
class PackWriter:
    def __init__(self, outdir, max_bytes):
        self.outdir = outdir
        self.max = max_bytes
        self.packs = []
        self.cur = None
        self.cur_size = 0
        os.makedirs(outdir, exist_ok=True)
        for fn in os.listdir(outdir):
            if fn.startswith("pack-") and fn.endswith(".bin"):
                os.remove(os.path.join(outdir, fn))

    def _open(self):
        name = "pack-%d.bin" % len(self.packs)
        self.packs.append(name)
        self.cur = open(os.path.join(self.outdir, name), "wb")
        self.cur_size = 0

    def add(self, data):
        if self.cur is None or (self.cur_size + len(data) > self.max and self.cur_size > 0):
            if self.cur:
                self.cur.close()
            self._open()
        off = self.cur_size
        self.cur.write(data)
        self.cur_size += len(data)
        return len(self.packs) - 1, off, len(data)

    def close(self):
        if self.cur:
            self.cur.close()


def dumps(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


# ---------- tiles ----------
def cmd_tiles(a):
    p = a.precision
    keep = [k for k in a.keep.split(",") if k] if a.keep else None
    cell = a.cell

    # 結び付け用の地番点を読み込む
    points = []
    jf = [k for k in a.join_fields.split(",") if k] if a.join_fields else []
    if a.join_points:
        print("地番点を読み込み中:", a.join_points)
        for f in iter_features(a.join_points):
            g = f.get("geometry")
            if not g or g["type"] != "Point":
                continue
            pr = f.get("properties") or {}
            points.append((g["coordinates"][0], g["coordinates"][1], [pr.get(k) for k in jf]))
        print("  点:", len(points))

    print("図形を読み込み中:", a.input)
    feats = []
    skipped = 0
    for f in iter_features(a.input):
        g = f.get("geometry")
        if not g:
            skipped += 1
            continue
        g = clean_geometry(g, p)
        if g is None:
            skipped += 1
            continue
        pr = f.get("properties") or {}
        if keep is not None:
            pr = {k: pr.get(k) for k in keep if k in pr}
        feats.append({"type": "Feature", "properties": pr, "geometry": g})
        if len(feats) % 50000 == 0:
            print("  ", len(feats))
    print("  図形:", len(feats), "(除外:", skipped, ")")

    # 地番点との結び付け
    if points:
        print("地番を筆界に結び付け中…")
        B = 0.002
        grid = defaultdict(list)
        boxes = []
        for i, f in enumerate(feats):
            bx = bbox_of(f["geometry"]["coordinates"])
            boxes.append(bx)
            x0, x1 = int(bx[0] // B), int(bx[2] // B)
            y0, y1 = int(bx[1] // B), int(bx[3] // B)
            if (x1 - x0 + 1) * (y1 - y0 + 1) > 400:
                x1, y1 = x0, y0  # 巨大図形は左下の区画だけ(まれ)
            for xx in range(x0, x1 + 1):
                for yy in range(y0, y1 + 1):
                    grid[(xx, yy)].append(i)
        matched = 0
        for (x, y, vals) in points:
            for i in grid.get((int(x // B), int(y // B)), ()):
                bx = boxes[i]
                if bx[0] <= x <= bx[2] and bx[1] <= y <= bx[3] and in_geometry(x, y, feats[i]["geometry"]):
                    pr = feats[i]["properties"]
                    if jf and jf[0] not in pr:
                        for k, v in zip(jf, vals):
                            pr[k] = v
                        matched += 1
                    break
        print("  結び付いた筆: %d / %d  (点 %d 件中)" % (matched, len(feats), len(points)))
        del grid, boxes, points

    # 区画ごとに振り分け(区画は図形の外接矩形の中心で決める)
    print("区画に分割中…")
    tiles = defaultdict(list)
    box = [1e9, 1e9, -1e9, -1e9]
    for f in feats:
        bx = bbox_of(f["geometry"]["coordinates"])
        for i in range(4):
            box[i] = min(box[i], bx[i]) if i < 2 else max(box[i], bx[i])
        cx, cy = (bx[0] + bx[2]) / 2, (bx[1] + bx[3]) / 2
        tiles[(int(math.floor(cx / cell)), int(math.floor(cy / cell)))].append(f)
    del feats

    w = PackWriter(a.outdir, int(a.pack_mb * 1024 * 1024))
    index_tiles = {}
    for key in sorted(tiles):
        data = dumps(tiles[key]).encode("utf-8")
        pk, off, ln = w.add(data)
        index_tiles["%d_%d" % key] = [pk, off, ln, len(tiles[key])]
    w.close()
    index = {"version": 1, "type": "tiles", "cell": cell, "bbox": box,
             "packs": w.packs, "tiles": index_tiles}
    with open(os.path.join(a.outdir, "index.json"), "w", encoding="utf-8") as fp:
        fp.write(dumps(index))
    total = sum(os.path.getsize(os.path.join(a.outdir, n)) for n in w.packs)
    print("完了: 区画 %d / パック %d 個 / 合計 %.1f MB -> %s" % (len(tiles), len(w.packs), total / 1048576, a.outdir))


# ---------- search ----------
def cmd_search(a):
    p = a.precision
    groups = defaultdict(list)
    n = 0
    for f in iter_features(a.input):
        g = f.get("geometry")
        pr = f.get("properties") or {}
        if not g or pr.get(a.label) in (None, ""):
            continue
        c = g["coordinates"]
        if g["type"] != "Point":
            bx = bbox_of(c)
            c = [(bx[0] + bx[2]) / 2, (bx[1] + bx[3]) / 2]
        grp = str(pr.get(a.group)) if a.group else "all"
        groups[grp].append([str(pr[a.label]), round(c[0], p), round(c[1], p)])
        n += 1
    w = PackWriter(a.outdir, int(a.pack_mb * 1024 * 1024))
    shards = {}
    for grp in sorted(groups):
        rows = sorted(groups[grp], key=lambda r: r[0])
        pk, off, ln = w.add(dumps(rows).encode("utf-8"))
        shards[grp] = [pk, off, ln, len(rows)]
    w.close()
    index = {"version": 1, "type": "shards", "packs": w.packs, "shards": shards}
    with open(os.path.join(a.outdir, "index.json"), "w", encoding="utf-8") as fp:
        fp.write(dumps(index))
    total = sum(os.path.getsize(os.path.join(a.outdir, nm)) for nm in w.packs)
    print("完了: %d 件 / グループ %d / %.1f MB -> %s" % (n, len(groups), total / 1048576, a.outdir))


def main():
    ap = argparse.ArgumentParser(description="GeoJSON分割ツール")
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("tiles")
    t.add_argument("input"); t.add_argument("outdir")
    t.add_argument("--cell", type=float, default=0.005)
    t.add_argument("--precision", type=int, default=6)
    t.add_argument("--keep", default="")
    t.add_argument("--pack-mb", type=float, default=20)
    t.add_argument("--join-points", default="")
    t.add_argument("--join-fields", default="")
    t.set_defaults(fn=cmd_tiles)
    s = sub.add_parser("search")
    s.add_argument("input"); s.add_argument("outdir")
    s.add_argument("--label", required=True)
    s.add_argument("--group", default="")
    s.add_argument("--precision", type=int, default=6)
    s.add_argument("--pack-mb", type=float, default=20)
    s.set_defaults(fn=cmd_search)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
