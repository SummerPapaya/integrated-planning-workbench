import { addDays, daysBetween, forecastModels, lineKey, parseUpload, toCSV } from "./engine.mjs";
import { buildPlanning, chosenFuture, chosenModel, classifyScopeFacts, modelLabels, scopedItems, summarizeScenario } from "./planning.mjs";
import { summarizeOperationalEvidence, validateOperationalEvidence } from "./operational-evidence.mjs";
import { bindSyntheticEvidence, createSyntheticCase, SYNTHETIC_CASE_VERSION } from "./synthetic-case.mjs";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const fmt = (value, decimals = 0) => Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
const sum = (values) => values.reduce((total, value) => total + value, 0);
const labels = { blocked: "数据阻断", expedite: "需加急", stockout: "预计缺口", replenish: "补货候选", overstock: "高库存", normal: "正常" };
const FORECAST_VERSION = "forecast-select56-test28-v1";
const PSI_VERSION = "psi-rules-v1";
const state = { dataset: null, demoData: null, plan: null, comparisons: new Map(), scopeFactsCache: new Map(), major: "", category: "", sku: "", policy: "auto", service: 95,
  view: "forecast", modelSort: "selection", chartModels: null, chartDecisionModel: "", selectedActionSku: "", segment: "", actionPage: 0, actionPageSize: 18, decisions: new Map(), notes: new Map(), dataVersion: "", demoVersion: "", evidenceVersion: "", updateMessage: "数据已载入，选择范围或切换任务开始分析。" };

const modelColors = { seasonal7: "#c1693f", moving28: "#48738d", weekday4: "#a68736", holtWinters: "#9d4d4b", linearTrend: "#668351", ridge: "#2d5557", boostedStumps: "#7a6a58" };

function mode() { return state.dataset?.meta?.mode || "demo"; }
function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function config() { return { horizon: Number($("#horizon").value), leadTime: Number($("#lead-time").value), reviewDays: Number($("#review-days").value), bufferDays: Number($("#buffer-days").value), maxOrderUnits: Number($("#max-order").value), serviceLevel: state.service }; }
function categoryFacts() {
  const key = `${state.major}\u001f${state.category}`;
  if (state.scopeFactsCache.has(key)) return state.scopeFactsCache.get(key);
  const facts = state.plan.skuFacts.filter((fact) => fact.majorCategory === state.major && (!state.category || fact.category === state.category));
  const scoped = state.category ? facts : classifyScopeFacts(facts);
  state.scopeFactsCache.set(key, scoped);
  return scoped;
}
function scopeFacts() { return categoryFacts().filter((fact) => !state.sku || fact.sku === state.sku); }
function scopeItems(plan = state.plan) { return scopedItems(plan.result, state.category, state.sku, state.major); }
function scopeEvidence() { return state.sku ? state.plan.prepared.skuEvidence.get(state.sku) : state.category ? state.plan.prepared.categoryEvidence[lineKey(state.major, state.category)] : state.plan.prepared.majorEvidence[state.major]; }
function scopeName() { return state.sku ? `${state.sku} · ${state.plan.prepared.products.get(state.sku)?.name || ""}` : state.category || state.major; }
function announceUpdate(message) {
  state.updateMessage = message;
  const target = $("#context-update");
  if (target) target.textContent = message;
}
function renderContext(facts, items) {
  const titles = { forecast: ["01 / 需求计划", "预测证据与产品需求"], psi: ["02 / 供需平衡", "PSI 情景与库存风险"],
    category: ["03 / 品类管理", "产品组合与行动决策"], data: ["DATA / 输入", "计划数据与质量门槛"],
    evidence: ["P1 / 验证", "执行证据与负结果"], review: ["REVIEW / 审批前", "人工复核与行动交付"] };
  const [viewLabel, title] = titles[state.view] || titles.forecast;
  const source = mode() === "demo" ? "Mendeley 公开样本" : mode() === "synthetic" ? "完全虚构的合成案例" : "浏览器本地 CSV";
  const level = state.sku ? "SKU" : state.category ? "产品线" : "业务大类";
  const scope = [state.major, state.category || "全部产品线", state.sku || "全部 SKU"].filter(Boolean).join(" / ");
  const stores = new Set(items.map((item) => item.location)).size;
  $("#context-view").textContent = viewLabel;
  $("#context-mode").textContent = source;
  $("#context-title").textContent = title;
  $("#context-scope").textContent = `${scope} · ${level}视角 · ${fmt(facts.length)} SKU / ${fmt(stores)} 门店`;
  $("#context-update").textContent = state.updateMessage;
  $("#scope-rail-summary").textContent = `${state.major}${state.category ? " / " + state.category : ""}${state.sku ? " / " + state.sku : ""}`;
  $("#source-rail-label").textContent = source;
  const chips = [
    ["数据截止", state.plan.prepared.asOf],
    ["模型", state.policy === "auto" ? "择优 / 守护" : modelLabels[state.policy]],
    ...(state.view === "psi" || state.view === "category" ? [["服务目标", `${state.service}% · ${config().horizon} 天`]] : [["预测窗口", "独立测试 28 天 / 未来 14 天"]]),
    [state.view === "category" ? "分层筛选" : "数据版本", state.view === "category" ? (state.segment || "全部 ABC–XYZ") : (state.dataVersion.slice(0, 8) || "待核验")],
  ];
  $("#context-chips").innerHTML = chips.map(([label, value]) => `<span class="context-chip"><small>${esc(label)}</small><strong>${esc(value)}</strong></span>`).join("");
  document.body.dataset.view = state.view;
  document.body.dataset.mode = mode();
}
async function sha256Hex(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function scenarioId() {
  const source = JSON.stringify([state.dataVersion, FORECAST_VERSION, PSI_VERSION, state.plan.prepared.asOf,
    state.major, state.category, state.sku, state.policy, config()]);
  let hash = 2166136261;
  for (const char of source) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return `SCN-${(hash >>> 0).toString(16).padStart(8, "0").toUpperCase()}`;
}
function scenarioTrace() {
  return { dataVersion: state.dataVersion, forecastVersion: FORECAST_VERSION, psiVersion: PSI_VERSION,
    scenarioId: scenarioId(), assumptions: { ...config(), policy: state.policy } };
}
function coverage() {
  const facts = scopeFacts(), items = scopeItems(), skus = new Set(facts.map((fact) => fact.sku));
  const dates = new Set(state.dataset.sales.filter((row) => skus.has(row.sku) && row.date >= state.plan.prepared.startDate && row.date <= state.plan.prepared.asOf).map((row) => row.date));
  const stocked = items.filter((item) => !item.blocker).length;
  const leadTime = new Set(state.dataset.products.filter((row) => skus.has(row.sku) && Number(row.lead_time_days) > 0).map((row) => row.sku)).size;
  return { skus: facts.length, stores: new Set(items.map((item) => item.location)).size, items: items.length,
    salesDays: dates.size, stocked, leadTime };
}

function reviewGate() {
  if (!state.plan) return { allowed: false, reason: "数据未加载" };
  if (mode() === "demo") return { allowed: true, reason: "公开样本模式；导出标记 DEMO，不得作为真实采购或调拨单。" };
  if (mode() === "synthetic") return { allowed: true, reason: "独立合成教学案例；所有建议、回执与效果均为虚构，仅供操作演示。" };
  const age = daysBetween(state.plan.result.summary.asOf, today());
  if (age < 0) return { allowed: false, reason: "库存快照日期晚于今天，请核对时区与 as_of。" };
  if (age > 7) return { allowed: false, reason: `库存快照已过期 ${age} 天，请重新导入。` };
  const blocked = new Set(["sales_empty", "sales_stale", "sales_invalid", "sales_future", "inventory_invalid", "inventory_duplicate", "negative_stock", "available_invalid", "missing_stock", "product_key", "product_duplicate", "missing_product", "lead_time_invalid", "case_pack_invalid", "moq_invalid", "inbound_invalid", "inbound_overdue"]);
  const issue = state.plan.result.issues.find((row) => blocked.has(row.code));
  if (issue) return { allowed: false, reason: `数据质量待修复：${issue.message}` };
  if (!state.dataset.meta.inboundConfirmed) return { allowed: false, reason: "在途未提供，也未确认当前范围无未收货订单。" };
  if (state.plan.result.items.some((item) => !item.blocker && item.stockBasis !== "available_units")) return { allowed: false, reason: "仍有库存项目缺少 available_units；可继续做情景分析，行动导出须先核实可售量。" };
  return { allowed: true, reason: "数据时效、在途与可售库存门槛通过；仍须在企业系统核实供应商约束和正式审批。" };
}

function lineChart(primary, secondary, title, primaryColor = "#526b70", secondaryColor = "#c1643b", tight = false, comparison = null, comparisonColor = "#a68736") {
  if (!primary?.length) return '<div class="chart-empty">没有可绘制的数据</div>';
  const compact = window.innerWidth <= 610;
  const width = compact ? 380 : 760, height = compact ? 210 : 245, left = compact ? 38 : 42, right = 12, top = 15, bottom = 34;
  const values = [...primary, ...(secondary || []), ...(comparison || [])], observedMax = Math.max(1, ...values), observedMin = Math.min(...values);
  const spread = Math.max(1, observedMax - observedMin);
  const minimum = tight && observedMin > 0 ? Math.max(0, observedMin - spread * .18) : 0;
  const maximum = tight ? observedMax + spread * .18 : observedMax * 1.12;
  const x = (index) => left + index / Math.max(1, primary.length - 1) * (width - left - right);
  const y = (value) => top + (1 - (value - minimum) / (maximum - minimum)) * (height - top - bottom);
  const grid = [0, .5, 1].map((fraction) => { const mark = minimum + (maximum - minimum) * fraction; return `<line x1="${left}" y1="${y(mark)}" x2="${width - right}" y2="${y(mark)}" stroke="#e4ddd2"/><text x="${left - 7}" y="${y(mark) + 3}" text-anchor="end" fill="#8a8378" font-size="10">${fmt(mark)}</text>`; }).join("");
  const path = (values, color, dash = "") => `<polyline points="${values.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ")}" fill="none" stroke="${color}" stroke-width="2.7" stroke-linejoin="round" stroke-linecap="round" ${dash ? `stroke-dasharray="${dash}"` : ""}/>`;
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">${grid}${path(primary, primaryColor)}${secondary ? path(secondary, secondaryColor) : ""}${comparison ? path(comparison, comparisonColor, "6 5") : ""}<text x="${left}" y="${height - 7}" fill="#8a8378" font-size="10">第 1 天</text><text x="${width - right}" y="${height - 7}" text-anchor="end" fill="#8a8378" font-size="10">第 ${primary.length} 天</text></svg>`;
}

function modelPathChart(actual, series, title, startLabel, endLabel) {
  const first = actual?.length ? actual : series[0]?.values;
  if (!first?.length) return '<div class="chart-empty">请勾选至少一个模型，查看预测路径。</div>';
  const compact = window.innerWidth <= 610;
  const width = compact ? 380 : 760, height = compact ? 222 : 252, left = compact ? 41 : 47, right = 13, top = 19, bottom = 37;
  const values = [...(actual || []), ...series.flatMap((item) => item.values)];
  const low = Math.min(...values), high = Math.max(...values), spread = Math.max(1, high - low);
  const minimum = Math.max(0, low - spread * .15), maximum = high + spread * .15;
  const x = (index) => left + index / Math.max(1, first.length - 1) * (width - left - right);
  const y = (value) => top + (1 - (value - minimum) / Math.max(1, maximum - minimum)) * (height - top - bottom);
  const grid = [0, .5, 1].map((fraction) => { const mark = minimum + (maximum - minimum) * fraction, ordinate = y(mark); return `<line x1="${left}" y1="${ordinate}" x2="${width - right}" y2="${ordinate}" stroke="#e4ddd2"/><text x="${left - 8}" y="${ordinate + 3}" text-anchor="end" fill="#8a8378" font-size="10">${fmt(mark)}</text>`; }).join("");
  const path = (values, label, color, current = false, observed = false) => {
    const points = values.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
    const tail = values.length - 1;
    return `<g class="model-chart-series"><title>${esc(label)} · ${fmt(sum(values), 1)} 件 / ${values.length} 天</title><polyline points="${points}" fill="none" stroke="${color}" stroke-width="${observed ? 3.3 : current ? 3.4 : 2.2}" stroke-linejoin="round" stroke-linecap="round" ${!observed && !current ? 'stroke-dasharray="5 4"' : ""}/><circle cx="${x(tail).toFixed(1)}" cy="${y(values[tail]).toFixed(1)}" r="${observed || current ? 3.5 : 2.8}" fill="${color}" stroke="#fff" stroke-width="1.2"/></g>`;
  };
  const forecastPaths = series.filter((item) => item.values?.length === first.length).map((item) => path(item.values, item.label, item.color, item.current)).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">${grid}${forecastPaths}${actual ? path(actual, "记录销量（需求代理）", "#202622", false, true) : ""}<text x="${left}" y="${height - 8}" fill="#8a8378" font-size="10">${esc(startLabel)}</text><text x="${width - right}" y="${height - 8}" text-anchor="end" fill="#8a8378" font-size="10">${esc(endLabel)}</text><text x="${left}" y="12" fill="#8a8378" font-size="9">件 / 日</text></svg>`;
}

function barChart(values, title) {
  const compact = window.innerWidth <= 610;
  const width = compact ? 380 : 760, height = compact ? 175 : 190, left = compact ? 38 : 42, right = 12, top = 12, bottom = 30, max = Math.max(1, ...values) * 1.12;
  const step = (width - left - right) / values.length;
  const y = (value) => top + (1 - value / max) * (height - top - bottom);
  const bars = values.map((value, index) => `<rect x="${(left + index * step + 5).toFixed(1)}" y="${y(value).toFixed(1)}" width="${Math.max(3, step - 10).toFixed(1)}" height="${Math.max(0, height - bottom - y(value)).toFixed(1)}" rx="2" fill="#c1643b"/>`).join("");
  const grid = [0, .5, 1].map((fraction) => `<line x1="${left}" y1="${y(max * fraction)}" x2="${width - right}" y2="${y(max * fraction)}" stroke="#e4ddd2"/><text x="${left - 7}" y="${y(max * fraction) + 3}" text-anchor="end" fill="#8a8378" font-size="10">${fmt(max * fraction)}</text>`).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">${grid}${bars}<text x="${left}" y="${height - 5}" fill="#8a8378" font-size="10">${esc(addDays(state.plan.prepared.asOf, 1))}</text><text x="${width - right}" y="${height - 5}" text-anchor="end" fill="#8a8378" font-size="10">${esc(addDays(state.plan.prepared.asOf, 14))}</text></svg>`;
}

function populateScope() {
  const prepared = state.plan.prepared;
  if (!prepared.majorCategories.includes(state.major)) {
    const revenue = new Map(prepared.majorCategories.map((major) => [major, 0]));
    for (const fact of state.plan.skuFacts) revenue.set(fact.majorCategory, (revenue.get(fact.majorCategory) || 0) + fact.netSales28);
    state.major = [...prepared.majorCategories].sort((a, b) => revenue.get(b) - revenue.get(a))[0] || "未分大类";
    state.category = "";
  }
  const lines = prepared.categoriesByMajor[state.major] || [];
  if (state.category && !lines.includes(state.category)) state.category = "";
  $("#scope-major").innerHTML = prepared.majorCategories.map((major) => `<option value="${esc(major)}">${esc(major)}</option>`).join("");
  $("#scope-major").value = state.major;
  $("#scope-category").innerHTML = `<option value="">样本内全部产品线 · ${lines.length}</option>` + lines.map((category) => `<option value="${esc(category)}">${esc(category.slice(state.major.length).trim() || category)}</option>`).join("");
  $("#scope-category").value = state.category;
  const facts = categoryFacts().sort((a, b) => b.netSales28 - a.netSales28 || a.sku.localeCompare(b.sku));
  if (state.sku && !facts.some((fact) => fact.sku === state.sku)) state.sku = "";
  $("#scope-sku").innerHTML = `<option value="">当前范围汇总 · ${facts.length} SKU</option>${facts.map((fact) => `<option value="${esc(fact.sku)}">${esc(fact.sku)} · ${esc(fact.name)}</option>`).join("")}`;
  $("#scope-sku").value = state.sku;
  $("#model-policy").innerHTML = '<option value="auto">选模期择优 / 守护规则</option>' + forecastModels.map(({ id, label, family }) => `<option value="${id}">${esc(label)} · ${esc(family)}</option>`).join("");
  $("#model-policy").value = state.policy;
  $("#scope-count").textContent = `${facts.length} SKU · ${new Set(scopeItems().map((item) => item.location)).size} 门店`;
}

function renderShell() {
  const { result, prepared } = state.plan, gate = reviewGate();
  $("#as-of").textContent = prepared.asOf;
  $("#data-mode").textContent = mode() === "demo" ? "公开样本 / 非实时" : mode() === "synthetic" ? "合成案例 / 全部虚构" : "本地 CSV / 当前会话";
  $("#data-mode").className = `data-mode ${mode() === "demo" || mode() === "synthetic" ? "demo" : ""}`;
  $("#trust-banner").className = `trust-banner ${mode() === "demo" || mode() === "synthetic" ? "demo" : gate.allowed ? "" : "warning"}`;
  $("#trust-banner").innerHTML = mode() === "demo" ? `<strong>演示范围 · ${esc(prepared.asOf)}</strong><span><a href="https://data.mendeley.com/datasets/27x8mjm8k4/1" target="_blank" rel="noopener noreferrer">Mendeley 零售样本 ↗</a> · ${prepared.majorCategories.length} 个大类 / ${prepared.categories.length} 条选定产品线 / 20 家门店。Junior Apparel 只选 3 条真实产品线，并沿用鞋类门店样本；库存为有效期间记录，并非当天盘点。无真实在途、供应商交期或缺货暴露；补货效果均为情景模拟。</span>` : mode() === "synthetic" ? `<strong>独立合成 P1 教学案例 · 全部记录虚构</strong><span>${esc(SYNTHETIC_CASE_VERSION)} · 2 个合成 SKU / 2 个合成门店，日期按打开当天平移。它与 Mendeley 样本不合并；促销、可售量、PO、缺货和回执只用于验证工作流，不能作为实际效果证据。</span>` : `<strong>${gate.allowed ? "业务数据已接入" : "数据门槛待修复"}</strong><span>${esc(gate.reason)} 文件只在本浏览器会话处理。</span>`;
  $("#review-count").textContent = String(state.decisions.size);
  const facts = scopeFacts(), items = scopeItems(), evidence = scopeEvidence();
  const sales = sum(facts.map((fact) => fact.sales28)), forecast = sum(facts.map((fact) => fact.forecast14));
  const unmapped = sum(facts.map((fact) => fact.unmappedForecast14));
  const model = chosenModel(evidence, state.policy), wape = evidence?.models?.[model]?.wape ?? evidence?.wape;
  const risk = items.filter((item) => item.kind === "expedite" || item.kind === "stockout").length;
  const scenario = summarizeScenario(items, config().horizon);
  const metrics = state.view === "psi" ? [
    ["期初有效库存", fmt(scenario.stock, 1), "按 SKU × 门店有效项目汇总", "", mode() === "demo" ? "有效期记录" : "输入"],
    ["提议补货", fmt(scenario.orderUnits), "按当前服务目标计算", "accent", "情景"],
    ["模拟未满足", fmt(scenario.proposedUnmet, 1), "仅当前计划窗口", "risk", "情景"],
    ["风险项目", fmt(risk), "SKU × 门店 · 不可跨 SKU 抵消", "alert", "情景"],
  ] : [
    ["销量 · 28 天", fmt(sales), "件 / 正向销售", "", "观测"],
    ["需求 · 14 天", fmt(forecast, 1), "件 / SKU 模型汇总", "accent", "预测"],
    ["独立测试 WAPE", wape == null ? "样本不足" : `${fmt(wape, 1)}%`, "最后 28 天 / 一次起点", wape > 60 ? "risk" : "", "测试"],
    ["未映射到 PSI", fmt(unmapped, 1), "件 / 核查 SKU 范围", unmapped ? "alert" : "", "预测"],
  ];
  $("#scope-kpis").hidden = !["forecast", "psi"].includes(state.view);
  $("#scope-kpis").innerHTML = metrics.map(([name, value, note, kind, basis]) => `<div class="scope-kpi ${kind}"><span>${name}<em class="metric-basis">${basis}</em></span><strong>${value}</strong><small>${note}</small></div>`).join("");
  const cover = coverage(), missingStock = cover.items ? (1 - cover.stocked / cover.items) * 100 : 0;
  const missingLead = cover.skus ? (1 - cover.leadTime / cover.skus) * 100 : 0;
  $("#coverage-signal").textContent = `库存阻断 ${fmt(cover.items - cover.stocked)} / ${fmt(cover.items)} 项 · ${fmt(cover.salesDays)} / 168 天有交易行`;
  $("#coverage-strip").innerHTML = `<div class="coverage-cell"><span>数据截至 / 观察期</span><strong>${esc(prepared.asOf)} <small>· 168 天</small></strong></div><div class="coverage-cell"><span>当前覆盖</span><strong>${fmt(cover.skus)} SKU <small>· ${fmt(cover.stores)} 门店</small></strong></div><div class="coverage-cell"><span>有交易行日期</span><strong>${fmt(cover.salesDays)} / 168 <small>天</small></strong></div><div class="coverage-cell ${missingStock ? "coverage-warn" : ""}"><span>库存不可用</span><strong>${fmt(missingStock, 1)}% <small>· ${fmt(cover.items - cover.stocked)}/${fmt(cover.items)} 项</small></strong></div><div class="coverage-cell ${missingLead ? "coverage-warn" : ""}"><span>商品交期缺失</span><strong>${fmt(missingLead, 1)}% <small>· ${fmt(cover.skus - cover.leadTime)}/${fmt(cover.skus)} SKU</small></strong></div><div class="coverage-cell"><span>证据版本</span><strong>${esc(state.dataVersion ? state.dataVersion.slice(0, 12) : "待核验")} <small>· SHA-256 前 12 位</small></strong></div><p class="coverage-note">交易行日期数仅表示出现过记录；无行日按零销量建模，无法据此判断是零需求还是抽取缺口。库存不可用按当前 SKU × 门店项目统计；演示库存为有效期间记录。</p>`;
  renderContext(facts, items);
}

function renderModelComparison(evidence, selected, actual) {
  const target = $("#model-scoreboard"), modelRows = forecastModels.filter((kind) => evidence?.models?.[kind.id]).map((kind) => ({ ...kind, ...evidence.models[kind.id] }));
  const previousScroll = target.querySelector(".model-compare-scroll")?.scrollLeft || 0;
  if (!modelRows.length) {
    target.innerHTML = '<div class="model-empty"><strong>当前范围不具备可靠的模型竞赛条件</strong><p>销售量或有效历史不足；只展示低样本外推，不计算候选模型排名，也不把零销量当成零需求。</p></div>';
    return;
  }
  const recommended = evidence.method, current = evidence.models[selected];
  const baseline = modelRows.filter((row) => ["seasonal7", "moving28", "weekday4"].includes(row.id)).sort((a, b) => (a.selectionWape ?? Infinity) - (b.selectionWape ?? Infinity))[0];
  const tested = modelRows.filter((row) => row.wape != null).sort((a, b) => a.wape - b.wape);
  const testBest = tested[0], actual28 = sum(actual), currentTest28 = current?.backtest ? sum(current.backtest) : null;
  const maxWape = Math.max(1, ...tested.map((row) => row.wape));
  const sortValue = (row) => state.modelSort === "test" ? row.wape ?? Infinity : state.modelSort === "future" ? -sum((row.future || []).slice(0, 14)) : row.selectionWape ?? Infinity;
  modelRows.sort((a, b) => sortValue(a) - sortValue(b) || a.label.localeCompare(b.label));
  const testGap = testBest && current?.wape != null ? current.wape - testBest.wape : null;
  const insight = !testBest ? "独立测试有效需求量不足，无法比较 WAPE；请查看 MAE 和原始路径，不能宣布赢家。" : testGap > .05
    ? `当前决策模型在独立测试期的 WAPE 比该期最低者高 ${fmt(testGap, 1)} 个百分点。这是负结果；测试期最低者只作事后诊断，不自动替换选模期推荐。`
    : `当前决策模型在独立测试期的 WAPE 为 ${fmt(current.wape, 1)}%；测试结果只用于验收，不反向改变选模期推荐。`;
  target.innerHTML = `<div class="model-summary" aria-label="模型比较口径"><div><span>独立测试实际需求 · 28D</span><strong>${fmt(actual28, 1)} <small>件</small></strong></div><div><span>当前模型测试预测 · 28D</span><strong>${currentTest28 == null ? "—" : fmt(currentTest28, 1)} <small>件</small></strong></div><div><span>选模期推荐</span><strong>${esc(modelLabels[recommended] || "低样本均值")}</strong></div><div><span>当前决策模型</span><strong>${esc(modelLabels[selected] || "低样本均值")}</strong></div></div>
    <p class="model-insight ${testGap > .05 || !testBest ? "warn" : ""}">${esc(insight)}</p>
    <div class="model-compare-toolbar"><div><strong>当前聚合层的 7 个候选</strong><span>相同范围、相同 28 天独立测试窗口；未来 14 天尚无实际值。</span></div><div class="model-compare-actions"><label>排序 <select id="model-sort" aria-label="模型比较排序"><option value="selection">选模期 WAPE</option><option value="test">测试期 WAPE</option><option value="future">未来 14 天量</option></select></label><button type="button" id="model-auto" class="secondary-button" aria-pressed="${state.policy === "auto"}">恢复自动择优</button></div></div>
    <div class="model-compare-scroll"><table class="model-compare-table"><thead><tr><th>模型 / 应用至情景</th><th class="num">选模期 WAPE</th><th>独立测试 WAPE <small>越短越好</small></th><th class="num">测试 MAE <small>件 / 天</small></th><th class="num">测试 Bias</th><th class="num">测试预测 · 28D</th><th class="num">未来预测 · 14D</th><th class="num">对照简单基线</th></tr></thead><tbody>${modelRows.map((row) => {
      const delta = row.wape == null || baseline?.wape == null ? null : row.wape - baseline.wape;
      const deltaText = delta == null ? "—" : Math.abs(delta) < .05 ? "±0.0 pp" : `${delta > 0 ? "+" : "−"}${fmt(Math.abs(delta), 1)} pp`;
      return `<tr class="${row.id === selected ? "is-current" : ""}"><td><button type="button" class="model-apply" data-forecast-model="${esc(row.id)}" aria-pressed="${row.id === selected}" aria-label="应用${esc(row.label)}到预测与 PSI"><strong>${esc(row.label)}</strong><small>${esc(row.family)}${row.id === recommended ? " · 选模推荐" : ""}${row.id === selected ? " · 当前情景" : ""}</small></button></td><td class="num">${row.selectionWape == null ? "—" : `${fmt(row.selectionWape, 1)}%`}</td><td><div class="wape-value"><b>${row.wape == null ? "—" : `${fmt(row.wape, 1)}%`}</b><span class="wape-track"><i style="width:${row.wape == null ? 0 : Math.max(3, row.wape / maxWape * 100).toFixed(1)}%"></i></span></div></td><td class="num">${row.mae == null ? "—" : fmt(row.mae, 2)}</td><td class="num">${row.bias == null ? "—" : `${row.bias > 0 ? "+" : ""}${fmt(row.bias, 1)}%`}</td><td class="num">${row.backtest ? fmt(sum(row.backtest), 1) : "—"}</td><td class="num">${row.future ? fmt(sum(row.future.slice(0, 14)), 1) : "—"}</td><td class="num ${delta != null && delta > .05 ? "delta-worse" : delta != null && delta < -.05 ? "delta-better" : ""}">${deltaText}</td></tr>`;
    }).join("")}</tbody></table></div><p class="model-compare-note">WAPE＝Σ绝对误差 / Σ实际需求；MAE＝日均绝对误差（件 / 天）；Bias＝（预测总量−实际总量）/ 实际总量，正值表示高估；pp＝百分点。对照基线是选模期误差最低的简单基线 ${esc(baseline?.label || "—")}，其独立测试 WAPE 为 ${baseline?.wape == null ? "—" : `${fmt(baseline.wape, 1)}%`}。未来预测是当前大类 / 产品线 / SKU 聚合层模型；PSI 从逐 SKU 预测分配到门店，汇总量可能不同。</p>`;
  target.querySelector(".model-compare-scroll").scrollLeft = previousScroll;
  $("#model-sort").value = state.modelSort;
  $("#model-sort").addEventListener("change", (event) => { state.modelSort = event.target.value; renderModelComparison(evidence, selected, actual); announceUpdate(`模型对照已按${event.target.selectedOptions[0].textContent}排序；当前情景模型未改变。`); });
  $("#model-auto").addEventListener("click", () => { if (state.policy === "auto") return; state.policy = "auto"; announceUpdate("已恢复选模期择优 / 守护规则；预测与 PSI 已重算。"); recompute(true); });
  $$('[data-forecast-model]').forEach((button) => button.addEventListener("click", () => { state.policy = button.dataset.forecastModel; announceUpdate(`已应用 ${modelLabels[state.policy]}；预测与 PSI 已按该模型重算。`); recompute(true); }));
}

function renderForecastCharts(evidence, selected, actual, future) {
  const available = forecastModels.filter((kind) => evidence?.models?.[kind.id]);
  const checked = available.filter((kind) => state.chartModels?.has(kind.id));
  const series = (field) => checked.map((kind) => ({ label: kind.label, values: evidence.models[kind.id][field], color: modelColors[kind.id], current: kind.id === selected }));
  $("#model-chart-count").textContent = `${checked.length} / ${available.length} 个模型已显示`;
  $("#forecast-status").textContent = state.sku ? "SKU 级需求 / 跨门店汇总" : state.category ? "产品线级需求 / 跨门店汇总" : "大类级需求 / 跨门店汇总";
  $("#backtest-chart").innerHTML = available.length ? modelPathChart(actual, series("backtest"), `${scopeName()} 独立测试：记录销量与${checked.map((kind) => kind.label).join("、") || "无模型"}预测`, evidence.holdoutWindow.start, evidence.holdoutWindow.end) : '<div class="chart-empty">该范围的销量历史或有效需求量不足，无法可靠比较模型。<br>下方仅展示低样本均值外推。</div>';
  $("#backtest-caption").textContent = available.length ? `独立测试 ${evidence.holdoutWindow.start}—${evidence.holdoutWindow.end}，所有勾选模型从测试期之前的同一起点预测完整 28 天；深蓝色实线为记录销量，当前决策模型为较粗实线，其余模型为虚线。缺货暴露未知，记录销量仅作为需求代理；测试期结果不反向选模。` : "低样本范围不计算 WAPE 胜负；零销售 SKU 的预测为零，可能受未记录缺货影响。";
  $("#future-chart").innerHTML = available.length ? modelPathChart(null, series("future").map((item) => ({ ...item, values: item.values?.slice(0, 14) })), `${scopeName()} 未来 14 天：${checked.map((kind) => kind.label).join("、") || "无模型"}需求预测`, addDays(state.plan.prepared.asOf, 1), addDays(state.plan.prepared.asOf, 14)) : barChart(future, `${scopeName()} 未来 14 天低样本需求外推`);
  $("#future-total").textContent = `当前情景 ${fmt(sum(future), 1)} 件`;
  $("#future-caption").textContent = `${modelLabels[selected] || evidence?.label || "低样本均值"}为当前决策模型。上方勾选仅改变两张图的展示，不重算 PSI；点击模型比较表中的模型，才会切换决策输入。未来 14 天尚无实际值，曲线是预测，不是预计可售量。PSI 使用 SKU 级预测分配到门店。`;
}

function renderForecast() {
  const evidence = scopeEvidence(), selected = chosenModel(evidence, state.policy), future = chosenFuture(evidence, state.policy);
  const model = evidence?.models?.[selected], actual = evidence?.holdoutActual || [];
  const available = forecastModels.filter((kind) => evidence?.models?.[kind.id]);
  if (available.length && !state.chartModels) state.chartModels = new Set([selected, "seasonal7", "holtWinters", "moving28"].filter((id, index, ids) => ids.indexOf(id) === index).slice(0, 3));
  if (model && selected !== state.chartDecisionModel) { state.chartModels.add(selected); state.chartDecisionModel = selected; }
  $("#model-chart-options").innerHTML = available.length ? available.map((kind) => `<label class="chart-model-option ${kind.id === selected ? "is-decision" : ""} ${state.chartModels.has(kind.id) ? "is-checked" : ""}" style="--model-color:${modelColors[kind.id]}"><input type="checkbox" value="${esc(kind.id)}" ${state.chartModels.has(kind.id) ? "checked" : ""} aria-label="在两张曲线图中显示${esc(kind.label)}"><span class="chart-model-swatch" aria-hidden="true"></span><span class="chart-model-copy"><strong>${esc(kind.label)}</strong><small>${kind.id === selected ? "当前决策 · " : ""}测试 WAPE ${evidence.models[kind.id].wape == null ? "—" : `${fmt(evidence.models[kind.id].wape, 1)}%`}</small></span></label>`).join("") : '<p class="model-chart-empty">当前范围为低样本，暂不能比较七种模型的路径。</p>';
  $("#model-chart-all").disabled = !available.length;
  $("#model-chart-reset").disabled = !available.length;
  $$("#model-chart-options input").forEach((input) => input.addEventListener("change", () => {
    if (input.checked) state.chartModels.add(input.value); else state.chartModels.delete(input.value);
    input.closest(".chart-model-option").classList.toggle("is-checked", input.checked);
    renderForecastCharts(evidence, selected, actual, future);
    announceUpdate(`两张图现显示 ${state.chartModels.size} 个模型；当前决策模型与 PSI 未改变。`);
  }));
  $("#model-chart-all").onclick = () => { state.chartModels = new Set(available.map((kind) => kind.id)); renderForecast(); announceUpdate("两张图已显示全部七种模型；当前决策模型与 PSI 未改变。"); };
  $("#model-chart-reset").onclick = () => { state.chartModels = new Set([selected, "seasonal7", "holtWinters", "moving28"].filter((id, index, ids) => ids.indexOf(id) === index).slice(0, 3)); renderForecast(); announceUpdate("已恢复三模型对照；当前决策模型与 PSI 未改变。"); };
  renderForecastCharts(evidence, selected, actual, future);
  renderModelComparison(evidence, selected, actual);
  const categoryEvidence = state.category ? state.plan.prepared.categoryEvidence[lineKey(state.major, state.category)] : state.plan.prepared.majorEvidence[state.major];
  const productForecast = sum(categoryFacts().map((fact) => fact.forecast14));
  const unmapped = sum(categoryFacts().map((fact) => fact.unmappedForecast14));
  const categoryForecast = sum(chosenFuture(categoryEvidence, state.policy));
  const gap = productForecast - categoryForecast;
  const weak = evidence?.status === "weak_all_models";
  let message = evidence?.status === "insufficient_volume" ? "测试期之前的 56 天销量低于 20 件、此前 84 天有效销售日不足 10 天，或历史不足 140 天。只用低样本均值，不宣称模型胜出。" : weak ? `七种候选在选模期的 WAPE 均超过 60%；自动策略退回选模期误差较低的简单基线。独立测试的负结果保留在比较表中。` : `${evidence?.label} 由较早的 56 天选模期 WAPE 选出；右侧独立测试误差仅用于验收，不反向改变赢家。`;
  const windows = evidence?.rollingWindows || [];
  if (windows.length > 1) message += ` 推荐模型分期 WAPE：${windows.map((window) => `${window.phase === "selection" ? "选模" : "独立测试"} ${window.start.slice(5)} ${window.models[evidence.method].wape == null ? "样本不足" : `${fmt(window.models[evidence.method].wape, 1)}%`}`).join(" · ")}。`;
  if (state.policy !== "auto" && evidence?.models?.[state.policy]) message += ` 当前手动选择 ${modelLabels[state.policy]}（独立测试 WAPE ${evidence.models[state.policy].wape == null ? "样本不足" : `${fmt(evidence.models[state.policy].wape, 1)}%`}），该选择同步进入 PSI；手动选择不代表选模期推荐。`;
  if (model?.wape != null && evidence?.baselineWape != null) {
    const gain = evidence.baselineWape - model.wape;
    message += ` 独立测试中，当前模型相对选模期胜出的简单基线，WAPE ${gain > .05 ? `改善 ${fmt(gain, 1)}` : gain < -.05 ? `恶化 ${fmt(-gain, 1)}` : "持平"}${Math.abs(gain) > .05 ? " 个百分点" : ""}。`;
  }
  const testWorse = model?.wape != null && model?.selectionWape != null && model.wape > model.selectionWape + 5;
  $("#model-interpretation").innerHTML = `<p class="evidence-callout ${weak || testWorse || evidence?.status === "insufficient_volume" ? "warn" : ""}">${esc(message)}</p>${testWorse ? `<p class="negative-result">独立测试 WAPE 比选模期高 ${fmt(model.wape - model.selectionWape, 1)} 个百分点。后段表现变差，但两期预测跨度不同，不能单凭差值认定模型漂移；请核查需求变化、缺货暴露与促销。</p>` : ""}<p>选模期的两段 28 天窗口各按 14 天滚动重训；独立测试仅在开始时训练一次并预测 28 天。测试更严格，两种 WAPE 不应当作同口径改善。未来预测会使用测试结束后的全部已观测历史；PSI 把 SKU 预测按近 56 天门店销量份额分配。</p>${!state.sku ? `<p>当前范围模型预测 ${fmt(categoryForecast, 1)} 件；SKU 预测汇总 ${fmt(productForecast, 1)} 件；层级差额 ${gap >= 0 ? "+" : ""}${fmt(gap, 1)} 件。其中 ${fmt(unmapped, 1)} 件没有当前门店可映射，未进入 PSI。</p>` : state.sku && scopeFacts()[0]?.unmappedForecast14 ? `<p>该 SKU 的 ${fmt(scopeFacts()[0].unmappedForecast14, 1)} 件预测没有当前门店可映射，未进入 PSI；请核对是否停售或缺少库存快照。</p>` : ""}<p>未来真实需求受促销、缺货暴露和新品变化影响；${mode() === "demo" ? "公开样本没有这些字段，" : "即使额外导入运营证据，当前模型仍未将它们训练为预测特征，"}不能据此声称预测覆盖全部潜在需求。</p>`;
  renderForecastProducts();
}

function renderForecastProducts() {
  const query = $("#forecast-search").value.trim().toLowerCase();
  const facts = categoryFacts().filter((fact) => `${fact.sku} ${fact.name}`.toLowerCase().includes(query)).sort((a, b) => b.sales28 - a.sales28 || a.sku.localeCompare(b.sku));
  $("#forecast-products").innerHTML = facts.slice(0, 30).map((fact) => { const wape = fact.evidence.models?.[chosenModel(fact.evidence, state.policy)]?.wape ?? null;
    return `<tr><td><span class="row-title">${esc(fact.sku)}</span><span class="row-sub">${esc(fact.name)}</span></td><td class="num">${fmt(fact.sales28)}</td><td class="num">${fmt(fact.forecast14, 1)}</td><td class="num">${wape == null ? "—" : `${fmt(wape, 1)}%`}</td><td><span class="tag ${fact.unmappedForecast14 ? "bad" : fact.evidence.status === "insufficient_volume" ? "neutral" : wape > 60 ? "warn" : "good"}">${fact.unmappedForecast14 ? "未映射 PSI" : fact.evidence.status === "insufficient_volume" ? "低样本" : wape > 60 ? "独立测试误差高" : "可回测"}</span></td><td><button type="button" class="row-link" data-forecast-sku="${esc(fact.sku)}">查看 →</button></td></tr>`; }).join("") || '<tr><td colspan="6">当前筛选没有 SKU。</td></tr>';
  $("#forecast-list-note").textContent = `显示 ${Math.min(30, facts.length)} / ${facts.length} 个 SKU；WAPE 是模型选定之后的独立 28 天测试。低样本 SKU 只给出保守外推。`;
  $$('[data-forecast-sku]').forEach((button) => button.addEventListener("click", () => { state.sku = button.dataset.forecastSku; state.segment = ""; state.selectedActionSku = state.sku; announceUpdate(`已下钻至 SKU ${state.sku}；预测、PSI 与品类指标同步采用此范围。`); renderAll(); $("#decision-context").scrollIntoView({ block: "start", behavior: "smooth" }); }));
}

function renderPsiDaily(items, summary) {
  const valid = items.filter((item) => !item.blocker && item.baseline && item.proposed);
  const horizon = config().horizon;
  $("#psi-daily-note").textContent = "P 只计输入中有有效 ETA 的在途，以及按当前交期假设到货的提案；S 为 SKU 预测按近 56 天门店销量占比分配。未提供 PO 不等于已确认没有在途，表中 I 与未满足量均为模拟值。";
  $("#psi-daily-rows").innerHTML = Array.from({ length: horizon }, (_, day) => {
    const date = addDays(state.plan.prepared.asOf, day + 1);
    const demand = sum(valid.map((item) => item.demandProfile?.[day] ?? item.demandRate));
    const inbound = sum(valid.flatMap((item) => item.inbound.filter((row) => row.eta === date).map((row) => row.units)));
    const proposedArrival = sum(valid.filter((item) => item.leadTime === day + 1).map((item) => item.allocatedQty));
    const baselineMissed = summary.baselineUnmetPath[day] - (day ? summary.baselineUnmetPath[day - 1] : 0);
    const proposedMissed = summary.unmetPath[day] - (day ? summary.unmetPath[day - 1] : 0);
    return `<tr><td>${esc(date)}</td><td class="num">${fmt(demand, 1)}</td><td class="num">${fmt(inbound)}</td><td class="num">${fmt(proposedArrival)}</td><td class="num">${fmt(summary.baselinePath[day], 1)}</td><td class="num">${fmt(summary.proposedPath[day], 1)}</td><td class="num">${fmt(baselineMissed, 1)}</td><td class="num">${fmt(proposedMissed, 1)}</td></tr>`;
  }).join("");
}

function renderPsi() {
  if (!$("#scenario-live")) { const status = document.createElement("p"); status.id = "scenario-live"; status.className = "scenario-live"; status.setAttribute("role", "status"); $("#service-cards").after(status); }
  $("#scenario-live").textContent = `当前情景：${scopeName()} · ${state.service}% 服务目标 · ${config().horizon} 天 · ${state.policy === "auto" ? "逐 SKU 择优 / 守护" : modelLabels[state.policy]} · 交期 ${config().leadTime} 天；${state.updateMessage}`;
  const comparison = [90, 95, 98].map((service) => ({ service, summary: summarizeScenario(scopeItems(state.comparisons.get(service)), config().horizon) }));
  $("#service-cards").innerHTML = comparison.map(({ service, summary }) => `<button type="button" class="service-card ${state.service === service ? "active" : ""}" data-service="${service}" aria-pressed="${state.service === service}"><span class="service-card-head"><b>${service}%</b><span>${state.service === service ? "当前情景 ●" : "点击选择 →"}</span></span><span class="service-card-grid"><span>建议补货<strong>${fmt(summary.orderUnits)}</strong></span><span>模拟未满足<strong>${fmt(summary.proposedUnmet, 1)}</strong></span><span>期末在手<strong>${fmt(summary.closing)}</strong></span></span></button>`).join("");
  $$('[data-service]').forEach((button) => button.addEventListener("click", () => { state.service = Number(button.dataset.service); announceUpdate(`服务目标已切换至 ${state.service}%；PSI 与品类风险已重算，原待复核动作已清空。`); recompute(true); }));
  const items = scopeItems(), summary = summarizeScenario(items, config().horizon);
  $("#psi-stock-chart").innerHTML = lineChart(summary.baselinePath, summary.proposedPath, `${scopeName()} 每日期末模拟库存：无新增提案与含提案到货`, "#526b70", "#c1643b", true);
  const valid = items.filter((item) => !item.blocker && item.baseline && item.proposed);
  const arrivalDays = [...new Set(valid.filter((item) => item.allocatedQty > 0 && item.leadTime <= config().horizon).map((item) => item.leadTime))].sort((a, b) => a - b);
  const sourceNote = mode() === "demo" ? "公开样本的库存来自有效期记录，不是逐日实盘；没有 PO 表，未来在途记录未提供。" : mode() === "synthetic" ? "本案例的库存、PO 与执行均为虚构。" : "上传的快照和 ETA 是输入，后续期末库存仍为情景模拟。";
  $("#psi-stock-caption").textContent = `每个点是第 1—${config().horizon} 天的模拟期末库存；纵轴按本情景范围缩放，须结合刻度与下方每日明细判断变化。按 SKU × 门店独立计算后汇总，大范围汇总会平滑波动。${sourceNote}${arrivalDays.length ? ` 提案在第 ${arrivalDays.join("、")} 天按假设到货；同日到货会形成台阶。` : " 当前窗口内无提案到货。"} 总量不能用其他 SKU 的富余抵消某 SKU 的缺口。`;
  renderPsiDaily(items, summary);
  const improvement = summary.baselineUnmet - summary.proposedUnmet;
  $("#psi-impact").innerHTML = `<div class="impact-big">${fmt(improvement, 1)}<small>件 · 模拟未满足减少</small></div><div class="impact-row"><span>不新增提案 / 基线未满足</span><b>${fmt(summary.baselineUnmet, 1)}</b></div><div class="impact-row"><span>当前提案 / 模拟未满足</span><b>${fmt(summary.proposedUnmet, 1)}</b></div><div class="impact-row"><span>建议补货量</span><b>${fmt(summary.orderUnits)} 件</b></div><div class="impact-row"><span>已知补货成本</span><b>${summary.orderUnits && summary.orderValueCoverage === 0 ? "未知" : fmt(summary.orderValueKnown, 1)}</b></div><div class="impact-row"><span>成本口径覆盖</span><b>${fmt(summary.orderValueCoverage, 1)}%</b></div><div class="impact-row"><span>库存无效 / 未知项目</span><b>${fmt(summary.blocked)} 项</b></div>`;
  $("#psi-unmet-chart").innerHTML = lineChart(summary.baselineUnmetPath, summary.unmetPath, `${scopeName()} 模拟累计未满足需求`);
  const reconcile = [["期初有效在手", summary.stock], ["+ 窗口内已知在途", summary.inbound], ["+ 窗口内提案到货", summary.arrivingOrders], ["− 模拟满足需求", summary.fulfilled], ["= 情景期末在手", summary.closing]];
  $("#psi-reconcile").innerHTML = reconcile.map(([label, value]) => `<div class="reconcile-item"><span>${label}</span><b>${fmt(value, 1)}</b></div>`).join("") + `<p class="panel-foot">已知补货成本 ${summary.orderUnits && summary.orderValueCoverage === 0 ? "未知" : fmt(summary.orderValueKnown, 1)} 为源数据金额单位；成本缺失的数量不被填为零。</p>`;
  const stores = [...new Set(items.map((item) => item.location))].sort();
  $("#store-count").textContent = `${stores.length} 门店`;
  $("#psi-stores").innerHTML = stores.map((store) => {
    const rows = items.filter((item) => item.location === store), valid = rows.filter((item) => !item.blocker);
    return `<tr><td><strong>${esc(store)}</strong></td><td class="num">${valid.length ? fmt(sum(valid.map((item) => item.stock))) : "未知"}</td><td class="num">${fmt(sum(rows.map((item) => item.recent28)))}</td><td class="num">${valid.length ? fmt(sum(valid.map((item) => item.allocatedQty))) : "—"}</td><td class="num">${valid.length ? fmt(sum(valid.map((item) => item.baseline.unmet)), 1) : "—"}</td><td class="num">${valid.length ? fmt(sum(valid.map((item) => item.proposed.unmet)), 1) : "—"}</td><td class="num">${rows.length - valid.length}</td></tr>`;
  }).join("") || '<tr><td colspan="7">当前范围没有门店项目。</td></tr>';
  const manual = state.policy !== "auto" ? `当前优先选择 ${modelLabels[state.policy]}；有可回测证据的 SKU 使用该模型，低样本 SKU 仍用均值。手动模型可能弱于选模期推荐，并会改变其余 SKU 的补货情景。` : "当前逐 SKU 使用选模期择优；低样本 SKU 使用均值，所有候选误差高时回退简单基线。";
  const low = comparison[0].summary, high = comparison[2].summary;
  const unmapped = sum(scopeFacts().map((fact) => fact.unmappedForecast14));
  const tradeoff = high.orderUnits > low.orderUnits && Math.abs(high.proposedUnmet - low.proposedUnmet) < .05 ? `负结果：90%→98% 目标让提议量增加 ${fmt(high.orderUnits - low.orderUnits)} 件，但窗口内模拟未满足没有改善。当前交期或到货日是瓶颈，应先核对催交与同 SKU 调拨，不应仅提高安全量。` : `90%→98% 目标让提议量增加 ${fmt(high.orderUnits - low.orderUnits)} 件，模拟未满足变化 ${fmt(low.proposedUnmet - high.proposedUnmet, 1)} 件；请同时比较期末库存与已知成本。`;
  $("#psi-caveat").innerHTML = `<strong>服务目标取舍</strong>　${esc(tradeoff)}<br><strong>情景边界</strong>　${esc(manual)} ${config().horizon > 14 ? "第 15—28 天重复预测第二周日节奏，只是压力测试，不能当作延长的模型精度承诺。" : "未来 14 天库存路径位于模型输出范围内。"} 补货目标覆盖交期＋复盘＋缓冲；超过 14 天的目标需求用未来 14 天日均外推。${mode() === "demo" ? "公开样本没有真实在途、交期、MOQ 或箱规；" : mode() === "synthetic" ? "合成案例的在途、交期及订单均为虚构；" : "上传数据需核对在途与供应商约束；"}${summary.blocked} 个阻断项目不参与模拟，另有 ${fmt(unmapped, 1)} 件 SKU 预测没有当前门店可映射。<br><strong>可追溯编号</strong>　${esc(scenarioId())} · ${esc(FORECAST_VERSION)} · ${esc(PSI_VERSION)}；导出文件包含数据摘要和全部计划参数。`;
}

function filteredActionFacts() {
  const query = $("#action-search").value.trim().toLowerCase(), filter = $("#action-filter").value, sort = $("#action-sort").value;
  const rows = scopeFacts().filter((fact) => (!state.segment || `${fact.abc}${fact.xyz}` === state.segment) && `${fact.sku} ${fact.name}`.toLowerCase().includes(query) &&
    (filter === "all" || filter === "risk" && fact.riskStores > 0 || filter === "blocked" && (fact.blockedStores > 0 || fact.unmappedForecast14 > 0) || filter === "overstock" && fact.overstockStores > 0 || filter === "returns" && fact.returnRate >= 15 && fact.sales28 >= 5));
  const keys = { priority: "priority", revenue: "netSales28", returns: "returnRate", risk: "riskStores", stockValue: "stockValue", forecast: "forecast14" };
  return rows.sort((a, b) => b[keys[sort]] - a[keys[sort]] || a.sku.localeCompare(b.sku));
}

function renderCategory() {
  const facts = scopeFacts();
  if (!facts.some((fact) => fact.sku === state.selectedActionSku)) state.selectedActionSku = state.sku || [...facts].sort((a, b) => b.priority - a.priority)[0]?.sku || "";
  $("#category-status").textContent = `${facts.length} SKU · ${facts.filter((fact) => fact.xyz === "N").length} 个波动分层样本不足`;
  const netSales = sum(facts.map((fact) => fact.netSales28)), cogs = sum(facts.map((fact) => fact.cogs28)), returns = sum(facts.map((fact) => fact.returnUnits28));
  const stockValue = sum(facts.map((fact) => fact.stockValue));
  const metrics = [["净销售额 · 28D", netSales, "源数据金额单位"], ["销售成本 · 28D", cogs, "已扣源数据退货行"], ["毛利 · 28D", netSales - cogs, "净销售额 − 销售成本"], ["退货件数 · 28D", returns, "不计入需求预测"], ["已知库存成本", stockValue, "仅已提供单位成本项目"]];
  $("#category-kpis").innerHTML = metrics.map(([label, value, note]) => `<div class="category-kpi"><span>${label}<em class="metric-basis">观测${label === "已知库存成本" ? "快照" : ""}</em></span><b>${fmt(value, 1)}</b><small>${note}</small></div>`).join("");
  renderMatrix(); renderSignals(); renderActionRows(); renderSkuDetail();
}

function renderMatrix() {
  const facts = scopeFacts(), cols = ["X", "Y", "Z", "N"], rows = ["A", "B", "C"];
  $("#abc-matrix").innerHTML = `<div class="matrix-label"></div>${cols.map((col) => `<div class="matrix-label">${col}</div>`).join("")}` + rows.map((row) => `<div class="matrix-label">${row}</div>${cols.map((col) => {
    const selected = facts.filter((fact) => fact.abc === row && fact.xyz === col);
    return `<button type="button" class="matrix-cell ${col === "N" ? "n" : ""} ${state.segment === row + col ? "active" : ""}" data-segment="${row}${col}"><b>${selected.length}</b><small>${row}${col} · ${fmt(sum(selected.map((fact) => Math.max(0, fact.netSales28))), 0)}</small></button>`;
  }).join("")}`).join("");
  if (!$("#segment-status")) { const status = document.createElement("p"); status.id = "segment-status"; status.className = "segment-status"; status.setAttribute("role", "status"); $("#abc-matrix").after(status); }
  const selectedCount = state.segment ? facts.filter((fact) => `${fact.abc}${fact.xyz}` === state.segment).length : facts.length;
  $("#segment-status").textContent = state.segment ? `当前筛选 ${state.segment} · ${selectedCount} SKU 进入行动清单；上方金额和信号保持管理范围口径。` : `未选分层 · ${facts.length} SKU；ABC 归属按所选大类 / 产品线计算，点击格子只筛选行动清单。`;
  $$('[data-segment]').forEach((button) => button.addEventListener("click", () => { state.segment = state.segment === button.dataset.segment ? "" : button.dataset.segment; state.actionPage = 0; renderMatrix(); renderActionRows(); announceUpdate(state.segment ? `已筛选 ${state.segment} 分层 · ${$("#action-count").textContent}` : `已清除分层筛选 · ${$("#action-count").textContent}`); renderContext(scopeFacts(), scopeItems()); }));
}

function renderSignals() {
  const facts = scopeFacts();
  const rows = [["有预计缺口", facts.filter((fact) => fact.riskStores > 0).length, "按所选服务目标模拟"], ["库存数据阻断", facts.filter((fact) => fact.blockedStores > 0).length, "未知在手不当作零"], ["无法映射到 PSI", facts.filter((fact) => fact.unmappedForecast14 > 0).length, "核查 SKU 范围与快照"], ["高退货 SKU", facts.filter((fact) => fact.returnRate >= 15 && fact.sales28 >= 5).length, "退货 / 正向销量 ≥15%"], ["C 类且高库存", facts.filter((fact) => fact.abc === "C" && fact.overstockStores > 0).length, "结合促销与季节复核"], ["低样本预测", facts.filter((fact) => fact.evidence.status === "insufficient_volume").length, "不宣称模型胜出"]];
  $("#category-signals").innerHTML = rows.map(([label, value, note], index) => `<div class="signal-row"><span>${String(index + 1).padStart(2, "0")}</span><div><strong>${label}</strong><small>${note}</small></div><b>${fmt(value)}</b></div>`).join("");
}

function renderActionRows() {
  const rows = filteredActionFacts(), pages = Math.max(1, Math.ceil(rows.length / state.actionPageSize));
  state.actionPage = Math.min(state.actionPage, pages - 1);
  const start = state.actionPage * state.actionPageSize;
  $("#action-count").textContent = `${rows.length} SKU`;
  $("#action-page").textContent = `${state.actionPage + 1} / ${pages}`;
  $("#action-prev").disabled = state.actionPage === 0;
  $("#action-next").disabled = state.actionPage >= pages - 1;
  $("#action-rows").innerHTML = rows.slice(start, start + state.actionPageSize).map((fact) => {
    const decision = state.decisions.get(fact.sku);
    return `<tr data-action-sku="${esc(fact.sku)}" class="${fact.sku === state.selectedActionSku ? "selected" : ""}" tabindex="0"><td><span class="row-title">${esc(fact.sku)}</span><span class="row-sub">${esc(fact.name)}</span></td><td><span class="abc-tag ${fact.xyz === "N" ? "low" : ""}">${fact.abc}${fact.xyz}</span></td><td class="num">${fmt(fact.sales28)}</td><td class="num">${fmt(fact.netSales28, 1)}</td><td class="num">${fmt(fact.returnRate, 1)}%</td><td class="num">${fact.costCoverage ? fmt(fact.stockValue, 1) : "未知"}</td><td class="num">${fact.riskStores}</td><td><span class="tag ${fact.riskStores ? "warn" : fact.blockedStores ? "bad" : "neutral"}">${esc(fact.action.label)}</span>${decision ? `<span class="row-sub">${decision.status === "included" ? "已入行动单" : decision.status === "hold" ? "暂缓" : "不采纳"}</span>` : ""}</td></tr>`;
  }).join("") || '<tr><td colspan="8">当前筛选没有 SKU。</td></tr>';
  $$('[data-action-sku]').forEach((row) => {
    const open = () => { state.selectedActionSku = row.dataset.actionSku; renderActionRows(); renderSkuDetail(); };
    row.addEventListener("click", open); row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
  });
}

function renderSkuDetail() {
  const fact = scopeFacts().find((row) => row.sku === state.selectedActionSku);
  if (!fact) { $("#sku-detail").innerHTML = '<p class="empty-state">没有可查看的 SKU。</p>'; return; }
  const decision = state.decisions.get(fact.sku), locations = [...fact.items].sort((a, b) => b.priorityScore - a.priorityScore).slice(0, 8);
  const planQty = sum(fact.items.map((item) => item.allocatedQty));
  const hasValidStock = fact.items.some((item) => !item.blocker);
  const evidence = fact.evidence, selectedWape = evidence.models?.[chosenModel(evidence, state.policy)]?.wape ?? null;
  $("#sku-detail").innerHTML = `<div class="detail-header"><div><small>SKU / ${esc(fact.category)}</small><h2>${esc(fact.sku)}</h2><p>${esc(fact.name)}</p></div><span class="abc-tag ${fact.xyz === "N" ? "low" : ""}">${fact.abc}${fact.xyz}</span></div><div class="detail-section"><h3>产品判断</h3><div class="detail-grid"><div><span>未来 14 天预测</span><strong>${fmt(fact.forecast14, 1)}</strong></div><div><span>独立测试 WAPE</span><strong>${selectedWape == null ? "不足" : `${fmt(selectedWape, 1)}%`}</strong></div><div><span>净销售额 / 28D</span><strong>${fmt(fact.netSales28, 1)}</strong></div><div><span>销售成本 / 28D</span><strong>${fmt(fact.cogs28, 1)}</strong></div><div><span>毛利 / 28D</span><strong>${fmt(fact.grossMargin28, 1)}</strong></div><div><span>已知库存成本</span><strong>${fact.costCoverage ? fmt(fact.stockValue, 1) : "未知"}</strong></div><div><span>有效在手 / 提议量</span><strong>${hasValidStock ? fmt(fact.stock) : "未知"} / ${hasValidStock ? fmt(planQty) : "—"}</strong></div><div><span>风险 / 阻断门店</span><strong>${fact.riskStores} / ${fact.blockedStores}</strong></div><div><span>正向销量 / 退货</span><strong>${fmt(fact.sales28)} / ${fmt(fact.returnUnits28)}</strong></div></div></div><div class="detail-section"><h3>可核查建议</h3><p class="detail-note"><strong>${esc(fact.action.label)}：</strong>${esc(fact.action.reason)}</p><p class="panel-foot">ABC 基于当前大类或产品线的净销售额；${fact.xyz === "N" ? "销量样本不足，XYZ 不做波动判断" : `近 12 周 CV ${fmt(fact.cv, 2)}`}。单位成本覆盖 ${fmt(fact.costCoverage * 100, 1)}% 有效库存门店；金额缺失未填零。</p></div><div class="detail-section"><h3>门店状态 · 前 8 项</h3>${locations.map((item) => `<div class="detail-location"><span>${esc(item.location)}</span><span>${labels[item.kind]}</span><b>${item.stock === null ? "库存未知" : `${fmt(item.stock)} 在手`}</b></div>`).join("") || '<p class="panel-foot">没有门店库存项目。</p>'}<div class="decision-buttons"><button type="button" id="detail-forecast">查看预测 ↗</button><button type="button" id="detail-psi">查看 PSI ↗</button></div></div><div class="detail-section detail-actions"><h3>人工决定</h3><label>核查依据 / 备注<textarea id="action-note" placeholder="例如：已核对在途和促销计划；仍需供应商确认">${esc(state.notes.get(fact.sku) ?? decision?.note ?? "")}</textarea></label><div class="decision-buttons"><button type="button" id="action-include">纳入行动单</button><button type="button" id="action-hold">暂缓核查</button><button type="button" id="action-reject">不采纳</button></div><p id="decision-message" class="decision-message">${decision ? `已记录：${decision.status === "included" ? "纳入行动单" : decision.status === "hold" ? "暂缓" : "不采纳"} · ${esc(decision.timestamp)}` : "决定只保存在当前会话；导出前仍需企业流程复核。"}</p></div>`;
  $("#detail-forecast").addEventListener("click", () => { state.sku = fact.sku; announceUpdate(`已查看 SKU ${fact.sku} 的预测证据。`); renderAll(); switchView("forecast", { scroll: true }); });
  $("#detail-psi").addEventListener("click", () => { state.sku = fact.sku; announceUpdate(`已查看 SKU ${fact.sku} 的供需情景。`); renderAll(); switchView("psi", { scroll: true }); });
  $("#action-note").addEventListener("input", (event) => state.notes.set(fact.sku, event.target.value));
  for (const [id, status] of [["action-include", "included"], ["action-hold", "hold"], ["action-reject", "rejected"]]) $("#" + id).addEventListener("click", () => decideAction(fact, status));
}

function decideAction(fact, status) {
  const note = $("#action-note").value.trim();
  if (!note) { $("#decision-message").textContent = "请写明核查依据或暂缓原因，方便下一位计划员接续。"; return; }
  state.notes.set(fact.sku, note);
  state.decisions.set(fact.sku, { status, note, majorCategory: fact.majorCategory, category: fact.category, classificationScope: state.category || state.major,
    abc: fact.abc, xyz: fact.xyz, asOf: state.plan.prepared.asOf, service: state.service, policy: state.policy,
    recommendation: fact.action.label, timestamp: new Date().toLocaleString("zh-CN"), trace: scenarioTrace() });
  renderSkuDetail(); renderActionRows(); renderReview(); $("#review-count").textContent = String(state.decisions.size);
}

function renderData() {
  const result = state.plan.result, dataset = state.dataset;
  $("#clear-evidence").disabled = mode() !== "uploaded" || !state.evidenceVersion;
  $("#quality-count").textContent = `${result.issues.length} 条`;
  const stats = [[dataset.sales?.length || 0, "销售行"], [dataset.inventory?.length || 0, "库存行"], [dataset.products?.length || 0, "商品行"], [dataset.inbound?.length || 0, "在途行"], [result.summary.skus, "SKU"], [result.summary.blocked, "阻断项目"]];
  $("#data-stats").innerHTML = stats.map(([value, label]) => `<div><b>${fmt(value)}</b><span>${label}</span></div>`).join("");
  const grouped = result.issues.reduce((map, issue) => { const key = `${issue.code}:${issue.severity}`; if (!map.has(key)) map.set(key, { ...issue, count: 0 }); map.get(key).count++; return map; }, new Map());
  $("#quality-list").innerHTML = [...grouped.values()].sort((a, b) => ({ error: 0, warning: 1, info: 2 }[a.severity] - ({ error: 0, warning: 1, info: 2 }[b.severity]))).map((issue) => `<div class="quality-item"><b class="${issue.severity}">${issue.severity === "error" ? "阻断" : issue.severity === "warning" ? "警告" : "信息"}</b><p>${esc(issue.message)}${issue.count > 1 ? ` · 同类 ${fmt(issue.count)} 条` : ""}</p></div>`).join("") || '<p class="panel-foot">没有格式问题；仍须核对业务口径。</p>';
}

function renderEvidence() {
  const dataset = state.dataset, items = scopeItems();
  const report = summarizeOperationalEvidence(dataset, state.plan, scenarioId(), items, Math.min(config().horizon, 14));
  const { rows, coverage: covered, forecast, exposure, gap, execution } = report;
  const metric = (label, value, note, unavailable = false) => `<div class="evidence-card ${unavailable ? "unavailable" : ""}"><small>${esc(label)}</small><b>${esc(value)}</b><p>${esc(note)}</p></div>`;
  const missing = (value, count, label) => count ? value : "未提供";
  const actualCount = (value) => (dataset.actuals || []).length ? `${fmt(value)} 项` : "未提供";
  const observedError = forecast.wape === null ? (dataset.actuals || []).length ? "证据不足" : "未提供" : `${fmt(forecast.wape, 1)}% / ${fmt(forecast.bias, 1)}%`;
  const promotionError = (group) => {
    if (!(dataset.promotions || []).length) return "未提供日历";
    const evidence = forecast.byPromotion[group];
    return evidence.count ? `${evidence.wape === null ? "证据不足" : `${fmt(evidence.wape, 1)}% / ${fmt(evidence.bias, 1)}%`}（${fmt(evidence.count)} 项）` : "无可比项";
  };
  const inboundKnownEmpty = mode() !== "demo" && dataset.meta.inboundConfirmed && !(dataset.inbound || []).length;
  $("#evidence-status").innerHTML = `<strong>当前范围 · ${esc(scopeName())}</strong>　计划数据 ${esc(state.dataVersion.slice(0, 12))} · 情景 ${esc(scenarioId())} · 运营证据 ${esc(state.evidenceVersion ? state.evidenceVersion.slice(0, 12) : "未接入")}。只比较与当前情景编号和 SKU × 门店匹配的执行行；后续实际只比较快照后 14 天内有记录的日期。`;
  $("#evidence-coverage").innerHTML = [
    metric("PO / ETA", rows.openPo ? fmt(rows.openPo) : inboundKnownEmpty ? "0 · 已确认" : "未提供", "来自在途 CSV；过期 ETA 不作已到货", !rows.openPo && !inboundKnownEmpty),
    metric("可售库存", covered.available ? `${fmt(covered.available)} / ${fmt(covered.items)}` : "未提供", "SKU × 门店覆盖；缺失时 PSI 以在手作代理", !covered.available),
    metric("供应商交期 / MOQ", covered.supplierLead || covered.moq ? `${fmt(covered.supplierLead)} / ${fmt(covered.moq)}` : "未提供", `在 ${fmt(covered.skus)} 个有计划地点的 SKU 中分别有明确字段`, !covered.supplierLead && !covered.moq),
    metric("促销日历", missing(fmt(rows.promotions), (dataset.promotions || []).length), "仅标注，未自动推定促销提升量", !(dataset.promotions || []).length),
    metric("后续实际与缺货暴露", missing(fmt(rows.actuals), (dataset.actuals || []).length), "有记录的日 × 门店 × SKU；非全量日历", !(dataset.actuals || []).length),
    metric("执行回执", (dataset.executions || []).length ? `${fmt(rows.executions)} 匹配 / ${fmt(dataset.executions.length)} 导入` : "未提供", "只计当前情景编号的匹配记录", !(dataset.executions || []).length),
  ].join("");
  $("#evidence-comparisons").innerHTML = `<div class="evidence-panel"><h2>预测 ↔ 后续观测</h2><div class="detail-row"><span>可比较的日 × 门店 × SKU</span><strong>${actualCount(forecast.compared)}</strong></div><div class="detail-row"><span>缺货损失未测或闭店日，已排除</span><strong>${actualCount(forecast.censored)}</strong></div><div class="detail-row"><span>后续观测 WAPE / Bias</span><strong>${observedError}</strong></div><div class="detail-row"><span>已标注促销日 / 其余有记录日 WAPE / Bias</span><strong>${promotionError("promoted")} / ${promotionError("regular")}</strong></div><div class="detail-row"><span>记录的缺货暴露</span><strong>${exposure.rate === null ? "未提供" : `${fmt(exposure.outOfStockHours, 1)} / ${fmt(exposure.openHours, 1)} 小时`}</strong></div><p>WAPE 和 Bias 只在各组可比项观测需求 ≥10 件时显示；Bias 为预测减观测，正值表示高估。其余有记录日不等于已证实的非促销日。分组只是误差诊断，不代表促销造成误差。缺货日只有明确记录 observed_unmet_units 才能把售出量加上已测损失；否则销量被视为截尾，不能当完整需求。</p></div><div class="evidence-panel"><h2>建议 ↔ 执行 ↔ 缺口</h2><div class="detail-row"><span>匹配项目的情景建议 / 实际下单</span><strong>${execution.matchedItems ? `${fmt(execution.suggestedOnMatched)} / ${fmt(execution.ordered)} 件` : "未提供"}</strong></div><div class="detail-row"><span>已收 / 按 ETA 到货</span><strong>${execution.matchedItems ? `${fmt(execution.received)} 件 / ${execution.datedReceipts ? `${execution.onTime}/${execution.datedReceipts} 行` : "暂无到货日"}` : "未提供"}</strong></div><div class="detail-row"><span>同日模拟缺口 / 已测缺口</span><strong>${gap.compared ? `${fmt(gap.simulated, 1)} / ${fmt(gap.observed, 1)} 件` : "不可比较"}</strong></div><div class="detail-row"><span>有已测缺口的可对照日期</span><strong>${actualCount(gap.compared)}</strong></div><p>建议与执行只作匹配行的描述性对账；建议并非采购单。模拟缺口以计划假设计算，真实收货、调拨与促销可能不同，差异不能直接归因于模型。</p></div>`;
  $("#evidence-caveat").innerHTML = `<strong>P1 当前证据边界</strong>　${mode() === "demo" ? "公开样本没有真实 PO、可售量、促销日历、缺货暴露或执行回执；这些指标显示未提供。" : mode() === "synthetic" ? "本视图的可售量、PO、促销、后续销量、缺货和执行回执均由固定规则虚构；误差、延误和缺口差异是教学示例，不代表企业效果。" : "导入文件通过结构和关联校验，但来源真实性、完整性与业务定义仍需企业系统核对。"} 促销未进入预测特征，缺货暴露也未反推潜在需求。当前计算只覆盖 14 天原生预测，长期服务目标仍未经实际结果校准。`;
}

function renderReview() {
  const gate = reviewGate(), decisions = [...state.decisions.entries()];
  $("#review-gate").innerHTML = `<strong>${gate.allowed ? "可导出待复核行动" : "行动导出暂停"}</strong>　${esc(gate.reason)}`;
  $("#reviewed-count").textContent = `${decisions.length} 项`;
  $("#review-log").innerHTML = decisions.length ? decisions.map(([sku, decision]) => `<div class="review-item"><div><strong>${esc(sku)} · ${esc(decision.recommendation)}</strong><small>${esc(decision.majorCategory)} / ${esc(decision.category)} · ABC 范围 ${esc(decision.classificationScope)} · ${esc(decision.note)} · ${esc(decision.timestamp)}</small><small>${esc(decision.trace.scenarioId)} · 数据 ${esc(decision.trace.dataVersion.slice(0, 12))} · ${esc(decision.trace.forecastVersion)} · 服务目标 ${decision.trace.assumptions.serviceLevel}%</small></div><b>${decision.status === "included" ? "纳入行动" : decision.status === "hold" ? "暂缓" : "不采纳"}</b></div>`).join("") : '<p class="panel-foot">暂无人工决定。前往品类行动台选择 SKU 并记录依据。</p>';
  $("#export-decisions").disabled = !gate.allowed || !decisions.length;
  $("#export-message").textContent = mode() === "demo" ? "演示输出带 DEMO 标记；不会创建采购单。" : mode() === "synthetic" ? "合成输出带 SYNTHETIC 标记；所有记录虚构，不会创建采购单。" : "文件只在浏览器生成；正式动作请走企业审批。";
}

function renderAll() { populateScope(); renderShell(); renderForecast(); renderPsi(); renderCategory(); renderData(); renderEvidence(); renderReview(); }

function switchView(view, { scroll = false } = {}) {
  state.view = view;
  for (const name of ["forecast", "psi", "category", "data", "evidence", "review"]) $("#" + name + "-view").hidden = name !== view;
  $$('[data-view]').forEach((button) => { const active = button.dataset.view === view; button.classList.toggle("active", active); if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current"); });
  if (state.plan) renderShell();
  const url = new URL(location.href); url.hash = view; history.replaceState(null, "", url);
  if (scroll) $("#decision-context").scrollIntoView({ block: "start", behavior: "smooth" });
}

function recompute(clearDecisions = true) {
  if (!state.dataset) return;
  const settings = config();
  const selected = buildPlanning(state.dataset, settings, state.policy);
  if (selected.result.fatal) { $("#loading").hidden = false; $("#loading").textContent = selected.result.fatal; $("#workspace").hidden = true; return; }
  const comparisons = new Map([[state.service, selected]]);
  for (const service of [90, 95, 98]) if (!comparisons.has(service)) comparisons.set(service, buildPlanning(state.dataset, { ...settings, serviceLevel: service }, state.policy, { facts: false }));
  state.plan = selected; state.comparisons = comparisons; state.scopeFactsCache.clear();
  if (clearDecisions) { state.decisions.clear(); state.notes.clear(); }
  $("#loading").hidden = true; $("#workspace").hidden = false;
  renderAll();
}

function download(filename, content) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const traceHeaders = ["data_sha256", "forecast_version", "psi_rule_version", "scenario_id", "model_policy", "horizon_days", "default_lead_time_days", "review_days", "buffer_days", "max_order_units"];
function traceValues(trace) {
  const { assumptions: a } = trace;
  return [trace.dataVersion, trace.forecastVersion, trace.psiVersion, trace.scenarioId, a.policy, a.horizon, a.leadTime, a.reviewDays, a.bufferDays, a.maxOrderUnits];
}

function exportRegister() {
  const trace = scenarioTrace();
  const rows = [["record_type", "data_mode", "as_of", ...traceHeaders, "major_category", "product_line", "sku", "product", "abc", "abc_scope", "xyz", "sales_28d", "net_sales_28d", "cogs_28d", "return_units_28d", "known_stock", "known_stock_cost", "cost_coverage_pct", "forecast_14d", "unmapped_forecast_14d", "forecast_model", "selection_wape_pct", "independent_test_wape_pct", "risk_stores", "blocked_stores", "overstock_stores", "service_target_pct", "scenario_order_units", "recommendation"]];
  for (const fact of categoryFacts()) { const model = chosenModel(fact.evidence, state.policy), modelEvidence = fact.evidence.models?.[model];
    rows.push(["ANALYSIS_NOT_ORDER", mode(), state.plan.prepared.asOf, ...traceValues(trace), fact.majorCategory, fact.category, fact.sku, fact.name, fact.abc, state.category || state.major, fact.xyz, fact.sales28, fact.netSales28, fact.cogs28, fact.returnUnits28, fact.items.some((item) => !item.blocker) ? fact.stock : "", fact.costCoverage ? fact.stockValue : "", (fact.costCoverage * 100).toFixed(1), fact.forecast14, fact.unmappedForecast14, model, modelEvidence?.selectionWape ?? "", modelEvidence?.wape ?? "", fact.riskStores, fact.blockedStores, fact.overstockStores, state.service, sum(fact.items.map((item) => item.allocatedQty)), fact.action.label]); }
  download(`category-register-${state.plan.prepared.asOf}.csv`, toCSV(rows));
}

function exportDecisions() {
  if (!reviewGate().allowed || !state.decisions.size) return;
  const facts = new Map(state.plan.skuFacts.map((fact) => [fact.sku, fact]));
  const rows = [["record_type", "data_mode", "as_of", ...traceHeaders, "major_category", "product_line", "sku", "abc", "abc_scope", "xyz", "sales_28d", "net_sales_28d", "cogs_28d", "return_units_28d", "forecast_14d", "unmapped_forecast_14d", "model", "selection_wape_pct", "independent_test_wape_pct", "service_target_pct", "scenario_order_units", "known_order_cost", "order_cost_coverage_pct", "risk_stores", "data_blockers", "recommendation", "human_decision", "review_note", "reviewed_at"]];
  for (const [sku, decision] of state.decisions) {
    const fact = facts.get(sku); if (!fact) continue;
    const orderQty = sum(fact.items.map((item) => item.allocatedQty));
    const costedQty = sum(fact.items.filter((item) => item.unitCost !== null).map((item) => item.allocatedQty));
    const knownCost = sum(fact.items.filter((item) => item.unitCost !== null).map((item) => item.allocatedQty * item.unitCost));
    const model = chosenModel(fact.evidence, decision.policy), modelEvidence = fact.evidence.models?.[model];
    rows.push([mode() === "demo" ? "DEMO_ACTION_NOT_ORDER" : mode() === "synthetic" ? "SYNTHETIC_ACTION_NOT_ORDER" : "DRAFT_ACTION_NOT_ORDER", mode(), decision.asOf, ...traceValues(decision.trace), fact.majorCategory, fact.category, sku, decision.abc, decision.classificationScope, decision.xyz, fact.sales28, fact.netSales28, fact.cogs28, fact.returnUnits28, fact.forecast14, fact.unmappedForecast14, model, modelEvidence?.selectionWape ?? "", modelEvidence?.wape ?? "", decision.service, orderQty, orderQty && costedQty === 0 ? "" : knownCost, orderQty ? (costedQty / orderQty * 100).toFixed(1) : "", fact.riskStores, fact.blockedStores, decision.recommendation, decision.status, decision.note, decision.timestamp]);
  }
  download(`reviewed-category-actions-${state.plan.prepared.asOf}.csv`, toCSV(rows));
}

function resetScenarioControls() {
  state.policy = "auto"; state.service = 95;
  for (const [id, value] of [["horizon", 14], ["lead-time", 14], ["review-days", 7], ["buffer-days", 7], ["max-order", 0]]) $("#" + id).value = value;
}

function setCaseQuery(enabled) {
  const url = new URL(location.href);
  if (enabled) url.searchParams.set("case", "synthetic"); else url.searchParams.delete("case");
  history.replaceState(null, "", url);
}

async function loadSyntheticCase() {
  const asOf = addDays(today(), -7), fixture = createSyntheticCase(asOf);
  resetScenarioControls();
  announceUpdate("已切换至完全虚构的合成 P1 案例；公开样本已退出当前工作区。");
  state.dataset = fixture.plan;
  state.dataVersion = await sha256Hex(JSON.stringify({ version: SYNTHETIC_CASE_VERSION, asOf,
    sales: fixture.plan.sales, inventory: fixture.plan.inventory, products: fixture.plan.products, inbound: fixture.plan.inbound }));
  state.evidenceVersion = ""; state.major = ""; state.category = ""; state.sku = "";
  state.selectedActionSku = ""; state.segment = ""; state.actionPage = 0;
  recompute(true);
  const candidate = bindSyntheticEvidence(fixture.plan, fixture.evidence, scenarioId());
  const check = validateOperationalEvidence(candidate, asOf, today());
  if (check.errors.length) throw new Error(`合成案例校验失败：${check.errors.join("；")}`);
  state.dataset = candidate;
  state.evidenceVersion = await sha256Hex(JSON.stringify({ version: SYNTHETIC_CASE_VERSION, evidence: fixture.evidence, scenarioId: scenarioId() }));
  renderShell(); renderEvidence(); renderData(); renderReview();
  setCaseQuery(true); switchView("evidence");
  $("#intake-message").textContent = "已切换到独立合成案例；公开样本未与其合并。";
}

async function applyFiles() {
  const sales = $("#file-sales").files[0], inventory = $("#file-inventory").files[0], products = $("#file-products").files[0];
  if (!sales || !inventory || !products) { $("#intake-message").textContent = "请先选择销售、库存和商品主数据文件。"; return; }
  try {
    const files = { sales, inventory, products, inbound: $("#file-inbound").files[0] };
    const parsed = {}, raw = [];
    for (const [kind, file] of Object.entries(files)) { const content = file ? await file.text() : "";
      raw.push(`${kind}\u001f${content}`); parsed[kind] = file ? parseUpload(kind, content) : []; }
    if (!parsed.products.length || parsed.products.some((row) => !row.sku || !row.major_category || !row.category || !row.name)) throw new Error("商品主数据需提供非空 SKU、大类、产品线和名称。");
    const dataset = { schemaVersion: 1, meta: { mode: "uploaded", source: "浏览器本地 CSV", inboundConfirmed: parsed.inbound.length > 0 || $("#no-inbound-confirm").checked }, ...parsed, promotions: [], actuals: [], executions: [] };
    const check = buildPlanning(dataset, config(), state.policy);
    if (check.result.fatal || !check.result.items.length) throw new Error(check.result.fatal || "没有可分析的 SKU × 门店记录");
    state.dataset = dataset; state.dataVersion = await sha256Hex(JSON.stringify(raw)); state.evidenceVersion = ""; state.major = ""; state.category = ""; state.sku = ""; state.selectedActionSku = ""; state.segment = ""; state.actionPage = 0;
    announceUpdate("本地 CSV 已载入；当前数据范围与证据版本已更新。");
    setCaseQuery(false); recompute(true); switchView("forecast");
    $("#intake-message").textContent = `已加载 ${fmt(parsed.sales.length)} 条销售、${fmt(parsed.inventory.length)} 条库存；${fmt(state.plan.result.summary.blocked)} 个库存项目待修复。`;
  } catch (error) { $("#intake-message").textContent = `加载失败：${error.message}`; }
}

async function applyEvidenceFiles() {
  if (mode() !== "uploaded") { $("#evidence-intake-message").textContent = "先加载自己的销售、库存和商品数据；公开样本与合成案例都不会与上传的运营证据混合。"; return; }
  const kinds = ["promotions", "actuals", "executions"];
  if (!kinds.some((kind) => $("#file-" + kind).files[0])) { $("#evidence-intake-message").textContent = "请先选择至少一份运营证据 CSV。"; return; }
  try {
    const extra = {};
    for (const kind of kinds) {
      const file = $("#file-" + kind).files[0];
      extra[kind] = file ? parseUpload(kind, await file.text()) : state.dataset[kind] || [];
    }
    const candidate = { ...state.dataset, ...extra };
    const check = validateOperationalEvidence(candidate, state.plan.prepared.asOf, today());
    if (check.errors.length) throw new Error(check.errors.slice(0, 3).join("；") + (check.errors.length > 3 ? `（另有 ${check.errors.length - 3} 项）` : ""));
    state.dataset = candidate;
    state.evidenceVersion = await sha256Hex(JSON.stringify(extra));
    renderEvidence(); renderData();
    $("#evidence-intake-message").textContent = `已接入 ${fmt(extra.promotions.length)} 条促销、${fmt(extra.actuals.length)} 条后续实际、${fmt(extra.executions.length)} 条执行回执。计划情景编号未改变。${check.warnings.length ? " " + check.warnings.join(" ") : ""}`;
    switchView("evidence");
  } catch (error) { $("#evidence-intake-message").textContent = `接入失败：${error.message}`; }
}

function restoreDemo() {
  resetScenarioControls(); setCaseQuery(false);
  announceUpdate("已恢复 Mendeley 公开样本；当前范围与情景参数已重置。");
  state.dataset = state.demoData; state.dataVersion = state.demoVersion; state.evidenceVersion = ""; state.major = ""; state.category = ""; state.sku = ""; state.selectedActionSku = ""; state.segment = ""; state.actionPage = 0;
  recompute(true); switchView("forecast"); $("#intake-message").textContent = "已恢复公开样本；之前导入的数据已离开当前工作区。";
}

function bind() {
  const viewNames = { forecast: "预测擂台", psi: "PSI 决策台", category: "品类行动台", data: "数据接入", evidence: "执行证据", review: "人工复核" };
  $$('[data-view]').forEach((button) => button.addEventListener("click", () => { announceUpdate(`已进入${viewNames[button.dataset.view]}；上方摘要与口径已切换。`); switchView(button.dataset.view, { scroll: true }); }));
  window.addEventListener("hashchange", () => { const view = location.hash.slice(1); if (["forecast", "psi", "category", "data", "evidence", "review"].includes(view) && view !== state.view) { announceUpdate(`已进入${viewNames[view]}；上方摘要与口径已切换。`); switchView(view, { scroll: true }); } });
  $("#edit-scope").addEventListener("click", () => { const panel = $(".scope-panel"); panel.open = true; panel.scrollIntoView({ block: "start", behavior: "smooth" }); $("#scope-major").focus({ preventScroll: true }); });
  $("#scope-major").addEventListener("change", (event) => { state.major = event.target.value; state.category = ""; state.sku = ""; state.selectedActionSku = ""; state.segment = ""; state.actionPage = 0; announceUpdate(`业务大类已切换至 ${state.major}；产品线、SKU 与所有视图已同步更新。`); renderAll(); });
  $("#scope-category").addEventListener("change", (event) => { state.category = event.target.value; state.sku = ""; state.selectedActionSku = ""; state.segment = ""; state.actionPage = 0; announceUpdate(`产品线已切换至 ${state.category || "全部产品线"}；模型证据与行动清单已更新。`); renderAll(); });
  $("#scope-sku").addEventListener("change", (event) => { state.sku = event.target.value; state.selectedActionSku = state.sku; state.segment = ""; state.actionPage = 0; announceUpdate(`产品范围已切换至 ${state.sku || "当前范围全部 SKU"}；预测、PSI 与品类指标按新范围汇总。`); renderAll(); });
  $("#model-policy").addEventListener("change", (event) => { state.policy = event.target.value; announceUpdate(`需求模型已切换至 ${state.policy === "auto" ? "择优 / 守护" : modelLabels[state.policy]}；PSI 已重算，待复核动作已清空。`); recompute(true); });
  const parameterLabels = { horizon: "模拟窗口", "lead-time": "默认交期", "review-days": "复盘周期", "buffer-days": "额外缓冲", "max-order": "补货容量上限" };
  let parameterTimer, lastParameterConfig = JSON.stringify(config());
  const applyParameter = (id) => {
    const field = $("#" + id), nextConfig = JSON.stringify(config());
    if (!field.validity.valid || field.value === "" || nextConfig === lastParameterConfig) return;
    lastParameterConfig = nextConfig;
    announceUpdate(`${parameterLabels[id]}已改为 ${field.value}；PSI 与品类风险已重算。`);
    recompute(true);
  };
  for (const id of Object.keys(parameterLabels)) {
    const field = $("#" + id);
    field.addEventListener("input", () => { clearTimeout(parameterTimer); parameterTimer = setTimeout(() => applyParameter(id), 450); });
    field.addEventListener("change", () => { clearTimeout(parameterTimer); applyParameter(id); });
  }
  $("#forecast-search").addEventListener("input", () => { renderForecastProducts(); announceUpdate(`SKU 需求列表已筛选；当前 ${$("#forecast-list-note").textContent}`); });
  for (const id of ["action-search", "action-sort", "action-filter"]) $("#" + id).addEventListener(id === "action-search" ? "input" : "change", () => { state.actionPage = 0; renderActionRows(); announceUpdate(`行动清单已更新 · ${$("#action-count").textContent}；排序与筛选只改变当前列表。`); });
  $("#clear-segment").addEventListener("click", () => { state.segment = ""; state.actionPage = 0; renderMatrix(); renderActionRows(); announceUpdate(`已清除 ABC–XYZ 分层筛选 · ${$("#action-count").textContent}`); renderContext(scopeFacts(), scopeItems()); });
  $("#action-prev").addEventListener("click", () => { state.actionPage--; renderActionRows(); });
  $("#action-next").addEventListener("click", () => { state.actionPage++; renderActionRows(); });
  for (const kind of ["sales", "inventory", "products", "inbound", "promotions", "actuals", "executions"]) $("#file-" + kind).addEventListener("change", (event) => { $("#name-" + kind).textContent = event.target.files[0]?.name || "未选择"; });
  $("#apply-files").addEventListener("click", applyFiles); $("#apply-evidence").addEventListener("click", applyEvidenceFiles); $("#restore-demo").addEventListener("click", restoreDemo);
  $("#load-synthetic").addEventListener("click", () => loadSyntheticCase().catch((error) => { $("#loading").hidden = false; $("#loading").textContent = error.message; }));
  $("#clear-evidence").addEventListener("click", () => { if (mode() !== "uploaded") return; state.dataset = { ...state.dataset, promotions: [], actuals: [], executions: [] }; state.evidenceVersion = ""; for (const kind of ["promotions", "actuals", "executions"]) { $("#file-" + kind).value = ""; $("#name-" + kind).textContent = "未选择"; } renderEvidence(); renderData(); $("#evidence-intake-message").textContent = "已清除本次运营证据；计划数据与情景编号保持不变。"; });
  $("#download-templates").addEventListener("click", () => { const a = document.createElement("a"); a.href = "templates.zip"; a.download = "planning-workbench-csv-templates.zip"; document.body.append(a); a.click(); a.remove(); });
  $("#export-register").addEventListener("click", exportRegister); $("#export-decisions").addEventListener("click", exportDecisions);
}

async function init() {
  try {
    const response = await fetch("demo.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const raw = await response.text(), demo = JSON.parse(raw);
    if (demo.schemaVersion !== 1) throw new Error("演示数据结构版本不匹配");
    state.demoData = demo; state.dataset = demo; state.demoVersion = await sha256Hex(raw); state.dataVersion = state.demoVersion;
    bind();
    recompute(true);
    if (new URL(location.href).searchParams.get("case") === "synthetic") { await loadSyntheticCase(); return; }
    const hash = location.hash.slice(1);
    switchView(({ overview: "forecast", queue: "category", approval: "review" })[hash] || (["forecast", "psi", "category", "data", "evidence", "review"].includes(hash) ? hash : "forecast"));
  } catch (error) { $("#loading").innerHTML = `工作台未能载入。请从本地服务器访问。<br><small>${esc(error.message)}</small>`; $("#workspace").hidden = true; }
}

init();
