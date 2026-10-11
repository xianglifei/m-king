#!/usr/bin/env python3
"""
麦门制霸图 · 真实数据桥接脚本（零依赖，Python 3.9+）
------------------------------------------------------------
从麦当劳中国官方 MCP 拉取：
  1. 门店清单（网格扫描，反推每家店的相对坐标）
  2. 你的历史订单 → 已征服城邦（visits）

产出：
  data/stores.json   全部门店（含估算坐标与精度标记）
  data/visits.json   已征服列表（累积档案，可重复运行合并）

用法：
  export MCD_MCP_TOKEN=你的Token      # 与 WorkBuddy mcp.json 中 mcd-mcp 相同
  python3 tools/fetch_mcd_data.py                  # 北京默认范围
  python3 tools/fetch_mcd_data.py --sanitize       # 生成脱敏版（公开分享用）
  python3 tools/fetch_mcd_data.py --bbox 39.4,40.2,116.0,116.8 --step 0.04

Token 获取优先级：--token 参数 > 环境变量 MCD_MCP_TOKEN > ~/.workbuddy/mcp.json。

⚠ 注意：
  - 历史订单接口只返回最近约 10 单；visits.json 是累积档案，换号或清档前备份。
  - 请遵守麦当劳 MCP 服务规则，脚本已内置调用间隔（--sleep 可调大，勿调过小）。
  - 门店坐标为 MCP 返回信息反推的估算值（accuracy 字段标注精度），供游戏化呈现，
    不保证精确到门牌。
"""
import argparse
import json
import math
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

MCP_URL = os.environ.get("MCD_MCP_URL", "https://mcp.mcd.cn")

# 北京默认扫描范围（覆盖全部远郊）
DEFAULT_BBOX = (39.30, 40.75, 115.30, 117.50)

# 用于从门店名推断区县的 fallback 关键词
DISTRICT_KEYS = [
    ("朝阳", ["朝阳", "国贸", "三里屯", "望京", "亚运村", "酒仙桥", "双井", "劲松", "潘家园", "东坝", "常营", "管庄", "北苑", "来广营", "青年路", "十里堡", "团结湖", "和平街"]),
    ("海淀", ["海淀", "中关村", "五道口", "上地", "西二旗", "学院路", "魏公村", "公主坟", "万柳", "清河", "西三旗", "苏州街", "知春路", "五棵松", "温泉", "西北旺", "世纪城"]),
    ("丰台", ["丰台", "六里桥", "丽泽", "宋家庄", "方庄", "马家堡", "大红门", "木樨园", "角门", "科技园"]),
    ("西城", ["西城", "西单", "金融街", "复兴门", "阜成门", "德胜门", "新街口", "广安门", "月坛", "什刹海"]),
    ("东城", ["东城", "王府井", "东单", "雍和宫", "前门", "崇文门", "东直门", "和平里", "天坛", "安定门"]),
    ("通州", ["通州", "果园", "梨园", "九棵树", "北关", "宋庄", "张家湾", "万达广场"]),
    ("大兴", ["大兴", "西红门", "黄村", "天宫院", "旧宫", "瀛海", "庞各庄", "生物医药"]),
    ("昌平", ["昌平", "回龙观", "天通苑", "沙河", "南邵", "阳坊", "北七家", "十三陵"]),
    ("顺义", ["顺义", "后沙峪", "空港", "首都机场"]),
    ("石景山", ["石景山", "苹果园", "八角", "古城"]),
    ("房山", ["房山", "良乡", "长阳", "窦店", "燕山"]),
    ("门头沟", ["门头沟", "双峪", "永定"]),
    ("亦庄", ["亦庄", "荣京东街", "科创"]),
    ("密云", ["密云"]),
    ("怀柔", ["怀柔", "雁栖"]),
    ("平谷", ["平谷"]),
    ("延庆", ["延庆"]),
]
REMOTE = {"密云", "怀柔", "平谷", "延庆", "门头沟", "房山"}

TIER3_KEYS = ("旗舰", "旗舰店")
TIER1_KEYS = ("得来速", "DT", "社区", "便利店", "驿站")
TIER2_KEYS = ("商场", "广场", "中心", "大悦城", "万达", "购物", "港湾", "SOHO", "银泰", "龙湖", "凯德", "吾悦", "爱琴海")


def resolve_token(cli_token):
    if cli_token:
        return cli_token.strip()
    if os.environ.get("MCD_MCP_TOKEN", "").strip():
        return os.environ["MCD_MCP_TOKEN"].strip()
    wb = Path.home() / ".workbuddy" / "mcp.json"
    try:
        cfg = json.loads(wb.read_text())
        auth = ((cfg.get("mcpServers") or {}).get("mcd-mcp") or {}).get("headers", {}).get("Authorization", "")
        return re.sub(r"(?i)^Bearer\s+", "", auth).strip() or None
    except Exception:
        return None


class McpClient:
    """与仓库 lib/mcp.js 同款姿势：JSON-RPC over HTTP，兼容 JSON/SSE 响应。"""

    def __init__(self, token, timeout=30):
        self.token = token
        self.timeout = timeout
        self.seq = 0

    def rpc(self, method, params):
        self.seq += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self.seq, "method": method, "params": params}).encode()
        req = urllib.request.Request(MCP_URL, data=body, headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": "Bearer " + self.token,
        })
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            text = r.read().decode("utf-8", "replace")
        t = text.strip()
        if not t:
            raise RuntimeError("空响应")
        if t[0] in "{[":
            obj = json.loads(t)
        else:
            obj = None
            for line in t.splitlines():
                if line.startswith("data:"):
                    p = line[5:].strip()
                    if p and p != "[DONE]":
                        try:
                            obj = json.loads(p)
                            break
                        except Exception:
                            pass
            if obj is None:
                raise RuntimeError("无法解析响应: " + t[:160])
        if obj.get("error"):
            raise RuntimeError(f"MCP错误 {obj['error'].get('code')} {obj['error'].get('message')}")
        return obj["result"]

    def extract(self, result):
        if not result:
            return None
        if result.get("structuredContent") is not None:
            return result["structuredContent"]
        for c in result.get("content") or []:
            if c.get("type") == "text":
                m = re.search(r"## Original Response\s*\n([\s\S]*)$", c["text"])
                body = m.group(1) if m else c["text"]
                try:
                    return json.loads(body)
                except Exception:
                    return {"_text": body}
        return None

    def call(self, name, args):
        r = self.rpc("tools/call", {"name": name, "arguments": args})
        data = self.extract(r)
        if isinstance(data, dict) and data.get("success") is False:
            raise RuntimeError(f"{name}: {data.get('message')} ({data.get('code')})")
        return data


def guess_latlng_args(schema):
    props = (schema or {}).get("properties") or {}
    lat = next((k for k in props if k.lower() in ("latitude", "lat", "userlat", "userlatitude")), None)
    lng = next((k for k in props if k.lower() in ("longitude", "lng", "lon", "userlng", "userlongitude")), None)
    return lat, lng


def pick_distance(store):
    for k in ("distance", "jl", "dist", "distanceMeter", "distanceM"):
        if k in store:
            try:
                return float(store[k])
            except (TypeError, ValueError):
                pass
    return None


def trilaterate(samples):
    """samples: [(lat, lng, dist_m), ...]
    圆交线性化最小二乘：|p-o_i|²=d_i² 两两相减消去 p·p 项，解 2x2 正规方程。"""
    if len(samples) < 3:
        return None
    lat_ref = sum(s[0] for s in samples) / len(samples)
    lng_ref = sum(s[1] for s in samples) / len(samples)
    kx = 111320 * math.cos(math.radians(lat_ref))
    ky = 110540
    o = [((lng - lng_ref) * kx, (lat - lat_ref) * ky) for lat, lng, _ in samples]
    d = [s[2] for s in samples]
    ox0, oy0 = o[0]
    r0 = ox0 * ox0 + oy0 * oy0
    rows, rhs = [], []
    for (ox, oy), di in zip(o[1:], d[1:]):
        rows.append([2 * (ox - ox0), 2 * (oy - oy0)])
        rhs.append((ox * ox + oy * oy - r0) - (di * di - d[0] * d[0]))
    a11 = sum(r[0] * r[0] for r in rows); a12 = sum(r[0] * r[1] for r in rows)
    a22 = sum(r[1] * r[1] for r in rows)
    b1 = sum(r[0] * v for r, v in zip(rows, rhs)); b2 = sum(r[1] * v for r, v in zip(rows, rhs))
    det = a11 * a22 - a12 * a12
    if abs(det) < 1e-6:
        return None
    px = (b1 * a22 - b2 * a12) / det
    py = (a11 * b2 - a12 * b1) / det
    if not (math.isfinite(px) and math.isfinite(py)) or math.hypot(px, py) > 80000:
        return None
    return lat_ref + py / ky, lng_ref + px / kx


def short_name(name):
    n = name or ""
    n = re.sub(r"^麦当劳", "", n)
    n = n.strip("（）()")
    n = re.sub(r"^北京", "", n)
    n = re.sub(r"餐厅$|店$", "", n)
    return n[:12] or (name or "")


def infer_district(name):
    for d, keys in DISTRICT_KEYS:
        if any(k in name for k in keys):
            return d
    return "未知"


def infer_tier(name):
    if any(k in name for k in TIER3_KEYS):
        return 3
    if any(k in name for k in TIER2_KEYS):
        return 2
    if any(k in name for k in TIER1_KEYS):
        return 1
    return 2


def norm_name(n):
    return re.sub(r"\s+", "", n or "").replace("（", "(").replace("）", ")")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--token", default=None)
    ap.add_argument("--bbox", default=",".join(map(str, DEFAULT_BBOX)), help="lat0,lat1,lng0,lng1")
    ap.add_argument("--step", type=float, default=0.06, help="网格步长（度），0.06≈6.6km")
    ap.add_argument("--sleep", type=float, default=0.8, help="相邻调用间隔秒数")
    ap.add_argument("--city", default="北京")
    ap.add_argument("--sanitize", action="store_true", help="门店名脱敏（公开分享前务必）")
    ap.add_argument("--out-dir", default=str(Path(__file__).resolve().parent.parent / "data"))
    args = ap.parse_args()

    token = resolve_token(args.token)
    if not token:
        sys.exit("未找到 Token：请 export MCD_MCP_TOKEN=... 或传 --token（与 WorkBuddy mcp.json 中 mcd-mcp 一致）")

    client = McpClient(token)
    print("① 读取工具清单 ...")
    tools = client.rpc("tools/list", {}).get("tools", [])
    names = [t["name"] for t in tools]
    print(f"   共 {len(names)} 个工具")
    if "query-nearby-stores" not in names:
        sys.exit("MCP 中未找到 query-nearby-stores，工具清单: " + ", ".join(names))
    schema = next(t for t in tools if t["name"] == "query-nearby-stores").get("inputSchema")
    lat_arg, lng_arg = guess_latlng_args(schema)
    grid_mode = bool(lat_arg and lng_arg)
    print(f"   门店坐标模式: {'网格扫描（' + lat_arg + '/' + lng_arg + '）' if grid_mode else '城市关键词搜索（接口不支持坐标入参）'}")

    # ---------- 拉门店 ----------
    stores_by_key = {}
    samples = {}  # key -> [(lat,lng,dist)]
    bbox = tuple(float(x) for x in args.bbox.split(","))
    lat0, lat1, lng0, lng1 = bbox

    def collect(items, origin):
        for st in items or []:
            code = st.get("storeCode") or st.get("storeName")
            if not code:
                continue
            key = norm_name(str(code))
            if key not in stores_by_key:
                stores_by_key[key] = st
            d = pick_distance(st)
            if d is not None and origin:
                samples.setdefault(key, []).append((origin[0], origin[1], d))

    if grid_mode:
        lat = lat0
        total = math.ceil((lat1 - lat0) / args.step) * math.ceil((lng1 - lng0) / args.step)
        done = 0
        while lat <= lat1:
            lng = lng0
            while lng <= lng1:
                done += 1
                try:
                    data = client.call("query-nearby-stores", {"beType": 1, "searchType": 1, lat_arg: round(lat, 5), lng_arg: round(lng, 5)})
                    collect(data if isinstance(data, list) else (data or {}).get("list") or (data or {}).get("stores") or [], (lat, lng))
                except Exception as e:
                    print(f"   [{done}/{total}] {lat:.3f},{lng:.3f} 失败: {e}")
                else:
                    print(f"\r   [{done}/{total}] 已收录 {len(stores_by_key)} 家门店", end="", flush=True)
                time.sleep(args.sleep)
                lng += args.step
            lat += args.step
        print()
    else:
        keywords = [args.city] + [k for d, ks in DISTRICT_KEYS for k in ks[:3]]
        seen_kw = set()
        for kw in keywords:
            if kw in seen_kw:
                continue
            seen_kw.add(kw)
            try:
                data = client.call("query-nearby-stores", {"beType": 1, "searchType": 2, "city": args.city, "keyword": "麦当劳(" + kw})
                collect(data if isinstance(data, list) else (data or {}).get("list") or (data or {}).get("stores") or [], None)
                print(f"   关键词「{kw}」已收录 {len(stores_by_key)} 家")
            except Exception as e:
                print(f"   关键词「{kw}」失败: {e}")
            time.sleep(args.sleep)

    # ---------- 组装 stores ----------
    out_stores = []
    sid = 0
    alias = {}
    for key, st in sorted(stores_by_key.items(), key=lambda kv: str(kv[1].get("storeName"))):
        name = str(st.get("storeName") or key)
        # 坐标：距离三边定位 > 首次出现网格点 > 未知
        tri = trilaterate(samples.get(key, [])) if samples.get(key) else None
        if tri:
            lat_s, lng_s = tri
            accuracy = "trilaterated"
        elif grid_mode and key in samples and samples[key]:
            lat_s, lng_s = samples[key][0][0], samples[key][0][1]
            accuracy = "grid-cell"
        elif st.get("latitude") and st.get("longitude"):
            lat_s, lng_s = float(st["latitude"]), float(st["longitude"])
            accuracy = "exact"
        else:
            lat_s = lng_s = None
            accuracy = "unknown"
        district = infer_district(name)
        sid += 1
        sid_str = f"ST{sid:03d}"
        alias[name] = sid_str
        out_stores.append({
            "id": sid_str,
            "name": name,
            "shortName": short_name(name),
            "district": district,
            "districtTitle": (district + "郡") if district != "未知" else "未知之地",
            "lat": round(lat_s, 5) if lat_s is not None else None,
            "lng": round(lng_s, 5) if lng_s is not None else None,
            "tier": infer_tier(name),
            "remote": district in REMOTE,
            "open24h": bool(st.get("open24h") or st.get("is24h")),
            "accuracy": accuracy,
            "storeCode": st.get("storeCode"),
        })

    # 未知坐标的店：塞到其郡已知店附近或地图边缘（地图可画，标注精度低）
    withpos = [s for s in out_stores if s["lat"] is not None]
    if withpos:
        for i, s in enumerate(out_stores):
            if s["lat"] is None:
                same = [p for p in withpos if p["district"] == s["district"]] or withpos
                base = same[i % len(same)]
                s["lat"] = round(base["lat"] + 0.004 * ((i % 5) - 2), 5)
                s["lng"] = round(base["lng"] + 0.005 * ((i % 3) - 1), 5)

    # ---------- 拉订单 → visits ----------
    print("② 拉取历史订单 ...")
    visits = []
    try:
        data = client.call("order-list", {})
        orders = (data or {}).get("list") if isinstance(data, dict) else data
        orders = orders or []
        code_by_name = {norm_name(str(st.get("storeName") or "")): str(st.get("storeCode") or "") for st in stores_by_key.values()}
        for o in orders:
            sname = norm_name(str(o.get("storeName") or ""))
            date = (str(o.get("createTime") or "") or "")[:10]
            code = str(o.get("storeCode") or "") or code_by_name.get(sname, "")
            matched = None
            for key, st in stores_by_key.items():
                if code and str(st.get("storeCode") or "") == code:
                    matched = key
                    break
            if matched is None:
                matched = sname if sname in stores_by_key else None
            if matched is None:
                # 订单门店不在扫描结果里（已闭店/范围外）：单独成点
                sid += 1
                nm = str(o.get("storeName") or "未知门店")
                out_stores.append({
                    "id": f"ST{sid:03d}", "name": nm, "shortName": short_name(nm),
                    "district": infer_district(nm),
                    "districtTitle": (infer_district(nm) + "郡") if infer_district(nm) != "未知" else "未知之地",
                    "lat": None, "lng": None, "tier": infer_tier(nm), "remote": infer_district(nm) in REMOTE,
                    "open24h": False, "accuracy": "order-only", "storeCode": o.get("storeCode"),
                })
                withpos.append(out_stores[-1])
                matched = norm_name(nm)
                stores_by_key[matched] = {"storeName": nm}
            vid = next(s["id"] for s in out_stores if s["name"] == (stores_by_key.get(matched, {}).get("storeName") or matched))
            if not any(v["storeId"] == vid for v in visits):
                visits.append({"storeId": vid, "date": date or ""})
        print(f"   订单 {len(orders)} 笔 → 征服 {len(visits)} 家门店")
    except Exception as e:
        print(f"   订单拉取失败（不影响门店清单）: {e}")

    # ---------- 脱敏 ----------
    if args.sanitize:
        letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        mapping = {}
        for i, s in enumerate(sorted(out_stores, key=lambda x: x["name"])):
            mapping[s["name"]] = f"示例门店{letters[i % 26]}{'' if i < 26 else i // 26 + 1}"
        for s in out_stores:
            s["name"] = mapping[s["name"]]
            s["shortName"] = s["name"].replace("示例门店", "")
            s["storeCode"] = None
        for s in out_stores:
            s["district"] = "示例"
            s["districtTitle"] = "示例郡"
            s["remote"] = False
        print("   已脱敏：门店名/区县/storeCode 全部替换")

    # ---------- 写文件 ----------
    outdir = Path(args.out_dir)
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / "stores.json").write_text(json.dumps(
        {"city": args.city, "generated": "real", "stores": out_stores}, ensure_ascii=False, indent=1), encoding="utf-8")
    vpath = outdir / "visits.json"
    merged = []
    if vpath.exists():
        try:
            merged = json.loads(vpath.read_text())
        except Exception:
            merged = []
    by_id = {v["storeId"]: v for v in merged}
    for v in visits:
        if v["storeId"] not in by_id or (v["date"] and (not by_id[v["storeId"]].get("date") or v["date"] < by_id[v["storeId"]]["date"])):
            by_id[v["storeId"]] = v
    vpath.write_text(json.dumps(list(by_id.values()), ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"③ 完成：{len(out_stores)} 家门店（坐标精度 trilaterated/grid-cell/exact/order-only 见 accuracy 字段）")
    print(f"   {outdir/'stores.json'}  +  {vpath}（已合并历史）")
    print("   刷新 kingdom/index.html 即见你的真实王国。公开分享前请加 --sanitize 重新生成。")


if __name__ == "__main__":
    main()
