import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyze, addDays, categoryForecast, forecastModels, lineKey, parseUpload, simulate, toCSV } from "../docs/engine.mjs";
import { buildPlanning, buildDemandProfiles, chosenFuture, classifyScopeFacts, scopedItems, summarizeScenario } from "../docs/planning.mjs";
import { summarizeOperationalEvidence, validateOperationalEvidence } from "../docs/operational-evidence.mjs";
import { bindSyntheticEvidence, createSyntheticCase, SYNTHETIC_CASE_VERSION } from "../docs/synthetic-case.mjs";

const demo = JSON.parse(readFileSync(new URL("../docs/demo.json", import.meta.url), "utf8"));
const plan = buildPlanning(demo, { horizon: 28, leadTime: 14, reviewDays: 7, bufferDays: 7, serviceLevel: 95 });
const result = plan.result;
assert.equal(result.fatal, null);
assert.equal(result.summary.asOf, "2026-04-24");
assert.equal(result.summary.locations, 20);
assert.equal(plan.prepared.categories.length, 9);
assert.deepEqual(plan.prepared.majorCategories, ["Femme Footwear", "Junior Apparel", "Scholar Footwear"]);
assert.equal(plan.prepared.categoriesByMajor["Junior Apparel"].length, 3);
assert(plan.skuFacts.every((fact) => plan.prepared.categoriesByMajor[fact.majorCategory].includes(fact.category)));
const juniorFacts = plan.skuFacts.filter((fact) => fact.majorCategory === "Junior Apparel");
const juniorItems = scopedItems(result, "", "", "Junior Apparel");
assert(juniorFacts.length > 300 && juniorFacts.some((fact) => fact.sales28 > 0), "Junior Apparel must have real observed sales");
assert(juniorItems.some((item) => item.stock > 0) && juniorItems.every((item) => item.majorCategory === "Junior Apparel"), "major-level PSI must use only Junior Apparel stock");
const juniorPortfolio = classifyScopeFacts(juniorFacts);
assert(juniorPortfolio.some((fact, index) => fact.abc !== juniorFacts[index].abc), "ABC must be recalculated at major-category scope");
assert(juniorPortfolio.every((fact) => ["A", "B", "C"].includes(fact.abc)));
assert.equal(juniorFacts.reduce((total, fact) => total + fact.sales28, 0), Math.round(juniorItems.reduce((total, item) => total + item.recent28, 0)));
assert(plan.skuFacts.length > 1000);
assert(plan.skuFacts.some((fact) => fact.evidence.wape !== null), "SKU-level model comparison must be available for sufficiently active products");
assert(plan.skuFacts.some((fact) => fact.xyz === "N"), "sparse SKU demand must remain unclassified");
assert(plan.skuFacts.some((fact) => fact.xyz === "X" || fact.xyz === "Y" || fact.xyz === "Z"), "ABC–XYZ must classify supported products");
assert(plan.skuFacts.every((fact) => ["A", "B", "C"].includes(fact.abc) && ["X", "Y", "Z", "N"].includes(fact.xyz)));
for (const evidence of Object.values(plan.prepared.categoryEvidence)) if (evidence.wape !== null) {
  assert.equal(evidence.rollingWindows.length, 3);
  assert.equal(evidence.selectionWindows.length, 2);
  assert.equal(evidence.holdoutWindow.phase, "untouched_test");
  assert(evidence.selectionWindows.every((window) => window.phase === "selection" && window.end < evidence.holdoutWindow.start));
  assert.equal(evidence.holdoutActual.length, 28);
  assert.equal(Object.keys(evidence.models).length, forecastModels.length);
  for (const { id } of forecastModels) {
    assert.equal(evidence.models[id].backtest.length, 28);
    assert.equal(typeof evidence.models[id].selectionWape, "number");
    assert.equal(evidence.models[id].future.length, 14);
    assert(evidence.models[id].future.every((value) => Number.isFinite(value) && value >= 0));
  }
  assert.equal(evidence.future.length, 14);
}
const seasonal = Array.from({ length: 168 }, (_, index) => 15 + (index % 7 === 5 ? 8 : 0) + Math.floor(index / 28));
const seasonalEvidence = categoryForecast(seasonal, "2026-01-01");
assert.equal(seasonalEvidence.models.holtWinters.future.length, 14);
assert(seasonalEvidence.models.holtWinters.wape < 25, "Holt-Winters should capture a stable weekly pattern");
const alteredHoldout = [...seasonal];
for (let index = 140; index < 168; index++) alteredHoldout[index] += 20;
const alteredEvidence = categoryForecast(alteredHoldout, "2026-01-01");
assert.equal(alteredEvidence.method, seasonalEvidence.method, "independent test actuals must not select a model");
assert.equal(alteredEvidence.selectionWape, seasonalEvidence.selectionWape);
for (const { id } of forecastModels) assert.deepEqual(alteredEvidence.models[id].backtest, seasonalEvidence.models[id].backtest,
  `${id} must not read any independent test actuals`);
assert.notEqual(alteredEvidence.wape, seasonalEvidence.wape, "independent test metrics must react to actual outcomes");
assert(result.summary.blocked > 0, "public sample must reveal missing stock");
assert(result.summary.stockout > 0, "public sample must expose simulated gaps");
assert.equal(result.summary.items, result.items.length);
assert.equal(result.summary.items, ["blocked", "expedite", "stockout", "replenish", "overstock", "normal"].reduce((total, kind) => total + result.items.filter((item) => item.kind === kind).length, 0));

for (const item of result.items) {
  if (item.blocker) {
    assert.equal(item.proposed, null, "unknown or invalid stock cannot become a proposal");
    assert.equal(item.allocatedQty, 0);
    continue;
  }
  assert(item.stock >= 0);
  assert(item.proposed.closing >= 0);
  assert(item.proposed.unmet >= 0);
  const arriving = item.inbound.filter((line) => line.eta > result.summary.asOf && line.eta <= addDays(result.summary.asOf, 28)).reduce((total, line) => total + line.units, 0);
  const ordered = item.leadTime <= 28 ? item.allocatedQty : 0;
  const balance = item.stock + arriving + ordered - item.proposed.fulfilled;
  assert(Math.abs(balance - item.proposed.closing) < 0.15, `stock conservation failed for ${item.key}`);
}

const capacity = analyze(demo, { horizon: 28, leadTime: 14, maxOrderUnits: 50 });
assert(capacity.summary.allocatedUnits <= 50, "capacity must cap total allocated units");
assert(capacity.summary.requestedUnits >= capacity.summary.allocatedUnits);

const activeSku = [...plan.skuFacts].sort((a, b) => b.sales28 - a.sales28)[0];
const profiles = buildDemandProfiles(plan.prepared, "auto", 28);
const mappedForecast = plan.skuFacts.reduce((total, fact) => total + fact.forecast14 - fact.unmappedForecast14, 0);
const allocatedForecast = [...profiles.values()].reduce((total, profile) => total + profile.slice(0, 14).reduce((a, b) => a + b, 0), 0);
assert(Math.abs(mappedForecast - allocatedForecast) < 0.2, "unmapped demand must be exposed instead of silently disappearing from PSI");
assert(plan.skuFacts.some((fact) => fact.unmappedForecast14 > 0 && fact.action.label === "核查 SKU 范围"));
const plannedByStore = [...profiles].filter(([key]) => key.endsWith(`\u001f${activeSku.sku}`)).map(([, profile]) => profile);
for (let day = 0; day < 14; day++) {
  const allocated = plannedByStore.reduce((total, profile) => total + profile[day], 0);
  assert(Math.abs(allocated - chosenFuture(activeSku.evidence)[day]) < 0.05, "SKU forecast must reconcile to its store allocation");
}
const lowService = buildPlanning(demo, { horizon: 14, leadTime: 14, serviceLevel: 90 }, "auto", { facts: false });
const highService = buildPlanning(demo, { horizon: 14, leadTime: 14, serviceLevel: 98 }, "auto", { facts: false });
assert(highService.result.summary.allocatedUnits >= lowService.result.summary.allocatedUnits, "higher service target cannot lower unconstrained order quantity");
assert(highService.result.summary.proposedUnmet <= lowService.result.summary.proposedUnmet + 0.1, "higher service target cannot worsen demand served without a capacity constraint");
assert(highService.result.summary.allocatedUnits > lowService.result.summary.allocatedUnits && Math.abs(highService.result.summary.proposedUnmet - lowService.result.summary.proposedUnmet) < 0.1,
  "demo's late-receipt negative result must remain visible: more stock without improvement inside the horizon");
const forcedRidge = buildPlanning(demo, { horizon: 14, leadTime: 14, serviceLevel: 95 }, "ridge");
assert(Math.abs(sumForecast(forcedRidge.skuFacts) - sumForecast(plan.skuFacts)) > 0.1, "model choice must change SKU demand forecasts");
const forcedHolt = buildPlanning(demo, { horizon: 14, leadTime: 14, serviceLevel: 95 }, "holtWinters");
assert(Math.abs(sumForecast(forcedHolt.skuFacts) - sumForecast(plan.skuFacts)) > 0.1, "Holt-Winters selection must change the PSI demand input");
const scoped = result.items.filter((item) => lineKey(item.majorCategory, item.category) === plan.prepared.categories[0]);
const scenario = summarizeScenario(scoped, 28);
assert(Math.abs(scenario.stock + scenario.inbound + scenario.arrivingOrders - scenario.fulfilled - scenario.closing) < 1, "PSI roll-up must conserve units");

const asOf = "2026-10-01";
const sales = Array.from({ length: 84 }, (_, index) => ({ date: addDays(asOf, index - 83), location: "Store A", sku: "SKU A", units: 2, net_sales: 20, cogs: 8 }));
sales.push({ date: asOf, location: "Store A", sku: "SKU B", units: 3, net_sales: 30, cogs: 12 });
const synthetic = {
  schemaVersion: 1,
  meta: { mode: "uploaded", inboundConfirmed: true },
  sales,
  inventory: [
    { as_of: asOf, location: "Store A", sku: "SKU A", on_hand: 2 },
    { as_of: asOf, location: "Store A", sku: "SKU C", on_hand: 5 },
    { as_of: asOf, location: "Store A", sku: "SKU C", on_hand: 5 },
  ],
  products: [
    { sku: "SKU A", major_category: "Test Major", category: "Test", name: "A", lead_time_days: 4, case_pack: 3, min_order_qty: 6 },
    { sku: "SKU B", major_category: "Test Major", category: "Test", name: "B" },
    { sku: "SKU C", major_category: "Test Major", category: "Test", name: "C" },
  ],
  inbound: [
    { eta: "2026-09-30", location: "Store A", sku: "SKU A", units: 100 },
    { eta: "2026-10-05", location: "Store A", sku: "SKU A", units: 4 },
  ],
};
const custom = analyze(synthetic, { horizon: 14, leadTime: 7 });
assert.equal(custom.fatal, null);
assert.equal(custom.items.find((item) => item.sku === "SKU B").kind, "blocked");
assert.equal(custom.items.find((item) => item.sku === "SKU C").kind, "blocked");
assert.equal(custom.items.find((item) => item.sku === "SKU A").inboundDue, 4, "overdue receipts cannot be counted");
assert.equal(custom.items.find((item) => item.sku === "SKU A").requestedQty % 3, 0, "case pack must be respected");
assert(custom.issues.some((issue) => issue.code === "inbound_overdue"));
const sharedLine = {
  meta: { mode: "uploaded", inboundConfirmed: true },
  products: [
    { sku: "A-1", major_category: "Major A", category: "Basics", name: "A" },
    { sku: "B-1", major_category: "Major B", category: "Basics", name: "B" },
  ],
  inventory: [
    { as_of: asOf, location: "Store A", sku: "A-1", on_hand: 5 },
    { as_of: asOf, location: "Store A", sku: "B-1", on_hand: 5 },
  ],
  sales: [
    { date: asOf, location: "Store A", sku: "A-1", units: 2, net_sales: 20, cogs: 8 },
    { date: asOf, location: "Store A", sku: "B-1", units: 5, net_sales: 50, cogs: 20 },
  ],
  inbound: [],
};
const sharedPlan = buildPlanning(sharedLine, { horizon: 14, leadTime: 7, serviceLevel: 95 });
assert.equal(sharedPlan.prepared.categories.length, 2, "same line label in different majors must remain two lines");
assert.equal(sharedPlan.prepared.categoryDaily.get(lineKey("Major A", "Basics")).at(-1), 2);
assert.equal(sharedPlan.prepared.categoryDaily.get(lineKey("Major B", "Basics")).at(-1), 5);
assert.equal(sharedPlan.prepared.categoryEvidence[lineKey("Major A", "Basics")].holdoutActual.at(-1), 2);
assert.equal(sharedPlan.prepared.categoryEvidence[lineKey("Major B", "Basics")].holdoutActual.at(-1), 5);
assert(sharedPlan.skuFacts.every((fact) => fact.abc === "A"), "ABC must be classified separately within each major and line");
const missingStock = analyze({ ...synthetic, inventory: [{ as_of: asOf, location: "Store A", sku: "SKU A", on_hand: "" }] }, { horizon: 14 });
assert(missingStock.issues.some((issue) => issue.code === "inventory_invalid"), "blank stock must not become zero");
assert.equal(missingStock.items.find((item) => item.sku === "SKU A").kind, "blocked");
const sellable = { ...synthetic, inventory: [{ as_of: asOf, location: "Store A", sku: "SKU A", on_hand: 20, available_units: 3, unit_cost: 5 }] };
const sellablePlan = buildPlanning(sellable, { horizon: 14, leadTime: 7 });
const sellableItem = sellablePlan.result.items.find((item) => item.sku === "SKU A");
assert.equal(sellableItem.stock, 3, "PSI must use available units when supplied");
assert.equal(sellableItem.physicalOnHand, 20, "physical stock must be retained for valuation");
assert.equal(sellablePlan.skuFacts.find((fact) => fact.sku === "SKU A").stockValue, 100, "inventory value must use physical on-hand");
const invalidSellable = analyze({ ...sellable, inventory: [{ as_of: asOf, location: "Store A", sku: "SKU A", on_hand: 20, available_units: 21 }] });
assert(invalidSellable.issues.some((issue) => issue.code === "available_invalid"));
assert.equal(invalidSellable.items.find((item) => item.sku === "SKU A").kind, "blocked");
const missingMoney = analyze({ ...synthetic, sales: [{ date: asOf, location: "Store A", sku: "SKU A", units: 2, net_sales: "", cogs: 8 }] }, { horizon: 14 });
assert(missingMoney.issues.some((issue) => issue.code === "sales_invalid"), "blank revenue must not become zero");
assert.throws(() => parseUpload("sales", "date,location,sku,units\n2026-10-01,Store A,SKU A,2\n"), /net_sales, cogs/);

const parsed = parseUpload("products", '\uFEFFsku,major_category,category,name\r\nABC,Footwear,"Outdoor, Shoes","Trail ""Runner"""\r\n');
assert.deepEqual(parsed[0], { sku: "ABC", major_category: "Footwear", category: "Outdoor, Shoes", name: 'Trail "Runner"', _row: 2 });
assert.throws(() => parseUpload("products", "sku,category,name\nABC,Test,Runner\n"), /major_category/);
assert(toCSV([["=danger", "safe"]]).includes("'=danger"), "CSV formula should be neutralized");
const simulated = simulate(0, 1, asOf, 7, [{ eta: addDays(asOf, 2), units: 3 }], 2, 5);
assert.equal(simulated.unmet, 2);
assert.equal(simulated.closing, 0);
const daily = simulate(3, [1, 2, 0], asOf, 3, []);
assert.equal(daily.closing, 0);
assert.equal(daily.unmet, 0);

const actuals = Array.from({ length: 5 }, (_, index) => ({ date: addDays(asOf, index + 1), location: "Store A", sku: "SKU A",
  sold_units: 3, open_hours: 10, out_of_stock_hours: 0, observed_unmet_units: "" }));
actuals.push({ date: addDays(asOf, 6), location: "Store A", sku: "SKU A", sold_units: 1, open_hours: 10, out_of_stock_hours: 4, observed_unmet_units: "" });
actuals.push({ date: addDays(asOf, 7), location: "Store A", sku: "SKU A", sold_units: 1, open_hours: 10, out_of_stock_hours: 2, observed_unmet_units: 2 });
const operational = { ...sellable, promotions: [{ promo_id: "P1", start_date: addDays(asOf, 2), end_date: addDays(asOf, 4), location: "Store A", sku: "SKU A" }],
  actuals, executions: [{ scenario_id: "SCN-TEST", location: "Store A", sku: "SKU A", ordered_units: 6, eta: addDays(asOf, 8), received_units: 4,
    receipt_date: addDays(asOf, 7), po_id: "PO-1" }] };
assert.deepEqual(validateOperationalEvidence(operational, asOf, "2026-10-14").errors, []);
const evidence = summarizeOperationalEvidence(operational, sellablePlan, "SCN-TEST", [sellableItem], 14);
assert.equal(evidence.forecast.compared, 6);
assert.equal(evidence.forecast.censored, 1, "stockout sales without measured unmet must be excluded");
assert(Number.isFinite(evidence.forecast.wape));
assert(Number.isFinite(evidence.forecast.bias));
assert.equal(evidence.forecast.byPromotion.promoted.count, 3);
assert.equal(evidence.forecast.byPromotion.regular.count, 3);
assert.equal(evidence.forecast.byPromotion.promoted.wape, null, "low-volume promotion subgroup must be inconclusive");
assert.equal(evidence.forecast.byPromotion.regular.bias, null, "low-volume regular subgroup must be inconclusive");
assert.equal(evidence.gap.compared, 1);
assert.equal(evidence.execution.ordered, 6);
assert.equal(evidence.execution.received, 4);
assert.equal(evidence.execution.onTime, 1);
assert.equal(evidence.rows.promotions, 1);
assert.equal(summarizeOperationalEvidence(operational, sellablePlan, "OTHER", [sellableItem], 14).execution.matchedItems, 0, "execution must match the scenario ID");
assert(validateOperationalEvidence({ ...operational, actuals: [{ ...actuals[0], out_of_stock_hours: 11 }] }, asOf, "2026-10-14").errors.length > 0);
assert(validateOperationalEvidence({ ...operational, actuals: [{ ...actuals[0], date: "2026-10-15" }] }, asOf, "2026-10-14").errors.length > 0,
  "future-dated observations must not be treated as actuals");

const syntheticCase = createSyntheticCase("2026-10-07");
assert.equal(syntheticCase.plan.meta.syntheticVersion, SYNTHETIC_CASE_VERSION);
assert(syntheticCase.plan.products.every((product) => !demo.products.some((real) => real.sku === product.sku)), "synthetic case must use separate SKUs");
const syntheticPlan = buildPlanning(syntheticCase.plan, { horizon: 14, leadTime: 14, reviewDays: 7, bufferDays: 7, maxOrderUnits: 0, serviceLevel: 95 });
assert.equal(syntheticPlan.result.fatal, null);
const syntheticData = bindSyntheticEvidence(syntheticCase.plan, syntheticCase.evidence, "SCN-SYNTHETIC");
assert.deepEqual(validateOperationalEvidence(syntheticData, "2026-10-07", "2026-10-14").errors, []);
const syntheticFootwear = syntheticPlan.result.items.filter((item) => item.majorCategory === "Synthetic Footwear");
const syntheticReport = summarizeOperationalEvidence(syntheticData, syntheticPlan, "SCN-SYNTHETIC", syntheticFootwear, 14);
assert.equal(syntheticReport.forecast.compared, 13);
assert.equal(syntheticReport.forecast.censored, 1, "unmeasured stockout must stay out of forecast error");
assert(syntheticReport.forecast.byPromotion.promoted.wape > syntheticReport.forecast.byPromotion.regular.wape);
assert(syntheticReport.forecast.bias < 0, "teaching case must expose forecast underestimation");
assert(syntheticReport.execution.suggestedOnMatched > syntheticReport.execution.ordered);
assert(syntheticReport.execution.ordered > syntheticReport.execution.received);
assert.equal(syntheticReport.execution.onTime, 0, "synthetic receipt must miss ETA");
assert.equal(syntheticReport.gap.simulated, 0);
assert.equal(syntheticReport.gap.observed, 3);
assert.equal(summarizeOperationalEvidence(syntheticData, syntheticPlan, "OTHER", syntheticFootwear, 14).execution.matchedItems, 0);

console.log(`Planning workbench checks passed: ${plan.prepared.categories.length} product lines, ${plan.skuFacts.length} SKUs, ${result.summary.items} store×SKU items; forecast, ABC–XYZ, PSI, capacity and CSV contracts verified.`);

function sumForecast(facts) { return facts.reduce((total, fact) => total + fact.forecast14, 0); }
