#!/usr/bin/env python3
import json
import re
from collections import defaultdict
from datetime import date, time
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent
SOURCE = WORKSPACE / "行程" / "新西兰行程_V2.xlsx"
OUTPUT = ROOT / "trip-data.json"
TRIP_YEAR = 2026


def cell(value):
    if value is None or pd.isna(value):
        return ""
    if isinstance(value, time):
        return value.strftime("%H:%M")
    text = str(value).strip()
    if text.endswith(":00") and re.fullmatch(r"\d{1,2}:\d{2}:00", text):
        return text[:-3]
    return text


def source_date_to_iso(label):
    match = re.fullmatch(r"(\d{1,2})月(\d{1,2})日", str(label).strip())
    if not match:
        raise ValueError(f"Unsupported date label: {label!r}")
    return date(TRIP_YEAR, int(match.group(1)), int(match.group(2))).isoformat()


def slug(value):
    value = re.sub(r"[^\w\s-]", " ", str(value).lower(), flags=re.UNICODE)
    value = re.sub(r"\s+", "-", value).strip("-")
    return value[:54] or "place"


def clean_place_name(value):
    text = cell(value)
    text = re.sub(r"^(抵达|到达)\s*", "", text)
    text = text.replace("📍", "").replace("️", "")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def item_type(project, place):
    text = f"{project} {place}"
    if "飞" in text or "机场" in project or project.startswith("✈"):
        return "flight"
    if any(key in text for key in ["取车", "还车", "自驾"]):
        return "drive"
    if any(key in text for key in ["入住", "休息", "🛏", "😴"]):
        return "check-in"
    if any(key in text for key in ["退房"]):
        return "check-out"
    if any(key in text for key in ["早餐", "午餐", "晚餐", "小吃", "咖啡", "🍔", "🍟", "☕"]):
        return "restaurant"
    if any(key in text for key in ["地铁", "去机场", "接驳", "Changi →"]):
        return "transfer"
    if any(key in text for key in ["徒步", "🚶"]):
        return "walk"
    if any(key in text for key in ["停车", "🅿"]):
        return "drive"
    return "attraction"


def display_category(project, place):
    item = item_type(project, place)
    text = f"{project} {place}"
    if item in ["flight", "transfer", "drive"] or any(key in text for key in ["地铁", "机场", "接驳", "飞", "落地", "去酒店", "取行李", "Changi", "樟宜"]):
        return "traffic"
    if item == "restaurant":
        return "dining"
    if item in ["check-in", "check-out"] or any(key in text for key in ["入住", "住宿", "酒店"]):
        return "lodging"
    if "停车" in text or "🅿" in text:
        return "parking"
    if item in ["attraction", "walk"] or any(key in text for key in ["参观", "徒步", "观星", "缆车", "婚礼"]):
        return "activity"
    return "other"


def schedule_icon(project, place):
    category = display_category(project, place)
    text = f"{project} {place}"
    if "停车" in text or "🅿" in text:
        return "🅿️"
    if any(key in text for key in ["早餐", "午餐", "晚餐", "小吃", "咖啡", "餐厅", "🍔", "🍟", "☕"]):
        return "🍽️"
    if any(key in text for key in ["徒步", "步道", "🚶"]):
        return "🚶"
    if any(key in text for key in ["入住", "住宿", "酒店", "休息", "🛏", "😴"]):
        return "🛏"
    if any(key in text for key in ["自驾", "取车", "还车", "开车", "驾车"]):
        return "🚗"
    if category == "traffic":
        return "✈️"
    if category == "dining":
        return "🍽️"
    if category == "lodging":
        return "🛏"
    if category == "parking":
        return "🅿️"
    if category == "activity":
        return "🎯"
    return "📌"


def clean_project_title(value):
    text = cell(value)
    text = re.sub(r"^[^\w\u3400-\u9fff]+", "", text).strip()
    return text or "待确认事项"


def schedule_title(project, place):
    return place or clean_project_title(project)


def schedule_subtitle(project, place):
    title = clean_project_title(project)
    if title == "待确认事项" or title == place:
        return ""
    return title


def cost_fields(value):
    text = cell(value)
    costs = {"cny": "", "nzd": "", "usd": ""}
    if not text:
        return costs
    amount = re.search(r"(\d+(?:\.\d{1,2})?)", text.replace(",", ""))
    number = amount.group(1) if amount else text
    upper = text.upper()
    if "NZD" in upper or "纽" in text or "新西兰" in text:
        costs["nzd"] = number
    elif "USD" in upper or "美元" in text:
        costs["usd"] = number
    else:
        costs["cny"] = number
    return costs


def reserved_status(value):
    text = cell(value).lower()
    if not text or "不需要" in text or "unconfirmed" in text or "待" in text:
        return False
    return "☑" in text or "已" in text or "confirm" in text or "book" in text


def should_create_place(project, place):
    text = f"{project} {place}"
    if not place or len(place) > 80:
        return False
    if "→" in place or "↓" in place:
        return False
    if re.match(r"^(SQ|CA|NZ|MU)\d+", place):
        return False
    if any(key in text for key in ["飞新加坡", "飞基督城", "飞上海"]):
        return False
    return True


def make_schedule_text(row):
    place = clean_place_name(row["关键地点"])
    project = cell(row["项目"])
    duration = cell(row["路程耗时"])
    stay = cell(row["项目耗时"])
    note = cell(row["备注"])
    parts = []
    if project and place:
        parts.append(f"{project}｜{place}")
    else:
        parts.append(project or place or "待确认事项")
    if duration:
        parts.append(duration)
    if stay:
        parts.append(stay)
    if note:
        parts.append(note)
    return "；".join(parts)


COUNTRIES = [
    {"code": "NZ", "name": "New Zealand", "nameZh": "新西兰", "nameEn": "New Zealand"},
    {"code": "SG", "name": "Singapore", "nameZh": "新加坡", "nameEn": "Singapore"},
]

MAP_PLACES = [
    ("chc-airport", "Christchurch Airport", "基督城机场", -43.4894, 172.5322, "Christchurch Airport, New Zealand", True),
    ("christchurch", "Christchurch", "基督城", -43.5321, 172.6362, "Christchurch, New Zealand", True),
    ("timaru", "Timaru", "蒂马鲁", -44.3967, 171.2536, "Timaru, New Zealand", True),
    ("oamaru", "Oamaru", "奥马鲁", -45.0976, 170.9704, "Oamaru, New Zealand", True),
    ("katiki", "Katiki Point", "Katiki Point", -45.3986, 170.8559, "Katiki Point Lighthouse, New Zealand", False),
    ("dunedin", "Dunedin", "但尼丁", -45.8788, 170.5028, "Dunedin, New Zealand", True),
    ("queenstown", "Queenstown", "皇后镇", -45.0312, 168.6626, "Queenstown, New Zealand", True),
    ("arrowtown", "Arrowtown", "箭镇", -44.9417, 168.8350, "Arrowtown, New Zealand", False),
    ("wanaka", "Wanaka", "瓦纳卡", -44.7032, 169.1321, "Wānaka, New Zealand", True),
    ("lindis-pass", "Lindis Pass", "林迪斯山口", -44.5888, 169.6375, "Lindis Pass Viewpoint, New Zealand", False),
    ("lake-pukaki", "Lake Pukaki", "普卡基湖", -44.1532, 170.0801, "Lake Pukaki, New Zealand", True),
    ("mt-cook", "Aoraki / Mount Cook", "库克山", -43.5950, 170.1418, "Aoraki Mount Cook National Park, New Zealand", True),
    ("twizel", "Twizel", "特威泽尔", -44.2576, 170.0970, "Twizel, New Zealand", False),
    ("lake-tekapo", "Lake Tekapo", "蒂卡波湖", -44.0047, 170.4771, "Lake Tekapo, New Zealand", True),
    ("fairlie", "Fairlie", "Fairlie", -44.1007, 170.8280, "Fairlie Bakehouse, Fairlie, New Zealand", False),
    ("rakaia-gorge", "Rakaia Gorge", "Rakaia Gorge", -43.5740, 171.6550, "Rakaia Gorge Scenic Lookout, New Zealand", False),
]

MAP_LABEL_OFFSETS = {
    "chc-airport": {"x": 24, "y": -10},
    "christchurch": {"x": -24, "y": 26},
    "timaru": {"x": 24, "y": -20},
    "oamaru": {"x": -22, "y": -18},
    "katiki": {"x": 22, "y": -18},
    "dunedin": {"x": 24, "y": 28},
    "queenstown": {"x": 24, "y": 28},
    "arrowtown": {"x": -22, "y": -18},
    "wanaka": {"x": -24, "y": -22},
    "lindis-pass": {"x": 24, "y": -18},
    "lake-pukaki": {"x": 26, "y": -42},
    "mt-cook": {"x": 24, "y": -20},
    "twizel": {"x": -24, "y": 30},
    "lake-tekapo": {"x": -24, "y": 44},
    "fairlie": {"x": 24, "y": 28},
    "rakaia-gorge": {"x": 24, "y": 28},
}

SINGAPORE_MAP_PLACES = [
    ("sin-airport", "Singapore Changi Airport", "樟宜机场", 1.3644, 103.9915, "Singapore Changi Airport", True),
    ("bencoolen", "Bencoolen", "明古连", 1.3009, 103.8522, "Bencoolen, Singapore", True),
    ("yakun", "Ya Kun Kaya Toast", "亚坤", 1.3009, 103.8550, "Ya Kun Kaya Toast Singapore", False),
    ("national-gallery", "National Gallery Singapore", "新加坡国家美术馆", 1.2903, 103.8519, "National Gallery Singapore", True),
    ("merlion", "Merlion Park", "鱼尾狮公园", 1.2868, 103.8545, "Merlion Park Singapore", True),
    ("clarke-quay", "Clarke Quay", "克拉码头", 1.2906, 103.8465, "Clarke Quay Singapore", True),
    ("fort-canning", "Fort Canning Park", "福康宁公园", 1.2940, 103.8465, "Fort Canning Park Singapore", False),
    ("jewel", "Jewel Changi", "星耀樟宜", 1.3602, 103.9896, "Jewel Changi Airport Singapore", True),
]

SINGAPORE_MAP_LABEL_OFFSETS = {
    "sin-airport": {"x": -24, "y": -18},
    "bencoolen": {"x": -24, "y": -24},
    "yakun": {"x": 24, "y": -28},
    "national-gallery": {"x": -24, "y": 44},
    "merlion": {"x": 28, "y": -24},
    "clarke-quay": {"x": 24, "y": 34},
    "fort-canning": {"x": -24, "y": -28},
    "jewel": {"x": -24, "y": -18},
}

SINGAPORE_ROUTE_BY_DAY = {
    1: ["sin-airport", "bencoolen"],
    2: ["bencoolen", "yakun", "national-gallery", "merlion", "clarke-quay", "fort-canning", "sin-airport"],
    12: ["sin-airport", "jewel"],
    13: ["jewel", "sin-airport"],
}

NEW_ZEALAND_ROUTE_BY_DAY = {
    3: ["chc-airport", "christchurch", "timaru"],
    4: ["timaru", "oamaru", "katiki", "dunedin"],
    5: ["dunedin", "queenstown"],
    6: ["queenstown"],
    7: ["queenstown"],
    8: ["queenstown", "arrowtown", "wanaka"],
    9: ["wanaka", "lindis-pass", "lake-pukaki", "mt-cook", "twizel"],
    10: ["twizel", "lake-tekapo"],
    11: ["lake-tekapo", "fairlie", "rakaia-gorge", "christchurch"],
    12: ["christchurch", "chc-airport"],
}

DAILY_MAP_LABEL_OFFSETS = {
    9: {
        "twizel": {"x": 24, "y": -22},
    },
    11: {
        "rakaia-gorge": {"x": -24, "y": -30},
    },
}


def build_days_and_places():
    df = pd.read_excel(SOURCE, sheet_name="行程表")
    days = []
    place_by_label = {}
    places = {}
    current = None
    counters = defaultdict(int)

    for row_index, row in df.iterrows():
        if cell(row.get("日期")):
            if current:
                days.append(current)
            day_num = int(re.sub(r"\D", "", cell(row["天"])))
            current = {
                "id": f"day-{day_num:02d}",
                "day": day_num,
                "date": source_date_to_iso(row["日期"]),
                "sourceDateLabel": cell(row["日期"]),
                "title": "",
                "locations": [],
                "schedule": [],
                "notes": [],
                "costReferences": [],
            }
            if cell(row.get("住宿")):
                current["notes"].append(f"住宿：{cell(row.get('住宿'))}")
        if not current:
            continue

        place_label = clean_place_name(row.get("关键地点"))
        project = cell(row.get("项目"))
        if not place_label and not project:
            continue

        if not current["title"]:
            current["title"] = project or place_label
        if place_label:
            location = place_label.split("\n")[0]
            location = re.sub(r"^(抵达|到达)\s*", "", location).strip()
            if location and location not in current["locations"] and len(current["locations"]) < 4:
                current["locations"].append(location)

        counters[current["day"]] += 1
        schedule_id = f"d{current['day']:02d}-{counters[current['day']]:02d}"
        navigation = cell(row.get("导航"))
        schedule = {
            "id": schedule_id,
            "time": cell(row.get("时间轴")) or "待定",
            "type": item_type(project, place_label),
            "title": schedule_title(project, place_label),
            "subtitle": schedule_subtitle(project, place_label),
            "icon": schedule_icon(project, place_label),
            "displayCategory": display_category(project, place_label),
            "routeDuration": cell(row.get("路程耗时")),
            "itemDuration": cell(row.get("项目耗时")),
            "navigationQuery": navigation,
            "navigationLabel": navigation,
            "costs": cost_fields(row.get("费用")),
            "note": cell(row.get("备注")),
            "reserved": reserved_status(row.get("Unnamed: 11")),
            "text": make_schedule_text(row),
        }
        if navigation:
            schedule["navigationSource"] = "excel"

        if should_create_place(project, place_label):
            key = place_label.lower()
            if key not in place_by_label:
                base_id = slug(place_label)
                place_id = base_id
                suffix = 2
                while place_id in places:
                    place_id = f"{base_id}-{suffix}"
                    suffix += 1
                place_by_label[key] = place_id
                query = cell(row.get("导航")) or place_label
                places[place_id] = {
                    "id": place_id,
                    "name": place_label,
                    "nameZh": place_label,
                    "cityOrArea": "",
                    "navigation": {"query": query},
                }
            schedule["placeId"] = place_by_label[key]

        if cell(row.get("费用")):
            current["costReferences"].append({
                "item": project or place_label or "费用",
                "currency": "原表",
                "amount": cell(row.get("费用")),
            })
        current["schedule"].append(schedule)

    if current:
        days.append(current)

    concise_locations = day_locations()
    for day in days:
        if day["day"] in concise_locations:
            day["locations"] = concise_locations[day["day"]]
        elif not day["locations"]:
            day["locations"] = [day["title"] or f"D{day['day']}"]
        day["title"] = day_titles().get(day["day"], day["title"])

    return days, list(places.values())


def day_titles():
    return {
        1: "上海出发，经新加坡入境",
        2: "新加坡 City Walk，夜航前往基督城",
        3: "抵达基督城，取车后前往 Timaru",
        4: "Timaru - Oamaru - Dunedin 海岸线",
        5: "Dunedin 城区与长距离转场皇后镇",
        6: "皇后镇婚纱与湖边休整",
        7: "皇后镇婚礼日 / 米尔福德峡湾备选",
        8: "皇后镇 - 箭镇 - 瓦纳卡",
        9: "瓦纳卡 - 普卡基湖 - 库克山 - Twizel",
        10: "Twizel - Air Safaris - 蒂卡波观星",
        11: "蒂卡波 - Fairlie - Rakaia Gorge - 基督城",
        12: "基督城还车，飞新加坡",
        13: "新加坡转机，抵达上海",
    }


def day_locations():
    return {
        1: ["上海", "新加坡"],
        2: ["新加坡市区", "樟宜机场", "基督城夜航"],
        3: ["基督城", "Wigram", "Timaru"],
        4: ["Timaru", "Oamaru", "Dunedin"],
        5: ["Dunedin", "Queenstown"],
        6: ["Queenstown", "Lake Wakatipu", "Skyline"],
        7: ["Queenstown", "婚礼日", "Milford Sound 备选"],
        8: ["Queenstown", "Arrowtown", "Wanaka"],
        9: ["Wanaka", "Lake Pukaki", "Aoraki / Mount Cook", "Twizel"],
        10: ["Twizel", "Lake Tekapo", "Mt John"],
        11: ["Lake Tekapo", "Fairlie", "Rakaia Gorge", "Christchurch"],
        12: ["Christchurch", "Singapore"],
        13: ["Singapore", "Shanghai"],
    }


def build_flights():
    journeys = [
        {"id": "journey-shanghai-singapore", "title": "上海 → 新加坡"},
        {"id": "journey-singapore-christchurch", "title": "新加坡 → 基督城"},
        {"id": "journey-christchurch-shanghai", "title": "基督城 → 新加坡 → 上海"},
    ]
    flights = [
        {
            "id": "flight-sq831",
            "journeyId": "journey-shanghai-singapore",
            "sequence": 1,
            "airline": {"name": "Singapore Airlines", "nameZh": "新加坡航空"},
            "flightNumber": "SQ831",
            "departure": {"airportCode": "PVG", "city": "上海", "date": "2026-09-25", "time": "14:30", "utcOffset": "+08:00"},
            "arrival": {"airportCode": "SIN", "city": "新加坡", "date": "2026-09-25", "time": "20:20", "utcOffset": "+08:00"},
        },
        {
            "id": "flight-sq297",
            "journeyId": "journey-singapore-christchurch",
            "sequence": 1,
            "airline": {"name": "Singapore Airlines", "nameZh": "新加坡航空"},
            "flightNumber": "SQ297",
            "departure": {"airportCode": "SIN", "city": "新加坡", "date": "2026-09-26", "time": "19:50", "utcOffset": "+08:00"},
            "arrival": {"airportCode": "CHC", "city": "基督城", "date": "2026-09-27", "time": "10:30", "utcOffset": "+13:00"},
        },
        {
            "id": "flight-sq298",
            "journeyId": "journey-christchurch-shanghai",
            "sequence": 1,
            "airline": {"name": "Singapore Airlines", "nameZh": "新加坡航空"},
            "flightNumber": "SQ298",
            "departure": {"airportCode": "CHC", "city": "基督城", "date": "2026-10-06", "time": "11:50", "utcOffset": "+13:00"},
            "arrival": {"airportCode": "SIN", "city": "新加坡", "date": "2026-10-06", "time": "17:40", "utcOffset": "+08:00"},
        },
        {
            "id": "flight-sq826",
            "journeyId": "journey-christchurch-shanghai",
            "sequence": 2,
            "airline": {"name": "Singapore Airlines", "nameZh": "新加坡航空"},
            "flightNumber": "SQ826",
            "departure": {"airportCode": "SIN", "city": "新加坡", "date": "2026-10-07", "time": "01:15", "utcOffset": "+08:00"},
            "arrival": {"airportCode": "PVG", "city": "上海", "date": "2026-10-07", "time": "06:35", "utcOffset": "+08:00"},
            "connectionFromPrevious": {"plannedDurationText": "新加坡转机约 7 小时 35 分"},
        },
    ]
    return journeys, flights


def build_map():
    nz_places = []
    for place_id, name, name_zh, lat, lng, query, overview in MAP_PLACES:
        place = {
            "id": place_id,
            "name": name,
            "nameZh": name_zh,
            "countryCode": "NZ",
            "mapRegionId": "new-zealand",
            "geo": {"lat": lat, "lng": lng},
            "query": query,
            "overview": overview,
        }
        if place_id in MAP_LABEL_OFFSETS:
            place["labelOffset"] = MAP_LABEL_OFFSETS[place_id]
        nz_places.append(place)
    sg_places = []
    for place_id, name, name_zh, lat, lng, query, overview in SINGAPORE_MAP_PLACES:
        place = {
            "id": place_id,
            "name": name,
            "nameZh": name_zh,
            "countryCode": "SG",
            "mapRegionId": "singapore",
            "geo": {"lat": lat, "lng": lng},
            "query": query,
            "overview": overview,
        }
        if place_id in SINGAPORE_MAP_LABEL_OFFSETS:
            place["labelOffset"] = SINGAPORE_MAP_LABEL_OFFSETS[place_id]
        sg_places.append(place)
    routes = []
    for route_by_day in (SINGAPORE_ROUTE_BY_DAY, NEW_ZEALAND_ROUTE_BY_DAY):
        for day, ids in sorted(route_by_day.items()):
            if len(ids) >= 2:
                route = {"day": day, "placeIds": ids, "scheduleItems": []}
                if day in DAILY_MAP_LABEL_OFFSETS:
                    route["labelOffsets"] = DAILY_MAP_LABEL_OFFSETS[day]
                routes.append(route)
    return {
        "schemaVersion": "1.0-lite",
        "mapMode": "template-auto",
        "templateId": "auto",
        "defaultRegionId": "new-zealand",
        "disclaimer": "本图为旅行路线示意；新加坡为城市停留，新西兰南岛为自驾路线。实际导航请以当天 Google Maps 为准。",
        "regions": [
            {
                "id": "singapore",
                "label": "新加坡",
                "countryCode": "SG",
                "countryCodes": ["SG"],
                "heading": "SINGAPORE / 中转停留",
                "description": "樟宜机场、Bencoolen、市区步行与返程转机的城市路线示意。",
            },
            {
                "id": "new-zealand",
                "label": "新西兰南岛",
                "countryCode": "NZ",
                "countryCodes": ["NZ"],
                "heading": "NEW ZEALAND / 南岛自驾",
                "description": "基督城取还车，途经 Timaru、Oamaru、Dunedin、Queenstown、Wanaka、Aoraki / Mount Cook 与 Lake Tekapo。",
            },
        ],
        "places": [*sg_places, *nz_places],
        "routes": routes,
        "dailyRoutes": routes,
    }


def build_tickets():
    return [
        {"id": "ticket-national-kitchen", "day": 2, "category": "restaurant-booking", "name": "National Kitchen by Violet Oon 午餐预订", "requirement": "advance-recommended", "guidance": ["表格标记需提前预定，时间段 12:00-17:00 / 18:00-22:30"], "scheduleMatchTerms": ["娘惹餐厅", "National Kitchen"]},
        {"id": "ticket-star-garter", "day": 4, "category": "restaurant-booking", "name": "Star and Garter Restaurant 午餐", "requirement": "advance-recommended", "purchaseStatus": "purchased", "guidance": ["表格已打勾"], "scheduleMatchTerms": ["Star and Garter"]},
        {"id": "ticket-saigon-kingdom", "day": 5, "category": "restaurant-booking", "name": "Saigon Kingdom 晚餐", "requirement": "advance-recommended", "purchaseStatus": "purchased", "guidance": ["表格已打勾"], "scheduleMatchTerms": ["Saigon Kingdom"]},
        {"id": "ticket-ice-bar", "day": 5, "category": "activity-booking", "name": "Queenstown Ice Bar", "requirement": "advance-recommended", "guidance": ["@老柴夫妇预定，需确认 21:00 / 22:00 场次"], "officialUrl": "https://queenstownicebar.com/bookings/", "scheduleMatchTerms": ["冰吧", "Ice Bar"]},
        {"id": "ticket-bella-cucina", "day": 6, "category": "restaurant-booking", "name": "Bella Cucina 午餐", "requirement": "advance-recommended", "purchaseStatus": "purchased", "guidance": ["表格标记已预约"], "officialUrl": "https://booking.nowbookit.com/booking?accountid=c3b945a4-7a46-4fd7-972a-842cdb54d331&venueid=1897&theme=light&accent=32,149,242", "scheduleMatchTerms": ["Bella Cucina"]},
        {"id": "ticket-skyline-luge", "day": 6, "category": "ticket", "name": "Skyline 缆车 + Luge", "requirement": "advance-required", "guidance": ["建议提前一天购买；4:30 前上缆车"], "officialUrl": "https://queenstown.skyline.co.nz/", "scheduleMatchTerms": ["skyline", "Luge", "缆车"]},
        {"id": "ticket-flame", "day": 6, "category": "restaurant-booking", "name": "Flame Bar & Grill 晚餐", "requirement": "advance-recommended", "purchaseStatus": "purchased", "guidance": ["表格已打勾，可看 First Table / 官网预订"], "officialUrl": "https://www.flamegrill.co.nz/reservation", "scheduleMatchTerms": ["Flame Bar"]},
        {"id": "ticket-kika", "day": 8, "category": "restaurant-booking", "name": "Kika 晚餐", "requirement": "advance-recommended", "purchaseStatus": "purchased", "guidance": ["表格已打勾，可确认预订"], "officialUrl": "https://kika.nz/bookings/", "scheduleMatchTerms": ["Kika"]},
        {"id": "ticket-air-safaris", "day": 10, "category": "ticket", "name": "Air Safaris 飞行体验", "requirement": "advance-required", "guidance": ["提前 15 分钟 check in；飞行约 50 分钟"], "scheduleMatchTerms": ["air Safaris", "Air Safaris"]},
        {"id": "ticket-stargazing", "day": 10, "category": "ticket", "name": "Lake Tekapo 观星", "requirement": "advance-required", "guidance": ["Chameleon Stargazing 或 Dark Sky Project，提前 30 分钟"], "scheduleMatchTerms": ["观星", "chameleonstargazing", "dark sky"]},
        {"id": "ticket-mackenzies", "day": 10, "category": "restaurant-booking", "name": "Mackenzies Bar & Grill 晚餐", "requirement": "advance-recommended", "purchaseStatus": "purchased", "guidance": ["表格已打勾，石板牛排需预约"], "scheduleMatchTerms": ["Mackenzies"]},
    ]


def build_todos():
    items = [
        ("all", "新加坡入境前 3 天填写入境卡"),
        ("all", "下载 Grab，方便新加坡打车"),
        ("all", "手机开通国际漫游"),
        ("all", "准备 Visa / 国际信用卡"),
        ("all", "取车随身带驾照原件、NZTA 认证翻译件或小白本、信用卡、提车单"),
        ("all", "确认 Ice Bar、Air Safaris、Lake Tekapo 观星项目的最终场次"),
        ("all", "自驾前下载 Waze、Google Maps、Gaspy"),
        ("all", "准备黑布遮盖后备箱行李"),
    ]
    return [{"id": f"todo-{index + 1:02d}", "groupId": group_id, "text": text, "completed": False} for index, (group_id, text) in enumerate(items)]


def build_accommodations():
    stays = [
        ("stay-singapore", "Ibis Singapore on Bencoolen", "2026-09-25", "2026-09-26", "170 Bencoolen St, 189657, Singapore"),
        ("stay-timaru", "Jellicoe 度假屋", "2026-09-27", "2026-09-28", "34D Jellicoe Street, Timaru, Canterbury Region 7910"),
        ("stay-dunedin", "Sea Salt B&B", "2026-09-28", "2026-09-29", "18A Motu Street, Dunedin, Otago 9012"),
        ("stay-queenstown", "Tina Maria", "2026-09-29", "2026-10-02", "13 Poole Lane, Queenstown, Otago Region 9300"),
        ("stay-wanaka", "Wanaka 住宿", "2026-10-02", "2026-10-03", "34A Packer Road, Wānaka, Otago Region 9382"),
        ("stay-twizel", "Twizel 住宿", "2026-10-03", "2026-10-04", "35 Tasman Road, Twizel, Canterbury Region 7901"),
        ("stay-tekapo", "Lake Tekapo 住宿", "2026-10-04", "2026-10-05", "64 Murray Place, Lake Tekapo, Canterbury 7999"),
        ("stay-christchurch", "Christchurch 住宿", "2026-10-05", "2026-10-06", "25 Carradale Avenue, Christchurch, Canterbury 8042"),
    ]
    return [
        {"id": stay_id, "name": name, "checkIn": check_in, "checkOut": check_out, "address": address}
        for stay_id, name, check_in, check_out, address in stays
    ]


def build_rental():
    return {
        "rentalCar": {
            "company": "RaD Car Hire Christchurch",
            "bookingNumber": "",
            "rentalPeriodDays": 9,
            "vehicle": {"example": "2025 Toyota Rav4 Hybrid AWD", "class": "SUV / Hybrid AWD"},
            "unlimitedKilometers": True,
            "price": {"currency": "NZD", "payAtCounter": 1230.00},
            "insurance": [
                "Gold Cover：$0 Excess Liability / Windscreen Liability $0",
                "Tyres and punctures coverage included in booking",
                "Airport shuttle fee included",
            ],
            "pickup": {
                "date": "2026-09-27",
                "time": "11:00",
                "location": "Christchurch Airport Depot",
                "address": "8 Sir Keith Park Place, Mustang Park, Harewood",
                "utcOffset": "+13:00",
            },
            "dropoff": {
                "date": "2026-10-06",
                "time": "09:00",
                "timeZoneLabel": "New Zealand daylight time",
                "vehicleReturnPoint": "Christchurch Airport Depot, 8 Sir Keith Park Place",
                "deadlineWarning": "预订 09:00 还车；建议 08:30 前抵达机场区域，预留还车、接驳、托运和安检时间。",
                "recommendedArrivalTime": "08:30",
                "utcOffset": "+13:00",
            },
        },
        "rentalChecklist": [
            "抵达机场后致电 03 348 3749 或 0800 73 68 23，前往 Regional Departures 1、2 号门外等待接驳。",
            "取车时准备驾照原件、NZTA 认证翻译件或小白本、主驾驶信用卡、提车单。",
            "绕车一周拍照，重点记录车身划痕、轮胎、油表读数、备胎和警示设备。",
            "满油取车，按订单要求还车前加满油。",
            "若非营业时间取还车，可能产生 NZD 40 after-hours fee。",
        ],
        "drivingNotes": [
            "新西兰靠左行驶，刚取车先在机场附近慢速适应右舵、转向灯和雨刷位置。",
            "进入环岛前让行右侧车辆，看到 Give Way 标志务必减速观察。",
            "长途日不贪多，优先保证白天驾驶。",
            "用 Waze 看限速和测速提醒，用 Google Maps 导航餐厅、景点和停车场，用 Gaspy 查油价。",
        ],
        "drivingReferenceLinks": [
            {"label": "Drive Safe New Zealand", "url": "http://www.drivesafe.org.nz/"},
            {"label": "RaD Car Hire Terms", "url": "http://www.radcarhire.co.nz/terms-conditions/"},
        ],
        "plannedRoadLegs": [],
        "publicTransitAndRail": [],
    }


def main():
    days, extracted_places = build_days_and_places()
    journeys, flights = build_flights()
    trip_data = {
        "$schema": "./schemas/trip-data.schema.json",
        "schemaVersion": "2.0-lite",
        "config": {
            "schemaVersion": "1.0.0",
            "modules": {
                "flights": True,
                "overview": True,
                "itinerary": True,
                "todo": True,
                "driving": True,
                "ledger": True,
            },
            "language": "zh-CN",
            "persistence": {"mode": "local"},
        },
        "metadata": {
            "tripId": "new-zealand-2026-national-day",
            "title": "2026 国庆新西兰南岛自驾旅行",
            "language": "zh-CN",
            "timeZone": "Pacific/Auckland",
            "assets": {},
        },
        "trip": {
            "status": "draft",
            "startDate": "2026-09-25",
            "endDate": "2026-10-07",
            "dayCount": len(days),
            "nightCountAway": 12,
            "countries": COUNTRIES,
            "primaryDestinationCountries": ["NZ"],
            "primaryDestinationName": "新西兰南岛",
            "primaryDestinationNameEn": "New Zealand South Island",
            "heroTitle": "新西兰南岛",
            "heroEyebrow": "New Zealand South Island",
            "citiesAndAreas": ["Singapore", "Christchurch", "Timaru", "Oamaru", "Dunedin", "Queenstown", "Wanaka", "Aoraki / Mount Cook", "Lake Tekapo"],
            "routeSummary": "上海 → 新加坡 → 基督城 → Timaru → Oamaru → Dunedin → Queenstown → Wanaka → Aoraki / Mount Cook → Lake Tekapo → 基督城 → 新加坡 → 上海",
            "groupSize": None,
        },
        "flightJourneys": journeys,
        "flights": flights,
        "accommodations": build_accommodations(),
        "groundTransport": build_rental(),
        "days": days,
        "places": extracted_places,
        "restaurants": [],
        "bookingsAndTickets": [],
        "ticketPlanning": {
            "statusStorage": "local",
            "statusStorageNote": "门票和预订状态只保存在当前浏览器。",
            "items": build_tickets(),
        },
        "preTrip": {
            "todoGroups": [
                {"id": "all", "label": "ALL", "name": "共同准备"},
                {"id": "snow", "label": "🍽️ & ❄️", "name": "餐饮与雪线准备"},
                {"id": "mountain", "label": "⛰️", "name": "山路自驾"},
                {"id": "music", "label": "🎓", "name": "朋友补充"},
            ],
            "packingItems": build_todos(),
            "preparationsExplicitlyMentioned": ["新加坡入境准备", "新西兰取车证件", "自驾 App 与行李遮盖"],
            "missingNote": "",
        },
        "mapLinks": {
            "providedGoogleMapsLinks": [],
            "note": "行程卡片导航按钮仅来自表格“导航”列或用户编辑；路线地图仍可使用关键地点生成。",
            "cityLevelNavigationDisabled": False,
            "navigationPolicy": {
                "noNavigationTypes": ["flight", "note", "rest"],
                "selfNavigationTypes": ["drive", "return", "transfer", "check-in", "check-out", "restaurant", "attraction", "walk", "hike"],
            },
            "navigationPlaces": [],
        },
        "issuesAndUncertainties": [
            "9月30日皇后镇部分行程按表格保留了分组选择。",
            "10月1日同时存在婚礼日与米尔福德峡湾备选行程，已按原表保留。",
            "部分餐厅和活动虽然表格打勾，仍建议出发前核对最终预订状态。",
        ],
        "map": build_map(),
    }
    OUTPUT.write_text(json.dumps(trip_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUTPUT}")


if __name__ == "__main__":
    main()
