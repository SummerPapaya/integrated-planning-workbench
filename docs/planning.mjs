import { addDays, analyze, categoryForecast, daysBetween, forecastModels, lineKey, validDate } from "./engine.mjs";

const cache = new WeakMap();
const sum = (values) => values.reduce((total, value) => total + value, 0);
const round = (value, places = 2) => Number(value.toFixed(places));
const keyOf = (location, sku) => `${location}\u001f${sku}`;

export const modelLabels = { auto: "选模期择优", ...Object.fromEntries(forecastModels.map(({ id, label }) => [id, label])) };

export function chosenFuture(evidence, policy = "auto") {
  if (!evidence) return Array(14).fill(0);
  return policy !== "auto" && evidence.models?.[policy]?.future ? evidence.models[policy].future : evidence.future;
}

export function chosenModel(evidence, policy = "auto") {
  return policy !== "auto" && evidence?.models?.[policy] ? policy : evidence?.method || "average28";
}

export function preparePlanning(dataset) {
  if (cache.has(dataset)) return cache.get(dataset);
  const asOf = (dataset.inventory || []).map((row) => row.as_of).filter(validDate).sort().at(-1);
  if (!asOf) return { fatal: "库存文件没有有效 as_of 日期" };
  const startDate = addDays(asOf, -167), length = 168;
  const products = new Map();
  for (const row of dataset.products || []) if (String(row.sku || "").trim()) products.set(String(row.sku).trim(), {
    sku: String(row.sku).trim(), name: String(row.name || row.sku), category: String(row.category || "未归类"),
    majorCategory: String(row.major_category || "未分大类"),
  });
  const skuDaily = new Map(), categoryDaily = new Map(), majorDaily = new Map(), byStore56 = new Map(), byStore168 = new Map(), locationsBySku = new Map();
  function series(map, key) { if (!map.has(key)) map.set(key, Array(length).fill(0)); return map.get(key); }
  function location(sku, store) { if (!locationsBySku.has(sku)) locationsBySku.set(sku, new Set()); locationsBySku.get(sku).add(store); }
  for (const row of dataset.inventory || []) if (row.as_of === asOf && row.sku && row.location) {
    const sku = String(row.sku);
    if (!products.has(sku)) products.set(sku, { sku, name: sku, category: "未归类", majorCategory: "未分大类" });
    location(sku, String(row.location));
  }
  for (const row of dataset.inbound || []) if (row.sku && row.location) location(String(row.sku), String(row.location));
  for (const row of dataset.sales || []) {
    const sku = String(row.sku || ""), store = String(row.location || ""), day = row.date, units = Number(row.units);
    if (!sku || !store || !validDate(day) || !Number.isFinite(units) || units <= 0) continue;
    const age = daysBetween(day, asOf);
    if (age < 0 || age >= length) continue;
    if (!products.has(sku)) products.set(sku, { sku, name: sku, category: "未归类", majorCategory: "未分大类" });
    const { category, majorCategory } = products.get(sku), index = length - age - 1;
    series(skuDaily, sku)[index] += units;
    series(categoryDaily, lineKey(majorCategory, category))[index] += units;
    series(majorDaily, majorCategory)[index] += units;
    if (age < 28) location(sku, store);
    const key = keyOf(store, sku);
    byStore168.set(key, (byStore168.get(key) || 0) + units);
    if (age < 56) byStore56.set(key, (byStore56.get(key) || 0) + units);
  }
  const categories = [...new Set([...products.values()].map((product) => lineKey(product.majorCategory, product.category)))].sort();
  const preferredMajors = ["Femme Footwear", "Junior Apparel", "Scholar Footwear"];
  const majorCategories = [...new Set([...products.values()].map((product) => product.majorCategory))].sort((a, b) =>
    (preferredMajors.indexOf(a) < 0 ? preferredMajors.length : preferredMajors.indexOf(a)) -
    (preferredMajors.indexOf(b) < 0 ? preferredMajors.length : preferredMajors.indexOf(b)) || a.localeCompare(b));
  const categoriesByMajor = Object.fromEntries(majorCategories.map((major) => [major,
    [...new Set([...products.values()].filter((product) => product.majorCategory === major).map((product) => product.category))].sort()]));
  const categoryEvidence = Object.fromEntries(categories.map((category) => [category, categoryForecast(categoryDaily.get(category) || Array(length).fill(0), startDate, 14)]));
  const majorEvidence = Object.fromEntries(majorCategories.map((major) => [major, categoryForecast(majorDaily.get(major) || Array(length).fill(0), startDate, 14)]));
  const skuEvidence = new Map([...products.keys()].map((sku) => [sku, categoryForecast(skuDaily.get(sku) || Array(length).fill(0), startDate, 14)]));
  const prepared = { asOf, startDate, products, categories, majorCategories, categoriesByMajor, skuDaily, categoryDaily, majorDaily, categoryEvidence, majorEvidence, skuEvidence, byStore56, byStore168, locationsBySku, profileCache: new Map() };
  cache.set(dataset, prepared);
  return prepared;
}

export function buildDemandProfiles(prepared, policy = "auto", horizon = 14) {
  const cacheKey = `${policy}:${horizon}`;
  if (prepared.profileCache?.has(cacheKey)) return prepared.profileCache.get(cacheKey);
  const profiles = new Map();
  for (const [sku, evidence] of prepared.skuEvidence) {
    const locations = [...(prepared.locationsBySku.get(sku) || [])];
    if (!locations.length) continue;
    const recent = locations.map((location) => prepared.byStore56.get(keyOf(location, sku)) || 0);
    const older = locations.map((location) => prepared.byStore168.get(keyOf(location, sku)) || 0);
    const weights = sum(recent) > 0 ? recent : sum(older) > 0 ? older : locations.map(() => 1);
    const denominator = sum(weights);
    const future = chosenFuture(evidence, policy);
    for (let index = 0; index < locations.length; index++) {
      const share = weights[index] / denominator;
      const profile = Array.from({ length: horizon }, (_, day) => round((future[day] ?? future[7 + (day - 14) % 7] ?? 0) * share, 4));
      profiles.set(keyOf(locations[index], sku), profile);
    }
  }
  prepared.profileCache?.set(cacheKey, profiles);
  return profiles;
}

function xyzClass(series) {
  const recent = series.slice(-84), weeks = Array.from({ length: 12 }, (_, index) => sum(recent.slice(index * 7, index * 7 + 7)));
  const total = sum(weeks), active = weeks.filter((value) => value > 0).length;
  if (total < 8 || active < 3) return { grade: "N", cv: null, activeWeeks: active };
  const mean = total / 12, variance = sum(weeks.map((value) => (value - mean) ** 2)) / 12, cv = Math.sqrt(variance) / mean;
  return { grade: cv <= .5 ? "X" : cv <= 1 ? "Y" : "Z", cv: round(cv, 2), activeWeeks: active };
}

export function buildSkuFacts(prepared, result, policy = "auto") {
  const grouped = new Map();
  for (const item of result.items) {
    if (!grouped.has(item.sku)) grouped.set(item.sku, []);
    grouped.get(item.sku).push(item);
  }
  const facts = [...prepared.products.values()].map((product) => {
    const items = grouped.get(product.sku) || [], evidence = prepared.skuEvidence.get(product.sku);
    const sales28 = sum(items.map((item) => item.recent28)), returnUnits28 = sum(items.map((item) => item.returnUnits28 || 0));
    const netSales28 = sum(items.map((item) => item.netSales28 || 0)), cogs28 = sum(items.map((item) => item.cogs28 || 0));
    const valid = items.filter((item) => !item.blocker);
    const stock = sum(valid.map((item) => item.stock));
    const stockWithCost = valid.filter((item) => item.unitCost !== null);
    const stockValue = sum(stockWithCost.map((item) => item.physicalOnHand * item.unitCost));
    const riskStores = items.filter((item) => item.kind === "expedite" || item.kind === "stockout").length;
    const overstockStores = items.filter((item) => item.kind === "overstock").length;
    const blockedStores = items.filter((item) => item.kind === "blocked").length;
    const xyz = xyzClass(prepared.skuDaily.get(product.sku) || Array(168).fill(0));
    const forecast14 = round(sum(chosenFuture(evidence, policy)), 3);
    const hasPlanningLocation = (prepared.locationsBySku.get(product.sku)?.size || 0) > 0;
    return { ...product, items, evidence, sales28: round(sales28), returnUnits28: round(returnUnits28),
      netSales28: round(netSales28), cogs28: round(cogs28), grossMargin28: round(netSales28 - cogs28),
      stock: round(stock), stockValue: round(stockValue), costCoverage: valid.length ? stockWithCost.length / valid.length : 0,
      riskStores, overstockStores, blockedStores, forecast14, unmappedForecast14: hasPlanningLocation ? 0 : forecast14,
      xyz: xyz.grade, cv: xyz.cv, activeWeeks: xyz.activeWeeks };
  });
  for (const category of prepared.categories) assignPortfolioClasses(facts.filter((fact) => lineKey(fact.majorCategory, fact.category) === category));
  return facts;
}

function assignPortfolioClasses(facts) {
  const group = [...facts].sort((a, b) => Math.max(0, b.netSales28) - Math.max(0, a.netSales28));
  const total = sum(group.map((fact) => Math.max(0, fact.netSales28)));
  let cumulative = 0;
  for (const fact of group) {
    fact.abc = total <= 0 || fact.netSales28 <= 0 ? "C" : cumulative / total < .8 ? "A" : cumulative / total < .95 ? "B" : "C";
    cumulative += Math.max(0, fact.netSales28);
    fact.returnRate = fact.sales28 > 0 ? round(fact.returnUnits28 / fact.sales28 * 100, 1) : 0;
    fact.action = actionFor(fact);
    fact.priority = (fact.abc === "A" ? 40 : fact.abc === "B" ? 20 : 0) + fact.riskStores * 24 + fact.blockedStores * 15 + fact.overstockStores * 5 + (fact.unmappedForecast14 > 0 ? 30 : 0) +
      (fact.returnRate >= 15 ? 12 : 0) + Math.min(20, Math.max(0, fact.netSales28) / Math.max(1, total) * 200);
  }
}

export function classifyScopeFacts(facts) {
  const scoped = facts.map((fact) => ({ ...fact }));
  assignPortfolioClasses(scoped);
  return scoped;
}

function actionFor(fact) {
  if (fact.unmappedForecast14 > 0) return { label: "核查 SKU 范围", reason: "模型仍有需求，但当前无库存、近 28 天销售或在途门店可映射到 PSI；核实是否停售或缺少快照。" };
  if (fact.riskStores && fact.overstockStores) return { label: "核对跨店调拨", reason: "同 SKU 同时出现在缺口与高库存门店；先核实可售量、运输时间及调拨权限。" };
  if (fact.riskStores) return { label: "复核补货 / 催交", reason: "部分门店在当前需求与交期情景中有预计缺口；核对真实在途与供应商承诺。" };
  if (fact.blockedStores) return { label: "修复库存数据", reason: "存在缺失、重复或负库存，相关门店的补货建议已阻断。" };
  if (fact.returnRate >= 15 && fact.sales28 >= 5) return { label: "复盘退货原因", reason: "退货件数相对正向销售偏高；核对质量、尺码和退货口径。" };
  if (fact.overstockStores && fact.abc === "C") return { label: "评估去化方案", reason: "低销售贡献且存在高库存门店；结合季节、促销和毛利计划判断。" };
  if (fact.overstockStores) return { label: "检查库存结构", reason: "部分门店覆盖过高或近 28 天未售；核对陈列保底与后续活动。" };
  return { label: "按计划监测", reason: "当前输入与假设下未发现高优先级库存例外；继续观察需求波动。" };
}

export function buildPlanning(dataset, config = {}, policy = "auto", { facts = true } = {}) {
  const prepared = preparePlanning(dataset);
  if (prepared.fatal) return { prepared, result: { fatal: prepared.fatal } };
  const demandProfiles = buildDemandProfiles(prepared, policy, Number(config.horizon) || 14);
  const result = analyze(dataset, { ...config, demandProfiles, categoryEvidence: prepared.categoryEvidence });
  if (result.fatal) return { prepared, result };
  const skuFacts = facts ? buildSkuFacts(prepared, result, policy) : null;
  return { prepared, result, skuFacts, policy };
}

export function scopedItems(result, category, sku = "", major = "") {
  return result.items.filter((item) => (!major || item.majorCategory === major) && (!category || item.category === category) && (!sku || item.sku === sku));
}

export function summarizeScenario(items, horizon) {
  const valid = items.filter((item) => !item.blocker && item.baseline && item.proposed);
  const baselineUnmet = sum(valid.map((item) => item.baseline.unmet));
  const proposedUnmet = sum(valid.map((item) => item.proposed.unmet));
  const orderUnits = sum(valid.map((item) => item.allocatedQty));
  const stock = sum(valid.map((item) => item.stock));
  const lastDate = valid[0]?.baseline.path.at(-1)?.date || "";
  const inbound = sum(valid.flatMap((item) => item.inbound.filter((line) => line.eta <= lastDate).map((line) => line.units)));
  const arrivingOrders = sum(valid.filter((item) => item.leadTime <= horizon).map((item) => item.allocatedQty));
  const fulfilled = sum(valid.map((item) => item.proposed.fulfilled));
  const closing = sum(valid.map((item) => item.proposed.closing));
  const orderValueKnown = sum(valid.filter((item) => item.unitCost !== null).map((item) => item.allocatedQty * item.unitCost));
  const orderValueCoverage = orderUnits ? sum(valid.filter((item) => item.unitCost !== null).map((item) => item.allocatedQty)) / orderUnits : 1;
  const baselinePath = Array.from({ length: horizon }, (_, day) => sum(valid.map((item) => item.baseline.path[day]?.stock || 0)));
  const proposedPath = Array.from({ length: horizon }, (_, day) => sum(valid.map((item) => item.proposed.path[day]?.stock || 0)));
  const baselineUnmetPath = Array.from({ length: horizon }, (_, day) => sum(valid.map((item) => item.baseline.path[day]?.unmet || 0)));
  const unmetPath = Array.from({ length: horizon }, (_, day) => sum(valid.map((item) => item.proposed.path[day]?.unmet || 0)));
  return { validCount: valid.length, blocked: items.length - valid.length, baselineUnmet: round(baselineUnmet, 1), proposedUnmet: round(proposedUnmet, 1),
    orderUnits: round(orderUnits), arrivingOrders: round(arrivingOrders), fulfilled: round(fulfilled), stock: round(stock), inbound: round(inbound), closing: round(closing), orderValueKnown: round(orderValueKnown),
    orderValueCoverage: round(orderValueCoverage * 100, 1), baselinePath, proposedPath, baselineUnmetPath, unmetPath,
    riskCount: items.filter((item) => item.kind === "expedite" || item.kind === "stockout").length };
}
