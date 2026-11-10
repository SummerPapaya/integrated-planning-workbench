#!/usr/bin/env python3
"""Build the static, source-audited data bundle for Planning Workbench.

Only the published Mendeley CSVs are inputs. Raw CSVs remain in .cache/ and are
not shipped with the portfolio. Run with --sales/--inventory to use local copies.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import urllib.request
from bisect import bisect_right
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "method-case" / "data.json"
CACHE = ROOT / ".cache" / "planning-workbench"
SOURCE_PAGE = "https://data.mendeley.com/datasets/27x8mjm8k4/1"
SOURCES = {
    "sales": {
        "name": "retail_sales_ml_apl.csv",
        "url": "https://data.mendeley.com/public-files/datasets/27x8mjm8k4/files/0f2e12a6-6110-4bda-b343-63a76234fa02/file_downloaded",
        "sha256": "da4763939baed1f46bfca7e893f9512a0294544494b1e794e5b8f2c59efbd2a1",
    },
    "inventory": {
        "name": "retail_inventory_ml_apl.csv",
        "url": "https://data.mendeley.com/public-files/datasets/27x8mjm8k4/files/6cdf316b-453e-482d-a9df-142262cfc6f6/file_downloaded",
        "sha256": "c765678a26c2d024e8300b8f5b4a67cb2e2bde6e24213f202914557d000ce37d",
    },
}
CATEGORY_NAMES = [
    "Scholar Footwear Trailblazer",
    "Femme Footwear Trailblazer",
    "Scholar Footwear Modern Legend",
    "Scholar Footwear Retro Legend",
    "Scholar Footwear Court Casual",
    "Scholar Footwear Flight Classic",
]
HOLDOUT_DAYS = 28
FORECAST_DAYS = 14
RECENT_DAYS = 28
MODEL_LABELS = {
    "seasonal7": "上周同日",
    "weekday4": "四周同星期均值",
    "ridge": "岭回归需求模型",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def source_path(kind: str, provided: str | None) -> Path:
    info = SOURCES[kind]
    path = Path(provided) if provided else CACHE / info["name"]
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        print(f"Downloading {info['name']} ({kind})...")
        with urllib.request.urlopen(info["url"], timeout=120) as response, path.open("wb") as out:
            while block := response.read(1024 * 1024):
                out.write(block)
    actual = sha256(path)
    if actual != info["sha256"]:
        raise ValueError(f"SHA-256 mismatch for {path}: {actual}")
    return path


def num(value: str) -> float:
    return float(value or 0)


def dates_between(start: date, end: date) -> list[date]:
    return [start + timedelta(days=n) for n in range((end - start).days + 1)]


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def features(series: list[float], t: int, day: date, level: float) -> list[float]:
    recent7 = mean(series[t - 7 : t])
    recent28 = mean(series[t - 28 : t])
    weekday = day.weekday()
    return [
        series[t - 1] / level,
        series[t - 7] / level,
        recent7 / level,
        recent28 / level,
        (recent7 - recent28) / level,
        math.sin(2 * math.pi * weekday / 7),
        math.cos(2 * math.pi * weekday / 7),
        1.0,
    ]


def solve(matrix: list[list[float]], vector: list[float]) -> list[float]:
    """Small Gaussian elimination for dependency-free ridge regression."""
    size = len(vector)
    a = [row[:] + [vector[n]] for n, row in enumerate(matrix)]
    for col in range(size):
        pivot = max(range(col, size), key=lambda row: abs(a[row][col]))
        if abs(a[pivot][col]) < 1e-10:
            raise ValueError("Singular model matrix")
        a[col], a[pivot] = a[pivot], a[col]
        divisor = a[col][col]
        for j in range(col, size + 1):
            a[col][j] /= divisor
        for row in range(size):
            if row == col:
                continue
            factor = a[row][col]
            for j in range(col, size + 1):
                a[row][j] -= factor * a[col][j]
    return [a[n][size] for n in range(size)]


def train_ridge(series: list[float], days: list[date], end: int) -> tuple[list[float], float]:
    level = max(1.0, mean(series[:end]))
    width = 8
    matrix = [[0.0] * width for _ in range(width)]
    vector = [0.0] * width
    for t in range(28, end):
        x = features(series, t, days[t], level)
        y = series[t] / level
        for a in range(width):
            vector[a] += x[a] * y
            for b in range(width):
                matrix[a][b] += x[a] * x[b]
    for index in range(width - 1):
        matrix[index][index] += 3.0
    matrix[-1][-1] += 0.001
    return solve(matrix, vector), level


def predict(model: str, history: list[float], day: date, beta: list[float], level: float) -> float:
    t = len(history)
    if model == "seasonal7":
        estimate = history[t - 7]
    elif model == "weekday4":
        estimate = mean([history[t - shift] for shift in (7, 14, 21, 28)])
    else:
        x = features(history, t, day, level)
        estimate = sum(weight * value for weight, value in zip(beta, x)) * level
    return max(0.0, estimate)


def model_evidence(series: list[float], days: list[date]) -> dict:
    boundary = len(series) - HOLDOUT_DAYS
    if boundary < 70:
        raise ValueError("Insufficient history for time-based evaluation")
    beta_final, level_final = train_ridge(series, days, len(series))
    rolling = []
    for offset in (3, 2, 1):
        end = len(series) - HOLDOUT_DAYS * (offset - 1)
        start = end - HOLDOUT_DAYS
        beta_test, level_test = train_ridge(series, days, start)
        actual = series[start:end]
        window = {"start": days[start].isoformat(), "end": days[end - 1].isoformat(), "actualUnits": round(sum(actual), 2), "models": {}}
        for model in MODEL_LABELS:
            backtest = [predict(model, series[:t], days[t], beta_test, level_test) for t in range(start, end)]
            denominator = max(1.0, sum(actual))
            window["models"][model] = {
                "wape": round(sum(abs(a - p) for a, p in zip(actual, backtest)) / denominator * 100, 1),
                "bias": round(sum(p - a for a, p in zip(actual, backtest)) / denominator * 100, 1),
                "mae": round(mean([abs(a - p) for a, p in zip(actual, backtest)]), 2),
                "backtest": [round(value, 2) for value in backtest] if offset == 1 else [],
            }
        rolling.append(window)
    recent = rolling[-1]
    output = {}
    for model in MODEL_LABELS:
        result = recent["models"][model]
        history = series[:]
        future = []
        for step in range(FORECAST_DAYS):
            day = days[-1] + timedelta(days=step + 1)
            value = predict(model, history, day, beta_final, level_final)
            future.append(round(value, 2))
            history.append(value)
        output[model] = {
            "label": MODEL_LABELS[model],
            "wape": result["wape"],
            "bias": result["bias"],
            "mae": result["mae"],
            "backtest": result["backtest"],
            "future": future,
        }
    winner = min(output, key=lambda key: (output[key]["wape"], abs(output[key]["bias"])))
    for window in rolling:
        for model in window["models"].values():
            model.pop("backtest")
    return {"models": output, "recommended": winner, "rollingWindows": rolling}


def build(sales_file: Path, inventory_file: Path) -> dict:
    categories = set(CATEGORY_NAMES)
    day_units: dict[str, Counter] = defaultdict(Counter)
    stores: dict[str, dict] = defaultdict(lambda: defaultdict(lambda: {
        "units28": 0.0, "sales28": 0.0, "cogs28": 0.0,
        "returns28": 0.0, "sold_pairs28": set(), "stock": 0.0,
        "stock_pairs": set(), "excluded_negative": 0,
    }))
    skus: dict[str, dict] = defaultdict(lambda: defaultdict(lambda: {
        "description": "", "units28": 0.0, "sales28": 0.0,
        "cogs28": 0.0, "returns28": 0.0, "stock": 0.0,
        "sold_stores28": set(), "stock_stores": set(),
        "excluded_negative": 0,
    }))
    category_recent = defaultdict(lambda: {"units28": 0.0, "sales28": 0.0, "cogs28": 0.0, "returns28": 0.0})
    positive_rows: dict[str, list[tuple[str, str, str]]] = defaultdict(list)
    min_day, max_day = None, None
    sales_rows = 0
    with sales_file.open(newline="", encoding="utf-8-sig") as handle:
        for row in csv.DictReader(handle):
            sales_rows += 1
            d = date.fromisoformat(row["Transaction Date"])
            min_day = d if min_day is None else min(min_day, d)
            max_day = d if max_day is None else max(max_day, d)
            category = row["Product Category"]
            if category not in categories:
                continue
            quantity = num(row["Qty Sold"])
            is_return = row["Is Return"] == "1" or quantity < 0
            if not is_return and quantity > 0:
                day_units[category][d.isoformat()] += quantity
                positive_rows[category].append((row["Store"], row["Product No"], d.isoformat()))
            # Recent metrics are accumulated in a second pass once the end date is known.
    assert min_day and max_day
    recent_start = max_day - timedelta(days=RECENT_DAYS - 1)
    with sales_file.open(newline="", encoding="utf-8-sig") as handle:
        for row in csv.DictReader(handle):
            category = row["Product Category"]
            if category not in categories:
                continue
            d = date.fromisoformat(row["Transaction Date"])
            if not recent_start <= d <= max_day:
                continue
            detail = stores[category][row["Store"]]
            sku = skus[category][row["Product No"]]
            sku["description"] = row["Product Description"]
            totals = category_recent[category]
            qty = num(row["Qty Sold"])
            sale = num(row["Sales Amount"])
            cogs = num(row["Cogs"])
            detail["sales28"] += sale
            detail["cogs28"] += cogs
            sku["sales28"] += sale
            sku["cogs28"] += cogs
            totals["sales28"] += sale
            totals["cogs28"] += cogs
            if row["Is Return"] == "1" or qty < 0:
                detail["returns28"] += abs(qty)
                sku["returns28"] += abs(qty)
                totals["returns28"] += abs(qty)
            elif qty > 0:
                detail["units28"] += qty
                sku["units28"] += qty
                totals["units28"] += qty
                detail["sold_pairs28"].add(row["Product No"])
                sku["sold_stores28"].add(row["Store"])

    intervals: dict[tuple[str, str], list[tuple[str, str]]] = defaultdict(list)
    active_keys = set()
    inventory_rows = 0
    with inventory_file.open(newline="", encoding="utf-8-sig") as handle:
        for row in csv.DictReader(handle):
            inventory_rows += 1
            category = row["Product Category"]
            if category not in categories:
                continue
            key = (row["Store"], row["Product No"])
            start, end = row["Start Date"], row["End Date"]
            intervals[key].append((start, end))
            if start <= max_day.isoformat() <= end:
                if key in active_keys:
                    raise ValueError(f"Multiple active stock intervals: {key}")
                active_keys.add(key)
                detail = stores[category][row["Store"]]
                sku = skus[category][row["Product No"]]
                sku["description"] = row["Product Description"]
                quantity = num(row["Qty on hand"])
                if quantity < 0:
                    detail["excluded_negative"] += 1
                    sku["excluded_negative"] += 1
                else:
                    detail["stock"] += quantity
                    detail["stock_pairs"].add(row["Product No"])
                    sku["stock"] += quantity
                    sku["stock_stores"].add(row["Store"])
    sorted_starts = {}
    for key, ranges in intervals.items():
        ranges.sort()
        sorted_starts[key] = [start for start, _ in ranges]

    days = dates_between(min_day, max_day)
    results = []
    for category_id, name in enumerate(CATEGORY_NAMES, 1):
        series = [float(day_units[name].get(day.isoformat(), 0.0)) for day in days]
        evidence = model_evidence(series, days)
        covered = 0
        for store, product, day in positive_rows[name]:
            key = (store, product)
            if key not in intervals:
                continue
            index = bisect_right(sorted_starts[key], day) - 1
            if index >= 0 and intervals[key][index][1] >= day:
                covered += 1
        totals = category_recent[name]
        recent_units = totals["units28"]
        store_list = []
        for store, detail in sorted(stores[name].items()):
            observed = detail["sold_pairs28"]
            matched = observed & detail["stock_pairs"]
            store_list.append({
                "id": store,
                "stock": round(detail["stock"], 2),
                "sales28Units": round(detail["units28"], 2),
                "share": round(detail["units28"] / recent_units, 8) if recent_units else 0,
                "sales28Value": round(detail["sales28"], 2),
                "grossMargin28": round(detail["sales28"] - detail["cogs28"], 2),
                "returnUnits28": round(detail["returns28"], 2),
                "recentSkuCount": len(observed),
                "stockMatchedSkuCount": len(matched),
                "stockCoveragePct": round(len(matched) / len(observed) * 100, 1) if observed else None,
                "excludedNegativeSkuCount": detail["excluded_negative"],
            })
        sum_stock = round(sum(item["stock"] for item in store_list), 2)
        sku_list = []
        for sku_id, detail in sorted(skus[name].items()):
            observed = detail["sold_stores28"]
            matched = observed & detail["stock_stores"]
            sku_list.append({
                "id": sku_id,
                "description": detail["description"],
                "stock": round(detail["stock"], 2),
                "sales28Units": round(detail["units28"], 2),
                "sales28Value": round(detail["sales28"], 2),
                "grossMargin28": round(detail["sales28"] - detail["cogs28"], 2),
                "returnUnits28": round(detail["returns28"], 2),
                "recentStoreCount": len(observed),
                "stockMatchedStoreCount": len(matched),
                "activeStockStoreCount": len(detail["stock_stores"]),
                "excludedNegativeStoreCount": detail["excluded_negative"],
            })
        results.append({
            "id": f"category-{category_id:02d}",
            "name": name,
            "history": [{"date": day.isoformat(), "units": round(value, 2)} for day, value in zip(days, series)],
            "backtestStart": days[-HOLDOUT_DAYS].isoformat(),
            "models": evidence["models"],
            "recommendedModel": evidence["recommended"],
            "rollingWindows": evidence["rollingWindows"],
            "stock": sum_stock,
            "sales28Units": round(recent_units, 2),
            "sales28Value": round(totals["sales28"], 2),
            "grossMargin28": round(totals["sales28"] - totals["cogs28"], 2),
            "returnUnits28": round(totals["returns28"], 2),
            "stockCoveragePct": round(100 * covered / len(positive_rows[name]), 1),
            "positiveSalesRows": len(positive_rows[name]),
            "coveredSalesRows": covered,
            "excludedNegativeSkuCount": sum(item["excludedNegativeSkuCount"] for item in store_list),
            "stores": store_list,
            "skus": sku_list,
        })
    return {
        "schemaVersion": 1,
        "meta": {
            "source": SOURCE_PAGE,
            "sourceDoi": "10.17632/27x8mjm8k4.1",
            "license": "CC BY 4.0",
            "asOf": max_day.isoformat(),
            "historyStart": min_day.isoformat(),
            "historyEnd": max_day.isoformat(),
            "holdoutDays": HOLDOUT_DAYS,
            "forecastDays": FORECAST_DAYS,
            "scope": "Six highest-transaction retail categories; category-level positive sales forecast, store-level stock scenario",
            "salesRows": sales_rows,
            "inventoryRows": inventory_rows,
            "salesSha256": SOURCES["sales"]["sha256"],
            "inventorySha256": SOURCES["inventory"]["sha256"],
            "observed": "Positive transactions and valid stock intervals are observed; returns are excluded from forecast targets but included in net margin.",
            "assumed": "Future receipts, lead time, store allocation, and service targets are user-entered scenario assumptions.",
            "provenance": "Publisher describes an ML-ready retail sample; underlying business provenance is not independently verified.",
        },
        "categories": results,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sales", help="Path to published sales CSV (otherwise download/cache)")
    parser.add_argument("--inventory", help="Path to published inventory CSV (otherwise download/cache)")
    parser.add_argument("--output", default=str(OUTPUT), help="Where to write the static JSON bundle")
    args = parser.parse_args()
    data = build(source_path("sales", args.sales), source_path("inventory", args.inventory))
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {output} ({output.stat().st_size:,} bytes)")
    for category in data["categories"]:
        model = category["recommendedModel"]
        print(f"  {category['name']}: {model} WAPE {category['models'][model]['wape']}%, stock {category['stock']}, coverage {category['stockCoveragePct']}%")


if __name__ == "__main__":
    main()
