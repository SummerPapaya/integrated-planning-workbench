#!/usr/bin/env python3
"""Check published App01 bundle contracts and cross-grain reconciliation."""

import json
import math
from datetime import date, timedelta
from pathlib import Path


path = Path(__file__).resolve().parents[1] / "docs/method-case/data.json"
bundle = json.loads(path.read_text(encoding="utf-8"))
meta = bundle["meta"]
assert bundle["schemaVersion"] == 1
assert len(bundle["categories"]) == 6
assert meta["salesRows"] == 125751
assert meta["inventoryRows"] == 284755
expected_days = (date.fromisoformat(meta["historyEnd"]) - date.fromisoformat(meta["historyStart"])).days + 1

for category in bundle["categories"]:
    history = category["history"]
    assert len(history) == expected_days
    assert history[0]["date"] == meta["historyStart"]
    assert history[-1]["date"] == meta["historyEnd"]
    assert date.fromisoformat(category["backtestStart"]) == date.fromisoformat(meta["historyEnd"]) - timedelta(days=27)
    assert all(point["units"] >= 0 for point in history)
    assert len(category["stores"]) == 40
    assert math.isclose(sum(store["stock"] for store in category["stores"]), category["stock"], abs_tol=.01)
    assert math.isclose(sum(sku["stock"] for sku in category["skus"]), category["stock"], abs_tol=.01)
    assert math.isclose(sum(store["sales28Units"] for store in category["stores"]), category["sales28Units"], abs_tol=.01)
    assert math.isclose(sum(sku["sales28Units"] for sku in category["skus"]), category["sales28Units"], abs_tol=.01)
    assert math.isclose(sum(store["grossMargin28"] for store in category["stores"]), category["grossMargin28"], abs_tol=.01)
    assert math.isclose(sum(sku["grossMargin28"] for sku in category["skus"]), category["grossMargin28"], abs_tol=.01)
    assert 0 <= category["coveredSalesRows"] <= category["positiveSalesRows"]
    assert category["recommendedModel"] in category["models"]
    assert category["recommendedModel"] == min(category["models"], key=lambda key: (category["models"][key]["wape"], abs(category["models"][key]["bias"])))
    assert len(category["rollingWindows"]) == 3
    assert category["rollingWindows"][-1]["start"] == category["backtestStart"]
    for window in category["rollingWindows"]:
        assert (date.fromisoformat(window["end"]) - date.fromisoformat(window["start"])).days == 27
        assert set(window["models"]) == set(category["models"])
        assert all(model["wape"] >= 0 and math.isfinite(model["bias"]) for model in window["models"].values())
    for earlier, later in zip(category["rollingWindows"], category["rollingWindows"][1:]):
        assert date.fromisoformat(earlier["end"]) + timedelta(days=1) == date.fromisoformat(later["start"])
    for model in category["models"].values():
        assert len(model["backtest"]) == 28
        assert len(model["future"]) == 14
        assert all(math.isfinite(value) and value >= 0 for value in model["backtest"] + model["future"])
        assert model["wape"] >= 0
    for sku in category["skus"]:
        assert sku["stockMatchedStoreCount"] <= sku["recentStoreCount"]
        assert sku["stockMatchedStoreCount"] <= sku["activeStockStoreCount"]
    print(f"OK {category['name']}: {len(category['skus'])} SKU, stock {category['stock']}")

print("App01 data contract and cross-grain reconciliation passed")
