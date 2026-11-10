import { addDays, daysBetween, validDate } from "./engine.mjs";

const keyOf = (location, sku) => `${location}\u001f${sku}`;
const sum = (values) => values.reduce((total, value) => total + value, 0);
const filled = (value) => String(value ?? "").trim() !== "";
const numeric = (value) => filled(value) && Number.isFinite(Number(value));

export function validateOperationalEvidence(dataset, asOf, observedThrough = new Date().toISOString().slice(0, 10)) {
  const errors = [], warnings = [];
  const products = new Set((dataset.products || []).map((row) => String(row.sku || "").trim()));
  const locations = new Set((dataset.inventory || []).map((row) => String(row.location || "").trim()));
  const recentSales = (dataset.sales || []).filter((row) => validDate(row.date) && daysBetween(row.date, asOf) >= 0 && daysBetween(row.date, asOf) < 28 && Number(row.units) > 0);
  const combinations = new Set([...(dataset.inventory || []), ...recentSales, ...(dataset.inbound || [])].map((row) => keyOf(row.location, row.sku)));
  const identity = (row, kind) => {
    const location = String(row.location || "").trim(), sku = String(row.sku || "").trim();
    if (!location || !sku || !products.has(sku) || !locations.has(location) || !combinations.has(keyOf(location, sku))) errors.push(`${kind} 第 ${row._row || "?"} 行：SKU × 门店无法关联到当前计划范围。`);
  };
  const positive = (row, name, kind, allowZero = true) => {
    if (!numeric(row[name]) || Number(row[name]) < 0 || (!allowZero && Number(row[name]) === 0)) errors.push(`${kind} 第 ${row._row || "?"} 行：${name} 必须是${allowZero ? "非负" : "正"}数。`);
  };
  const promotions = new Set();
  for (const row of dataset.promotions || []) {
    identity(row, "促销");
    if (!validDate(row.start_date) || !validDate(row.end_date) || row.start_date > row.end_date || !filled(row.promo_id)) errors.push(`促销第 ${row._row || "?"} 行：促销编号或日期范围无效。`);
    const key = `${row.promo_id}\u001f${row.location}\u001f${row.sku}`;
    if (promotions.has(key)) errors.push(`促销第 ${row._row || "?"} 行：促销编号、门店与 SKU 重复。`);
    promotions.add(key);
  }
  const actuals = new Set();
  for (const row of dataset.actuals || []) {
    identity(row, "实际销量与缺货暴露");
    if (!validDate(row.date) || row.date <= asOf || row.date > observedThrough) errors.push(`实际销量第 ${row._row || "?"} 行：日期必须晚于库存快照且不能晚于今天。`);
    for (const field of ["sold_units", "open_hours", "out_of_stock_hours"]) positive(row, field, "实际销量");
    if (numeric(row.sold_units) && numeric(row.open_hours) && Number(row.sold_units) > 0 && Number(row.open_hours) === 0) errors.push(`实际销量第 ${row._row || "?"} 行：售出量为正时营业小时不能为零。`);
    if (numeric(row.open_hours) && Number(row.open_hours) > 24) errors.push(`实际销量第 ${row._row || "?"} 行：营业小时不能超过 24。`);
    if (numeric(row.open_hours) && numeric(row.out_of_stock_hours) && Number(row.out_of_stock_hours) > Number(row.open_hours)) errors.push(`实际销量第 ${row._row || "?"} 行：缺货小时不能超过营业小时。`);
    if (filled(row.observed_unmet_units)) positive(row, "observed_unmet_units", "实际销量");
    const key = `${row.date}\u001f${row.location}\u001f${row.sku}`;
    if (actuals.has(key)) errors.push(`实际销量第 ${row._row || "?"} 行：日期、门店与 SKU 重复。`);
    actuals.add(key);
  }
  const executions = new Set();
  for (const row of dataset.executions || []) {
    identity(row, "执行回执");
    if (!filled(row.scenario_id) || !validDate(row.eta)) errors.push(`执行回执第 ${row._row || "?"} 行：情景编号或 ETA 无效。`);
    for (const field of ["ordered_units", "received_units"]) positive(row, field, "执行回执");
    if (numeric(row.ordered_units) && numeric(row.received_units) && Number(row.received_units) > Number(row.ordered_units)) errors.push(`执行回执第 ${row._row || "?"} 行：已收数量不能超过下单量。`);
    if (filled(row.receipt_date) ? !validDate(row.receipt_date) || row.receipt_date <= asOf || row.receipt_date > observedThrough || Number(row.received_units) === 0 : Number(row.received_units) > 0) errors.push(`执行回执第 ${row._row || "?"} 行：收货日期与已收数量不一致。`);
    const id = String(row.po_id || "").trim();
    if (id) {
      const key = `${id}\u001f${row.location}\u001f${row.sku}`;
      if (executions.has(key)) errors.push(`执行回执第 ${row._row || "?"} 行：PO、门店与 SKU 重复。`);
      executions.add(key);
    }
  }
  if ((dataset.executions || []).length && !(dataset.actuals || []).length) warnings.push("只有执行回执，没有后续实际销量；无法比较预测与实际或模拟缺口与观测缺口。");
  return { errors, warnings };
}

export function summarizeOperationalEvidence(dataset, plan, scenarioId, items, horizon = 14) {
  const asOf = plan.result.summary.asOf, selected = new Map(items.map((item) => [item.key, item]));
  const products = new Map((dataset.products || []).map((row) => [String(row.sku), row]));
  const available = items.filter((item) => item.stockBasis === "available_units").length;
  const skus = new Set(items.map((item) => item.sku));
  const supplierLead = [...skus].filter((sku) => Number(products.get(sku)?.lead_time_days) > 0).length;
  const moq = [...skus].filter((sku) => Number(products.get(sku)?.min_order_qty) > 0).length;
  const openPo = (dataset.inbound || []).filter((row) => selected.has(keyOf(row.location, row.sku)) && row.eta > asOf);
  const promotions = (dataset.promotions || []).filter((row) => selected.has(keyOf(row.location, row.sku)) && row.end_date > asOf && row.start_date <= addDays(asOf, horizon));
  const actuals = (dataset.actuals || []).filter((row) => selected.has(keyOf(row.location, row.sku)) && daysBetween(asOf, row.date) >= 1 && daysBetween(asOf, row.date) <= horizon);
  const executions = (dataset.executions || []).filter((row) => row.scenario_id === scenarioId && selected.has(keyOf(row.location, row.sku)));
  let compared = 0, censored = 0, missingForecast = 0, forecastAbs = 0, forecastError = 0, observedDemand = 0, exposedHours = 0, openHours = 0;
  const byPromotion = { promoted: { count: 0, abs: 0, error: 0, demand: 0 }, regular: { count: 0, abs: 0, error: 0, demand: 0 } };
  let gapCompared = 0, simulatedGap = 0, observedGap = 0;
  for (const row of actuals) {
    const item = selected.get(keyOf(row.location, row.sku)), day = daysBetween(asOf, row.date);
    const out = Number(row.out_of_stock_hours), open = Number(row.open_hours);
    exposedHours += out; openHours += open;
    const unmetKnown = filled(row.observed_unmet_units);
    if (open === 0 || out > 0 && !unmetKnown) { censored++; continue; }
    const expected = item?.demandProfile?.[day - 1];
    if (!Number.isFinite(expected)) { missingForecast++; continue; }
    const demand = Number(row.sold_units) + (unmetKnown ? Number(row.observed_unmet_units) : 0);
    const error = Math.abs(expected - demand);
    forecastAbs += error; forecastError += expected - demand; observedDemand += demand; compared++;
    const promoted = promotions.some((promotion) => promotion.location === row.location && promotion.sku === row.sku && promotion.start_date <= row.date && promotion.end_date >= row.date);
    const group = promoted ? byPromotion.promoted : byPromotion.regular;
    group.count++; group.abs += error; group.error += expected - demand; group.demand += demand;
    if (unmetKnown && item?.proposed?.path?.[day - 1]) {
      const cumulative = item.proposed.path[day - 1].unmet;
      const previous = day > 1 ? item.proposed.path[day - 2].unmet : 0;
      simulatedGap += Math.max(0, cumulative - previous);
      observedGap += Number(row.observed_unmet_units); gapCompared++;
    }
  }
  const suggestedOnMatched = sum([...new Set(executions.map((row) => keyOf(row.location, row.sku)))].map((key) => selected.get(key)?.allocatedQty || 0));
  const ordered = sum(executions.map((row) => Number(row.ordered_units)));
  const received = sum(executions.map((row) => Number(row.received_units)));
  const datedReceipts = executions.filter((row) => filled(row.receipt_date));
  const onTime = datedReceipts.filter((row) => row.receipt_date <= row.eta).length;
  return {
    rows: { openPo: openPo.length, promotions: promotions.length, actuals: actuals.length, executions: executions.length },
    coverage: { items: items.length, available, skus: skus.size, supplierLead, moq },
    forecast: { compared, censored, missingForecast, wape: compared && observedDemand >= 10 ? forecastAbs / observedDemand * 100 : null,
      bias: compared && observedDemand >= 10 ? forecastError / observedDemand * 100 : null, observedDemand,
      byPromotion: Object.fromEntries(Object.entries(byPromotion).map(([name, group]) => [name, { count: group.count,
        wape: group.demand >= 10 ? group.abs / group.demand * 100 : null,
        bias: group.demand >= 10 ? group.error / group.demand * 100 : null }])) },
    exposure: { openHours, outOfStockHours: exposedHours, rate: openHours ? exposedHours / openHours * 100 : null },
    gap: { compared: gapCompared, simulated: simulatedGap, observed: observedGap },
    execution: { suggestedOnMatched, ordered, received, matchedItems: new Set(executions.map((row) => keyOf(row.location, row.sku))).size, datedReceipts: datedReceipts.length, onTime },
  };
}
