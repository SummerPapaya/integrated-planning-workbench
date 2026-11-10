#!/usr/bin/env python3
"""Build a traceable multi-category planning demo from the Mendeley CSVs.

Selection is deterministic: the six documented footwear product lines, three
high-volume Junior Apparel lines, and the original footwear-selected twenty
stores. No purchase orders or supplier terms are made up.
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path
from statistics import median

from build_planning_workbench import CATEGORY_NAMES, ROOT, SOURCE_PAGE, source_path


OUTPUT = ROOT / "docs" / "demo.json"
HISTORY_DAYS = 168
STORE_COUNT = 20
JUNIOR_LINES = [
    "Junior Apparel Printed Tees",
    "Junior Apparel Crew Tees",
    "Junior Apparel Cozy Pullovers",
]
DEMO_PRODUCT_LINES = [*CATEGORY_NAMES, *JUNIOR_LINES]
MAJOR_CATEGORIES = ["Femme Footwear", "Junior Apparel", "Scholar Footwear"]


def major_category(product_line: str) -> str:
    match = next((major for major in MAJOR_CATEGORIES if product_line.startswith(major + " ")), None)
    if not match:
        raise ValueError(f"Unrecognized product category: {product_line}")
    return match


def number(raw: str) -> float:
    return float(raw or 0)


def build(sales_file: Path, inventory_file: Path) -> dict:
    rows = []
    as_of = None
    with sales_file.open(newline="", encoding="utf-8-sig") as handle:
        for row in csv.DictReader(handle):
            day = date.fromisoformat(row["Transaction Date"])
            as_of = day if as_of is None else max(as_of, day)
            if row["Product Category"] in DEMO_PRODUCT_LINES:
                rows.append(row)
    assert as_of is not None
    recent_start = as_of - timedelta(days=27)
    history_start = as_of - timedelta(days=HISTORY_DAYS - 1)
    store_volume = Counter()
    for row in rows:
        day = date.fromisoformat(row["Transaction Date"])
        qty = number(row["Qty Sold"])
        if row["Product Category"] in CATEGORY_NAMES and day >= recent_start and qty > 0 and row["Is Return"] != "1":
            store_volume[row["Store"]] += qty
    chosen_stores = [store for store, _ in store_volume.most_common(STORE_COUNT)]
    chosen = set(chosen_stores)
    sales = []
    products = {}
    costs = defaultdict(list)
    for row in rows:
        day = date.fromisoformat(row["Transaction Date"])
        if row["Store"] not in chosen or day < history_start:
            continue
        sku = row["Product No"]
        products[sku] = {"sku": sku, "name": row["Product Description"], "category": row["Product Category"], "major_category": major_category(row["Product Category"])}
        sales.append({
            "date": day.isoformat(), "location": row["Store"], "sku": sku,
            "units": number(row["Qty Sold"]),
            "net_sales": number(row["Sales Amount"]), "cogs": number(row["Cogs"]),
        })
    inventory = []
    seen = set()
    with inventory_file.open(newline="", encoding="utf-8-sig") as handle:
        for row in csv.DictReader(handle):
            if row["Product Category"] not in DEMO_PRODUCT_LINES or row["Store"] not in chosen:
                continue
            if not (row["Start Date"] <= as_of.isoformat() <= row["End Date"]):
                continue
            key = (row["Store"], row["Product No"])
            if key in seen:
                raise ValueError(f"Multiple active inventory records for {key}")
            seen.add(key)
            sku = row["Product No"]
            products[sku] = {"sku": sku, "name": row["Product Description"], "category": row["Product Category"], "major_category": major_category(row["Product Category"])}
            stock = number(row["Qty on hand"])
            cost = number(row["Stock Unit Cost Price"])
            inventory.append({"as_of": as_of.isoformat(), "location": row["Store"], "sku": sku, "on_hand": stock, "unit_cost": cost})
            if cost > 0:
                costs[sku].append(cost)
    for sku, item in products.items():
        item["unit_cost"] = round(median(costs[sku]), 2) if costs[sku] else None
        item["lead_time_days"] = None
        item["case_pack"] = None
        item["min_order_qty"] = None
    return {
        "schemaVersion": 1,
        "meta": {
            "mode": "demo", "source": SOURCE_PAGE, "sourceDoi": "10.17632/27x8mjm8k4.1",
            "license": "CC BY 4.0", "asOf": as_of.isoformat(),
            "historyStart": history_start.isoformat(), "majorCategories": MAJOR_CATEGORIES, "categories": DEMO_PRODUCT_LINES,
            "selectedStores": chosen_stores,
            "selection": "Six documented footwear lines plus three active Junior Apparel lines; original top 20 stores selected by footwear positive units in the final 28 days, then held fixed for all nine lines; all selected sales and interval-effective stock",
            "limitations": "Inventory rows are effective over a Start Date / End Date interval, not a physical stock count taken on the sales cutoff date. The demo as_of is assigned from that cutoff when the interval covers it. No purchase orders, supplier lead times, MOQ, case packs or stockout exposure in source. Empty inbound means no supplied PO table, not proof that no POs exist.",
        },
        "products": sorted(products.values(), key=lambda item: item["sku"]),
        "sales": sorted(sales, key=lambda item: (item["date"], item["location"], item["sku"])),
        "inventory": sorted(inventory, key=lambda item: (item["location"], item["sku"])),
        "inbound": [],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sales", help="Published sales CSV, otherwise download and checksum-verify")
    parser.add_argument("--inventory", help="Published inventory CSV, otherwise download and checksum-verify")
    parser.add_argument("--output", default=str(OUTPUT))
    args = parser.parse_args()
    data = build(source_path("sales", args.sales), source_path("inventory", args.inventory))
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {output} ({output.stat().st_size:,} bytes): {len(data['sales'])} sales, {len(data['inventory'])} stock, {len(data['products'])} products")


if __name__ == "__main__":
    main()
