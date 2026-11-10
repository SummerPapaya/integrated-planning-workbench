import { addDays, validDate } from "./engine.mjs";

export const SYNTHETIC_CASE_VERSION = "p1-operating-cycle-v1";

// A dated, deterministic teaching fixture. Every record is invented; the date is
// shifted so its seven observed days remain valid whenever the demo is opened.
export function createSyntheticCase(asOf) {
  if (!validDate(asOf)) throw new Error("合成案例的库存快照日期无效");
  const products = [
    { sku: "SYN-RUN-01", major_category: "Synthetic Footwear", category: "Synthetic Footwear / Core", name: "Core Runner · 合成", unit_cost: 42, lead_time_days: 4, case_pack: 6, min_order_qty: 12 },
    { sku: "SYN-TEE-02", major_category: "Synthetic Apparel", category: "Synthetic Apparel / Basics", name: "Everyday Tee · 合成", unit_cost: 18, lead_time_days: 6, case_pack: 4, min_order_qty: 8 },
  ];
  const pairs = [
    { sku: "SYN-RUN-01", location: "SYN-East", base: 4, price: 79, cost: 42 },
    { sku: "SYN-RUN-01", location: "SYN-West", base: 2, price: 79, cost: 42 },
    { sku: "SYN-TEE-02", location: "SYN-East", base: 2, price: 39, cost: 18 },
    { sku: "SYN-TEE-02", location: "SYN-West", base: 1, price: 39, cost: 18 },
  ];
  const sales = [];
  for (let day = -167; day <= 0; day++) {
    for (const [index, pair] of pairs.entries()) {
      const units = Math.max(0, pair.base + ((day + index * 3 + 168) % 7 === 0 ? 1 : 0) - ((day + index + 168) % 11 === 0 ? 1 : 0));
      sales.push({ date: addDays(asOf, day), location: pair.location, sku: pair.sku,
        units, net_sales: units * pair.price, cogs: units * pair.cost });
    }
  }
  const inventory = [
    { as_of: asOf, location: "SYN-East", sku: "SYN-RUN-01", on_hand: 9, available_units: 5, unit_cost: 42 },
    { as_of: asOf, location: "SYN-West", sku: "SYN-RUN-01", on_hand: 27, available_units: 21, unit_cost: 42 },
    { as_of: asOf, location: "SYN-East", sku: "SYN-TEE-02", on_hand: 10, available_units: 8, unit_cost: 18 },
    { as_of: asOf, location: "SYN-West", sku: "SYN-TEE-02", on_hand: 16, available_units: 14, unit_cost: 18 },
  ];
  const inbound = [{ eta: addDays(asOf, 4), location: "SYN-East", sku: "SYN-RUN-01", units: 8, po_id: "SYN-PO-001" }];
  const actuals = [];
  for (let day = 1; day <= 7; day++) {
    for (const pair of pairs) {
      let sold = pair.base, out = 0, unmet = "";
      if (pair.sku === "SYN-RUN-01" && pair.location === "SYN-East") {
        if (day >= 3 && day <= 5) sold = 11;
        if (day === 6) { sold = 2; out = 4; unmet = 3; }
        if (day === 7) { sold = 1; out = 5; }
      }
      actuals.push({ date: addDays(asOf, day), location: pair.location, sku: pair.sku,
        sold_units: sold, open_hours: 10, out_of_stock_hours: out, observed_unmet_units: unmet });
    }
  }
  return {
    plan: { schemaVersion: 1, meta: { mode: "synthetic", source: "独立合成 P1 教学案例", inboundConfirmed: true,
      syntheticVersion: SYNTHETIC_CASE_VERSION }, sales, inventory, products, inbound, promotions: [], actuals: [], executions: [] },
    evidence: {
      promotions: [{ promo_id: "SYN-PROMO-01", start_date: addDays(asOf, 3), end_date: addDays(asOf, 5), location: "SYN-East", sku: "SYN-RUN-01" }],
      actuals,
      executions: [{ scenario_id: "", location: "SYN-East", sku: "SYN-RUN-01", ordered_units: 18,
        eta: addDays(asOf, 4), received_units: 12, receipt_date: addDays(asOf, 6), po_id: "SYN-PO-001" }],
    },
  };
}

export function bindSyntheticEvidence(plan, evidence, scenarioId) {
  return { ...plan, promotions: evidence.promotions, actuals: evidence.actuals,
    executions: evidence.executions.map((row) => ({ ...row, scenario_id: scenarioId })) };
}
