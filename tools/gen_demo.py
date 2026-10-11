#!/usr/bin/env python3
"""
麦门制霸图 · 演示数据生成器
------------------------------------------------------------
生成一份"北京麦当劳王国"的确定性演示数据（固定随机种子，可复现），
写入 ../data-demo.js（内联到页面，file:// 双击即可玩）。

演示数据与真实数据 (data/stores.json + data/visits.json) 结构完全一致，
真实数据请用 fetch_mcd_data.py 从麦当劳 MCP 拉取。

注意：演示门店为按真实区县分布规律合成的虚构门店，不代表任何真实门店。
"""
import json
import math
import random
from pathlib import Path

SEED = 42
random.seed(SEED)

# 北京各区：名称（游戏内称"郡"）、区中心经纬度（近似）、门店数权重
DISTRICTS = [
    # name,      lat,    lng,    n   郡号(显示名)
    ("朝阳", 39.921, 116.485, 24, "朝阳郡"),
    ("海淀", 39.965, 116.300, 20, "海淀郡"),
    ("丰台", 39.845, 116.260, 11, "丰台郡"),
    ("西城", 39.912, 116.355, 8,  "西城郡"),
    ("东城", 39.925, 116.425, 7,  "东城郡"),
    ("通州", 39.905, 116.660, 7,  "通州郡"),
    ("大兴", 39.735, 116.340, 7,  "大兴郡"),
    ("昌平", 40.220, 116.230, 7,  "昌平郡"),
    ("顺义", 40.130, 116.655, 4,  "顺义郡"),
    ("石景山", 39.910, 116.198, 3, "石景山郡"),
    ("房山", 39.720, 116.140, 4,  "房山郡"),
    ("门头沟", 39.940, 116.105, 2, "门头沟郡"),
    ("亦庄", 39.790, 116.505, 3,  "亦庄郡"),
    ("密云", 40.365, 116.840, 2,  "密云郡"),
    ("怀柔", 40.320, 116.630, 2,  "怀柔郡"),
    ("平谷", 40.145, 117.115, 1,  "平谷郡"),
    ("延庆", 40.460, 115.970, 1,  "延庆郡"),
]

# 远郊郡（征服有"开疆"加成）
REMOTE = {"密云", "怀柔", "平谷", "延庆", "门头沟", "房山"}

# 各区地标池（虚构组合，仅取地名意象）
LANDMARKS = {
    "朝阳": ["国贸", "三里屯", "望京", "CBD万达", "朝阳大悦城", "蓝色港湾", "团结湖", "双井",
             "酒仙桥", "亚运村", "奥林匹克公园", "朝阳公园", "十里堡", "管庄", "常营", "北苑",
             "来广营", "青年路", "潘家园", "劲松", "东坝", "金盏", "崔各庄", "孙河"],
    "海淀": ["五道口", "中关村", "西二旗", "上地", "学院路", "魏公村", "公主坟", "世纪金源",
            "万柳", "清河", "西三旗", "田村", "四季青", "北太平庄", "苏州街", "知春路",
            "五棵松", "万寿路", "温泉", "西北旺"],
    "丰台": ["六里桥", "丽泽", "宋家庄", "方庄", "马家堡", "大红门", "五里店", "科技园区",
            "角门", "木樨园", "云岗"],
    "西城": ["西单", "金融街", "复兴门", "阜成门", "德胜门", "新街口", "广安门", "月坛"],
    "东城": ["王府井", "东单", "雍和宫", "前门", "崇文门", "东直门", "和平里", "天坛东"],
    "通州": ["万达广场", "果园", "梨园", "九棵树", "北关", "宋庄", "张家湾"],
    "大兴": ["西红门", "黄村", "天宫院", "生物医药基地", "旧宫", "瀛海", "庞各庄"],
    "昌平": ["回龙观", "天通苑", "沙河", "南邵", "十三陵景区", "阳坊", "北七家"],
    "顺义": ["首都机场T3", "后沙峪", "顺义城区", "空港"],
    "石景山": ["苹果园", "八角游乐园", "古城"],
    "房山": ["良乡", "长阳", "窦店", "燕山"],
    "门头沟": ["双峪", "永定"],
    "亦庄": ["亦庄中心", "荣京东街", "科创五街"],
    "密云": ["密云城区", "鼓楼"],
    "怀柔": ["怀柔城区", "雁栖湖"],
    "平谷": ["平谷城区"],
    "延庆": ["延庆城区"],
}

SUFFIX_TIER2 = ["餐厅", "店"]
TIER2_HINTS = ("万达", "大悦城", "广场", "中心", "港湾", "SOHO", "景区", "T3", "王府井", "西单", "国贸", "中关村", "三里屯")


def make_store(sid, district, lm, idx):
    # 门店坐标：围绕区中心散布（近郊收得紧，远郊撒得开）
    spread = 0.055 if district in REMOTE or district in ("昌平", "顺义", "通州", "大兴", "房山") else 0.035
    lat = DIST_LAT[district] + random.gauss(0, spread)
    lng = DIST_LNG[district] + random.gauss(0, spread * 1.25)

    name = f"麦当劳(北京{lm}餐厅)"
    # 等级：地标权重高的做王都/城镇
    if lm in ("国贸", "三里屯", "王府井", "西单", "中关村", "五道口", "首都机场T3", "望京", "金融街", "CBD万达", "崇文门"):
        tier = 3  # 王都（旗舰）
        name = f"麦当劳(北京{lm}旗舰店)"
    elif any(h in lm for h in TIER2_HINTS) or idx % 3 == 0:
        tier = 2  # 城镇
    else:
        tier = 1  # 哨站
    if tier == 1 and idx % 5 == 4:
        name = f"麦当劳(北京{lm}得来速餐厅)"  # DT 店一律哨站

    return {
        "id": sid,
        "name": name,
        "shortName": lm,
        "district": district,
        "districtTitle": DIST_TITLE[district],
        "lat": round(lat, 5),
        "lng": round(lng, 5),
        "tier": tier,
        "remote": district in REMOTE,
        "open24h": tier == 1 and idx % 7 == 2,
    }


DIST_LAT = {d[0]: d[1] for d in DISTRICTS}
DIST_LNG = {d[0]: d[2] for d in DISTRICTS}
DIST_TITLE = {d[0]: d[4] for d in DISTRICTS}

stores = []
sid = 1
for name, lat, lng, n, title in DISTRICTS:
    pool = LANDMARKS[name][:]
    random.shuffle(pool)
    for k in range(n):
        lm = pool[k % len(pool)] + ("" if k < len(pool) else f"·{k // len(pool) + 1}")
        stores.append(make_store(f"BJ{sid:03d}", name, lm, sid))
        sid += 1

# 演示"已征服"：集中在海淀/朝阳/东西城，加一个远郊彩蛋
conquer_pool = [s for s in stores if s["district"] in ("海淀", "朝阳", "西城", "东城") and s["tier"] >= 2]
random.shuffle(conquer_pool)
picked = conquer_pool[:16]
remote_stores = [s for s in stores if s["remote"]]
if remote_stores:
    picked.append(random.choice(remote_stores))

months = ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04",
          "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]
visits = []
for i, s in enumerate(picked):
    m = months[i % len(months)]
    # 最近一个月日期不超过 10 日，避免演示数据出现"未来"日期
    day = random.randint(1, 10) if m == "2026-10" else random.randint(10, 27)
    visits.append({"storeId": s["id"], "date": f"{m}-{day:02d}"})
visits.sort(key=lambda v: v["date"])

out = {"city": "北京", "generated": "demo", "stores": stores, "visits": visits}
dst = Path(__file__).resolve().parent.parent / "data-demo.js"
dst.write_text(
    "/* 自动生成（tools/gen_demo.py，种子 42）：北京演示数据，虚构门店仅作示意 */\n"
    "window.MC_KINGDOM_DEMO = " + json.dumps(out, ensure_ascii=False, indent=1) + ";\n",
    encoding="utf-8",
)
print(f"stores={len(stores)} visits={len(visits)} -> {dst}")
