const DAY = 86_400_000;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const keyOf = (location, sku) => `${location}\u001f${sku}`;
export const lineKey = (major, category) => `${major}\u001f${category}`;
const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const sum = (values) => values.reduce((a, b) => a + b, 0);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = (value, digits = 2) => Number(value.toFixed(digits));

export function addDays(iso, days) {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export function daysBetween(start, end) { return Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / DAY); }
export function validDate(value) { return datePattern.test(String(value)) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value; }

export function parseCSV(text) {
  const input = String(text).replace(/^\uFEFF/, "");
  const rows = []; let row = [], field = "", quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ""; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++;
      row.push(field); field = "";
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
    } else field += char;
  }
  if (quoted) throw new Error("CSV 引号未闭合");
  row.push(field);
  if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  if (!rows.length) throw new Error("CSV 为空");
  const headers = rows.shift().map((cell) => cell.trim().toLowerCase());
  if (new Set(headers).size !== headers.length) throw new Error("CSV 表头重复");
  return { headers, records: rows.map((cells, index) => Object.fromEntries(headers.map((header, i) => [header, (cells[i] ?? "").trim()]))).map((record, index) => ({ ...record, _row: index + 2 })) };
}

export const contracts = {
  sales: ["date", "location", "sku", "units", "net_sales", "cogs"],
  inventory: ["as_of", "location", "sku", "on_hand"],
  products: ["sku", "major_category", "category", "name"],
  inbound: ["eta", "location", "sku", "units"],
  promotions: ["promo_id", "start_date", "end_date", "location", "sku"],
  actuals: ["date", "location", "sku", "sold_units", "open_hours", "out_of_stock_hours"],
  executions: ["scenario_id", "location", "sku", "ordered_units", "eta", "received_units", "receipt_date"],
};

export function parseUpload(kind, text) {
  if (!contracts[kind]) throw new Error(`未知文件类型 ${kind}`);
  const parsed = parseCSV(text);
  const missing = contracts[kind].filter((header) => !parsed.headers.includes(header));
  if (missing.length) throw new Error(`缺少列：${missing.join(", ")}`);
  return parsed.records;
}

function solve(matrix, vector) {
  const size = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < size; col++) {
    let pivot = col;
    for (let row = col + 1; row < size; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < 1e-9) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col];
    for (let j = col; j <= size; j++) a[col][j] /= divisor;
    for (let row = 0; row < size; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let j = col; j <= size; j++) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row[size]);
}

function features(history, dayIndex, weekday, level) {
  const recent7 = mean(history.slice(dayIndex - 7, dayIndex));
  const recent28 = mean(history.slice(dayIndex - 28, dayIndex));
  return [history[dayIndex - 1] / level, history[dayIndex - 7] / level, recent7 / level, recent28 / level,
    (recent7 - recent28) / level, Math.sin(weekday * Math.PI * 2 / 7), Math.cos(weekday * Math.PI * 2 / 7), 1];
}

export const forecastModels = [
  { id: "seasonal7", label: "上周同日", family: "朴素基线" },
  { id: "moving28", label: "28 天移动平均", family: "移动平均" },
  { id: "weekday4", label: "四周同星期", family: "移动平均" },
  { id: "holtWinters", label: "Holt-Winters · 周季节", family: "指数平滑" },
  { id: "linearTrend", label: "趋势＋星期回归", family: "回归" },
  { id: "ridge", label: "岭回归 · 滞后特征", family: "机器学习" },
  { id: "boostedStumps", label: "浅树梯度提升", family: "机器学习" },
];
const modelLabels = Object.fromEntries(forecastModels.map(({ id, label }) => [id, label]));
const baselineKinds = ["seasonal7", "moving28", "weekday4"];

function weekdayAt(startDate, index) {
  const first = new Date(`${startDate}T12:00:00Z`).getUTCDay();
  return (first + index) % 7;
}

function ridgeFit(series, startDate, end) {
  const level = Math.max(1, mean(series.slice(0, end)));
  const width = 8;
  const matrix = Array.from({ length: width }, () => Array(width).fill(0));
  const vector = Array(width).fill(0);
  for (let t = 28; t < end; t++) {
    const weekday = new Date(`${addDays(startDate, t)}T12:00:00Z`).getUTCDay();
    const x = features(series, t, weekday, level), y = series[t] / level;
    for (let a = 0; a < width; a++) {
      vector[a] += x[a] * y;
      for (let b = 0; b < width; b++) matrix[a][b] += x[a] * x[b];
    }
  }
  for (let i = 0; i < width - 1; i++) matrix[i][i] += 3;
  matrix[width - 1][width - 1] += .001;
  return { beta: solve(matrix, vector), level };
}

function linearFit(series, startDate) {
  const width = 8, matrix = Array.from({ length: width }, () => Array(width).fill(0)), vector = Array(width).fill(0);
  for (let t = 0; t < series.length; t++) {
    const weekday = weekdayAt(startDate, t);
    const x = [1, (t - series.length + 1) / 28, ...Array.from({ length: 6 }, (_, index) => Number(weekday === index + 1))];
    for (let a = 0; a < width; a++) {
      vector[a] += x[a] * series[t];
      for (let b = 0; b < width; b++) matrix[a][b] += x[a] * x[b];
    }
  }
  return solve(matrix, vector);
}

function holtWintersFit(series) {
  const period = 7, initial = series.slice(0, 28), next = series.slice(28, 56);
  const initialLevel = mean(initial);
  let level = mean(next), trend = (level - initialLevel) / 28;
  const pattern = Array.from({ length: period }, (_, weekday) => mean(initial.filter((_, index) => index % period === weekday)) - initialLevel);
  const season = Array.from({ length: series.length }, (_, index) => pattern[index % period]);
  const alpha = .25, beta = .05, gamma = .15;
  for (let t = 56; t < series.length; t++) {
    const nextLevel = alpha * (series[t] - season[t - period]) + (1 - alpha) * (level + trend);
    const nextTrend = beta * (nextLevel - level) + (1 - beta) * trend;
    season[t] = gamma * (series[t] - nextLevel) + (1 - gamma) * season[t - period];
    level = nextLevel; trend = nextTrend;
  }
  return { level, trend, season };
}

function boostedFit(series, startDate) {
  const level = Math.max(1, mean(series)), inputs = [], targets = [];
  for (let t = 28; t < series.length; t++) {
    inputs.push(features(series, t, weekdayAt(startDate, t), level).slice(0, 7));
    targets.push(series[t] / level);
  }
  const base = mean(targets), residuals = targets.map((value) => value - base), stumps = [];
  const thresholds = Array.from({ length: 7 }, (_, feature) => {
    const ordered = inputs.map((row) => row[feature]).sort((a, b) => a - b);
    return [...new Set([.2, .4, .6, .8].map((fraction) => ordered[Math.floor(fraction * (ordered.length - 1))]))];
  });
  for (let iteration = 0; iteration < 12; iteration++) {
    let best = null;
    for (let feature = 0; feature < 7; feature++) for (const threshold of thresholds[feature]) {
      let leftSum = 0, leftCount = 0, rightSum = 0, rightCount = 0;
      for (let row = 0; row < inputs.length; row++) {
        if (inputs[row][feature] <= threshold) { leftSum += residuals[row]; leftCount++; }
        else { rightSum += residuals[row]; rightCount++; }
      }
      if (leftCount < 5 || rightCount < 5) continue;
      const gain = leftSum ** 2 / leftCount + rightSum ** 2 / rightCount;
      if (!best || gain > best.gain) best = { feature, threshold, left: leftSum / leftCount, right: rightSum / rightCount, gain };
    }
    if (!best || best.gain < 1e-8) break;
    const stump = { feature: best.feature, threshold: best.threshold, left: best.left * .25, right: best.right * .25 };
    stumps.push(stump);
    for (let row = 0; row < inputs.length; row++) residuals[row] -= inputs[row][stump.feature] <= stump.threshold ? stump.left : stump.right;
  }
  return { base, level, stumps };
}

function forecastBlock(kind, history, startDate, horizon) {
  const origin = history.length, path = [...history], future = [];
  const fit = kind === "ridge" ? ridgeFit(history, startDate, origin) : kind === "linearTrend" ? linearFit(history, startDate) :
    kind === "holtWinters" ? holtWintersFit(history) : kind === "boostedStumps" ? boostedFit(history, startDate) : null;
  for (let step = 0; step < horizon; step++) {
    const t = path.length, weekday = weekdayAt(startDate, t);
    let value;
    if (kind === "seasonal7") value = path[t - 7];
    else if (kind === "moving28") value = mean(path.slice(-28));
    else if (kind === "weekday4") value = mean([7, 14, 21, 28].map((lag) => path[t - lag]));
    else if (kind === "holtWinters") value = fit.level + (step + 1) * fit.trend + fit.season[origin - 7 + step % 7];
    else if (kind === "linearTrend") {
      const x = [1, (t - origin + 1) / 28, ...Array.from({ length: 6 }, (_, index) => Number(weekday === index + 1))];
      value = fit ? sum(x.map((feature, index) => feature * fit[index])) : path[t - 7];
    } else if (kind === "ridge") value = fit.beta ? sum(features(path, t, weekday, fit.level).map((feature, index) => feature * fit.beta[index])) * fit.level : path[t - 7];
    else {
      const x = features(path, t, weekday, fit.level);
      value = (fit.base + sum(fit.stumps.map((stump) => x[stump.feature] <= stump.threshold ? stump.left : stump.right))) * fit.level;
    }
    value = Math.max(0, Number.isFinite(value) ? value : 0);
    future.push(round(value, 3)); path.push(value);
  }
  return future;
}

export function categoryForecast(series, startDate, horizon = 14) {
  const recent28 = sum(series.slice(-28));
  const prior28 = sum(series.slice(-56, -28));
  const selectionHistory = series.slice(0, -28);
  const activeDays = selectionHistory.slice(-84).filter((value) => value > 0).length;
  const selectionUnits = sum(selectionHistory.slice(-56));
  if (series.length < 140 || sum(selectionHistory.slice(-84)) < 20 || activeDays < 10 || selectionUnits < 20) {
    const rate = recent28 > 0 ? recent28 / 28 : prior28 > 0 ? .5 * prior28 / 28 : 0;
    return { method: "average28", label: "低样本均值", wape: null, selectionWape: null, baselineWape: null, baselineSelectionWape: null, ridgeWape: null,
      factor: 1, future: Array(horizon).fill(round(rate, 3)), status: "insufficient_volume", models: {},
      holdoutActual: series.slice(-28), rollingWindows: [], selectionWindows: [], holdoutWindow: null,
      historyUnits84: sum(series.slice(-84)), selectionUnits };
  }
  const kinds = forecastModels.map((model) => model.id);
  function metrics(actual, predicted) {
    const denominator = sum(actual), reliable = denominator >= 10;
    return { wape: reliable ? round(sum(actual.map((value, index) => Math.abs(value - predicted[index]))) / denominator * 100, 1) : null,
      bias: reliable ? round((sum(predicted) - denominator) / denominator * 100, 1) : null,
      mae: round(mean(actual.map((value, index) => Math.abs(value - predicted[index]))), 2),
      backtest: predicted.map((value) => round(value, 2)) };
  }
  const selectionWindows = [];
  for (let index = 0; index < 2; index++) {
    const boundary = series.length - 84 + index * 28, end = boundary + 28;
    const actual = series.slice(boundary, end);
    const models = {};
    for (const kind of kinds) {
      const predicted = [...forecastBlock(kind, series.slice(0, boundary), startDate, 14),
        ...forecastBlock(kind, series.slice(0, boundary + 14), startDate, 14)];
      models[kind] = metrics(actual, predicted);
    }
    selectionWindows.push({ phase: "selection", start: addDays(startDate, boundary), end: addDays(startDate, end - 1), actualUnits: round(sum(actual)), models });
  }
  const selectionActual = series.slice(-84, -28);
  const selectionScores = Object.fromEntries(kinds.map((kind) => [kind, metrics(selectionActual,
    selectionWindows.flatMap((window) => window.models[kind].backtest))]));
  const bestBaseline = baselineKinds.reduce((best, kind) => selectionScores[kind].wape < selectionScores[best].wape ? kind : best, baselineKinds[0]);
  const winner = kinds.reduce((best, kind) => selectionScores[kind].wape < selectionScores[best].wape ? kind : best, kinds[0]);
  const weak = selectionScores[winner].wape > 60;
  const chosen = weak ? bestBaseline : winner;
  const boundary = series.length - 28, holdoutActual = series.slice(boundary), models = {};
  for (const kind of kinds) {
    const test = forecastBlock(kind, selectionHistory, startDate, 28);
    models[kind] = { ...metrics(holdoutActual, test), selectionWape: selectionScores[kind].wape,
      selectionBias: selectionScores[kind].bias, future: forecastBlock(kind, series, startDate, horizon) };
  }
  const holdoutWindow = { phase: "untouched_test", start: addDays(startDate, boundary), end: addDays(startDate, series.length - 1),
    actualUnits: round(sum(holdoutActual)), models: Object.fromEntries(kinds.map((kind) => [kind, { ...models[kind] }])) };
  const rollingWindows = [...selectionWindows, holdoutWindow];
  const future = models[chosen].future;
  const recent14 = sum(series.slice(-14));
  const factor = recent14 >= 5 ? clamp(sum(future.slice(0, 14)) / recent14, .6, 1.4) : 1;
  return { method: chosen, label: modelLabels[chosen], wape: models[chosen].wape, selectionWape: selectionScores[chosen].wape,
    baselineWape: models[bestBaseline].wape, baselineSelectionWape: selectionScores[bestBaseline].wape,
    ridgeWape: models.ridge.wape, factor: round(factor, 3), future, status: weak ? "weak_all_models" : ["ridge", "boostedStumps"].includes(winner) ? "ml_selected" : winner === "linearTrend" ? "regression_selected" : "baseline_selected",
    models, holdoutActual, rollingWindows, selectionWindows, holdoutWindow,
    historyUnits84: sum(series.slice(-84)), selectionUnits };
}

export function simulate(onHand, demandRate, asOf, horizon, inbound, orderQty = 0, leadTime = 0) {
  let stock = onHand, unmet = 0, fulfilled = 0, firstShortageDay = null;
  const path = [];
  for (let day = 1; day <= horizon; day++) {
    const date = addDays(asOf, day);
    stock += sum(inbound.filter((line) => line.eta === date).map((line) => line.units));
    if (orderQty > 0 && day === leadTime) stock += orderQty;
    const demand = Array.isArray(demandRate) ? (demandRate[day - 1] ?? demandRate[(day - 1 - 14) % 7 + 7] ?? 0) : demandRate;
    const served = Math.min(stock, demand);
    stock = Math.max(0, stock - served);
    fulfilled += served;
    const missed = demand - served;
    unmet += missed;
    if (missed > 1e-6 && firstShortageDay === null) firstShortageDay = day;
    path.push({ day, date, stock: round(stock, 2), unmet: round(unmet, 2) });
  }
  return { closing: round(stock, 2), unmet: round(unmet, 2), fulfilled: round(fulfilled, 2), firstShortageDay, path };
}

export function analyze(dataset, settings = {}) {
  const config = {
    horizon: clamp(Number(settings.horizon) || 28, 7, 90),
    leadTime: clamp(Number(settings.leadTime) || 14, 1, 90),
    reviewDays: clamp(Number(settings.reviewDays) || 7, 1, 60),
    bufferDays: clamp(Number(settings.bufferDays) || 7, 0, 60),
    serviceLevel: [90, 95, 98].includes(Number(settings.serviceLevel)) ? Number(settings.serviceLevel) : 95,
    maxOrderUnits: Math.max(0, Math.floor(Number(settings.maxOrderUnits) || 0)),
  };
  const issues = [];
  const addIssue = (severity, code, message, key = "") => issues.push({ severity, code, message, key });
  const rawInventory = Array.isArray(dataset.inventory) ? dataset.inventory : [];
  const validDates = rawInventory.map((record) => record.as_of).filter(validDate);
  const asOf = validDates.sort().at(-1);
  if (!asOf) return { fatal: "库存文件没有有效 as_of 日期", issues, items: [], summary: null };
  const products = new Map();
  for (const raw of dataset.products || []) {
    const sku = String(raw.sku || "").trim();
    if (!sku) { addIssue("error", "product_key", "商品主数据存在空 SKU"); continue; }
    if (products.has(sku)) { addIssue("warning", "product_duplicate", `商品主数据重复：${sku}`, sku); continue; }
    for (const [field, code] of [["lead_time_days", "lead_time_invalid"], ["case_pack", "case_pack_invalid"], ["min_order_qty", "moq_invalid"]]) {
      if (String(raw[field] ?? "").trim() && (!Number.isInteger(Number(raw[field])) || Number(raw[field]) <= 0)) addIssue("error", code, `商品 ${sku} 的 ${field} 必须是正整数`, sku);
    }
    products.set(sku, { sku, name: String(raw.name || sku), category: String(raw.category || "未归类"), majorCategory: String(raw.major_category || "未分大类"),
      unitCost: Number(raw.unit_cost) > 0 ? Number(raw.unit_cost) : null,
      leadTime: Number(raw.lead_time_days) > 0 ? Math.round(Number(raw.lead_time_days)) : null,
      casePack: Number(raw.case_pack) > 0 ? Math.round(Number(raw.case_pack)) : null,
      moq: Number(raw.min_order_qty) > 0 ? Math.round(Number(raw.min_order_qty)) : null });
  }
  const inventory = new Map(), duplicated = new Set();
  for (const raw of rawInventory) {
    const location = String(raw.location || "").trim(), sku = String(raw.sku || "").trim();
    if (!validDate(raw.as_of) || !location || !sku || String(raw.on_hand ?? "").trim() === "" || !Number.isFinite(Number(raw.on_hand))) { addIssue("error", "inventory_invalid", `库存行无效：${location || "?"} / ${sku || "?"}`); continue; }
    if (raw.as_of !== asOf) { addIssue("warning", "inventory_old", `旧库存快照已排除：${location} / ${sku} (${raw.as_of})`, keyOf(location, sku)); continue; }
    const key = keyOf(location, sku);
    if (inventory.has(key)) { duplicated.add(key); addIssue("error", "inventory_duplicate", `同一日重复库存：${location} / ${sku}`, key); continue; }
    const onHand = Number(raw.on_hand);
    const availableProvided = String(raw.available_units ?? "").trim() !== "";
    const available = availableProvided ? Number(raw.available_units) : null;
    if (availableProvided && (!Number.isFinite(available) || available < 0 || available > onHand)) {
      addIssue("error", "available_invalid", `可售库存需在 0 与在手之间：${location} / ${sku}`, key);
    }
    if (onHand < 0) addIssue("error", "negative_stock", `负库存需核实：${location} / ${sku} (${onHand})`, key);
    inventory.set(key, { location, sku, onHand, available, availableProvided,
      availableInvalid: availableProvided && (!Number.isFinite(available) || available < 0 || available > onHand),
      unitCost: Number(raw.unit_cost) > 0 ? Number(raw.unit_cost) : null });
  }
  const salesByKey = new Map(), returnsByKey = new Map(), categoryByDay = new Map();
  let lastSalesDate = null, returnRows = 0;
  for (const raw of dataset.sales || []) {
    const date = raw.date, location = String(raw.location || "").trim(), sku = String(raw.sku || "").trim(), units = Number(raw.units);
    if (!validDate(date) || !location || !sku || String(raw.units ?? "").trim() === "" || !Number.isFinite(units) ||
      String(raw.net_sales ?? "").trim() === "" || !Number.isFinite(Number(raw.net_sales)) ||
      String(raw.cogs ?? "").trim() === "" || !Number.isFinite(Number(raw.cogs))) {
      addIssue("error", "sales_invalid", `销售行无效或金额缺失（行 ${raw._row || "?"}）`); continue;
    }
    if (date > asOf) { addIssue("warning", "sales_future", `晚于库存快照的销售已排除：${date}`, keyOf(location, sku)); continue; }
    if (units < 0) {
      returnRows++;
      const key = keyOf(location, sku);
      if (!returnsByKey.has(key)) returnsByKey.set(key, []);
      returnsByKey.get(key).push({ date, units: Math.abs(units), netSales: Number(raw.net_sales) || 0, cogs: Number(raw.cogs) || 0 });
      continue;
    }
    if (units === 0) continue;
    const key = keyOf(location, sku);
    if (!salesByKey.has(key)) salesByKey.set(key, []);
    salesByKey.get(key).push({ date, units, netSales: Number(raw.net_sales) || 0, cogs: Number(raw.cogs) || 0 });
    lastSalesDate = lastSalesDate && lastSalesDate > date ? lastSalesDate : date;
    const product = products.get(sku);
    const category = lineKey(product?.majorCategory || "未分大类", product?.category || "未归类");
    if (!categoryByDay.has(category)) categoryByDay.set(category, new Map());
    categoryByDay.get(category).set(date, (categoryByDay.get(category).get(date) || 0) + units);
  }
  if (!lastSalesDate) addIssue("warning", "sales_empty", "没有可用的正向销售记录；预测与补货建议会停用");
  else if (daysBetween(lastSalesDate, asOf) > 7) addIssue("warning", "sales_stale", `最近销售记录距库存快照 ${daysBetween(lastSalesDate, asOf)} 天，预测可能失真`);
  if (returnRows) addIssue("info", "returns_excluded", `${returnRows} 条负销量 / 退货行已从需求预测中排除`);
  const inboundByKey = new Map();
  for (const raw of dataset.inbound || []) {
    const eta = raw.eta, location = String(raw.location || "").trim(), sku = String(raw.sku || "").trim(), units = Number(raw.units);
    if (!validDate(eta) || !location || !sku || !Number.isFinite(units) || units <= 0) { addIssue("error", "inbound_invalid", `在途行无效（行 ${raw._row || "?"}）`); continue; }
    const key = keyOf(location, sku);
    if (eta <= asOf) { addIssue("warning", "inbound_overdue", `在途 ETA 已过，不视为已到货：${location} / ${sku} (${eta})`, key); continue; }
    if (!inboundByKey.has(key)) inboundByKey.set(key, []);
    inboundByKey.get(key).push({ eta, units });
  }
  const startDate = addDays(asOf, -167);
  const categoryForecasts = new Map();
  if (settings.categoryEvidence) for (const [category, evidence] of Object.entries(settings.categoryEvidence)) categoryForecasts.set(category, evidence);
  else for (const [category, daily] of categoryByDay) {
    const series = Array.from({ length: 168 }, (_, i) => daily.get(addDays(startDate, i)) || 0);
    categoryForecasts.set(category, categoryForecast(series, startDate, 14));
  }
  const recentSalesKeys = [...salesByKey].filter(([, lines]) => lines.some((line) => daysBetween(line.date, asOf) < 28)).map(([key]) => key);
  const keys = new Set([...inventory.keys(), ...recentSalesKeys, ...inboundByKey.keys()]);
  const items = [];
  for (const key of keys) {
    const [location, sku] = key.split("\u001f"), stock = inventory.get(key), product = products.get(sku), sales = salesByKey.get(key) || [], returns = returnsByKey.get(key) || [], inbound = inboundByKey.get(key) || [];
    const recent28 = sum(sales.filter((line) => daysBetween(line.date, asOf) < 28).map((line) => line.units));
    const prior28 = sum(sales.filter((line) => { const age = daysBetween(line.date, asOf); return age >= 28 && age < 56; }).map((line) => line.units));
    const recentReturns = returns.filter((line) => daysBetween(line.date, asOf) < 28);
    const returnUnits28 = sum(recentReturns.map((line) => line.units));
    const netSales28 = sum(sales.filter((line) => daysBetween(line.date, asOf) < 28).map((line) => line.netSales)) + sum(recentReturns.map((line) => line.netSales));
    const cogs28 = sum(sales.filter((line) => daysBetween(line.date, asOf) < 28).map((line) => line.cogs)) + sum(recentReturns.map((line) => line.cogs));
    const forecast = categoryForecasts.get(lineKey(product?.majorCategory || "未分大类", product?.category || "未归类"));
    const rawRate = recent28 > 0 ? .7 * recent28 / 28 + .3 * prior28 / 28 : prior28 > 0 ? .5 * prior28 / 28 : 0;
    const demandProfile = settings.demandProfiles?.get(key) || null;
    const demandRate = demandProfile ? round(mean(demandProfile.slice(0, 14)), 4) : round(rawRate * (forecast?.factor || 1), 4);
    const leadTime = product?.leadTime || config.leadTime;
    const blocker = !stock ? "缺少当日库存" : duplicated.has(key) ? "重复库存记录" : stock.onHand < 0 ? "负库存待核实" : stock.availableInvalid ? "可售库存无效" : null;
    const usableStock = stock?.availableProvided && !stock.availableInvalid ? stock.available : stock?.onHand ?? null;
    if (!stock && recent28 > 0) addIssue("error", "missing_stock", `有近 28 天销售、无当日库存：${location} / ${sku}`, key);
    if (!product) addIssue("warning", "missing_product", `缺少商品主数据：${sku}`, key);
    const targetDays = leadTime + config.reviewDays + config.bufferDays;
    const z = { 90: 1.28, 95: 1.65, 98: 2.05 }[config.serviceLevel];
    const safety = z * Math.sqrt(Math.max(0, demandRate * (leadTime + config.reviewDays)));
    const target = demandRate * targetDays + safety;
    const due = sum(inbound.filter((line) => daysBetween(asOf, line.eta) <= targetDays).map((line) => line.units));
    let requestedQty = blocker || demandRate <= 0 ? 0 : Math.ceil(Math.max(0, target - usableStock - due));
    if (requestedQty > 0 && product?.moq) requestedQty = Math.max(requestedQty, product.moq);
    if (requestedQty > 0 && product?.casePack) requestedQty = Math.ceil(requestedQty / product.casePack) * product.casePack;
    const baseline = blocker ? null : simulate(usableStock, demandProfile || demandRate, asOf, config.horizon, inbound);
    const coverDays = blocker || demandRate <= 0 ? null : usableStock / demandRate;
    const overstock = !blocker && usableStock > 0 && (recent28 === 0 || coverDays > 90);
    const urgency = baseline?.firstShortageDay !== null && baseline?.firstShortageDay !== undefined ? Math.max(0, config.horizon - baseline.firstShortageDay + 1) : 0;
    const priorityScore = blocker ? 1e6 : (baseline?.unmet || 0) * 100 + urgency * 4 + requestedQty;
    items.push({ key, location, sku, name: product?.name || sku, category: product?.category || "未归类", majorCategory: product?.majorCategory || "未分大类", stock: usableStock,
      physicalOnHand: stock?.onHand ?? null, stockBasis: stock?.availableProvided && !stock.availableInvalid ? "available_units" : "on_hand_proxy",
      unitCost: stock?.unitCost || product?.unitCost || null, leadTime, leadAssumed: !product?.leadTime,
      casePackAssumed: !product?.casePack, moqAssumed: !product?.moq, recent28: round(recent28), prior28: round(prior28), returnUnits28: round(returnUnits28),
      netSales28: round(netSales28), cogs28: round(cogs28), grossMargin28: round(netSales28 - cogs28), demandRate, demandProfile, forecast: forecast || null, coverDays: coverDays === null ? null : round(coverDays, 1),
      target: round(target, 1), safety: round(safety, 1), inbound, inboundDue: round(due), requestedQty,
      blocker, overstock, baseline, priorityScore, allocatedQty: 0, proposed: null });
  }
  const candidates = items.filter((item) => !item.blocker && item.requestedQty > 0).sort((a, b) => b.priorityScore - a.priorityScore || a.key.localeCompare(b.key));
  let remaining = config.maxOrderUnits || Infinity;
  for (const item of candidates) {
    let qty = Math.min(item.requestedQty, remaining);
    const product = products.get(item.sku);
    if (product?.casePack) qty = Math.floor(qty / product.casePack) * product.casePack;
    if (product?.moq && qty < product.moq) qty = 0;
    item.allocatedQty = qty;
    remaining -= qty;
  }
  for (const item of items) {
    if (item.blocker) { item.kind = "blocked"; continue; }
    item.proposed = simulate(item.stock, item.demandProfile || item.demandRate, asOf, config.horizon, item.inbound, item.allocatedQty, item.leadTime);
    if (item.baseline.unmet > .01) item.kind = item.baseline.firstShortageDay <= item.leadTime ? "expedite" : "stockout";
    else if (item.overstock) item.kind = "overstock";
    else if (item.requestedQty > 0) item.kind = "replenish";
    else item.kind = "normal";
  }
  items.sort((a, b) => b.priorityScore - a.priorityScore || a.key.localeCompare(b.key));
  const actionable = items.filter((item) => item.kind !== "normal");
  const summary = {
    asOf, locations: new Set(items.map((item) => item.location)).size, skus: new Set(items.map((item) => item.sku)).size,
    items: items.length, exceptions: actionable.length, blocked: items.filter((item) => item.blocker).length,
    stockout: items.filter((item) => item.kind === "stockout" || item.kind === "expedite").length,
    overstock: items.filter((item) => item.kind === "overstock").length,
    requestedUnits: sum(items.map((item) => item.requestedQty)), allocatedUnits: sum(items.map((item) => item.allocatedQty)),
    baselineUnmet: round(sum(items.map((item) => item.baseline?.unmet || 0)), 1),
    proposedUnmet: round(sum(items.map((item) => item.proposed?.unmet || 0)), 1),
    returnRows, issueCount: issues.filter((issue) => issue.severity !== "info").length,
  };
  return { fatal: null, meta: dataset.meta || {}, config, issues, items, actionable, summary, categoryForecasts: Object.fromEntries(categoryForecasts) };
}

export function csvEscape(value) {
  const raw = String(value ?? "");
  const safe = typeof value !== "number" && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function toCSV(rows) { return "\uFEFF" + rows.map((row) => row.map(csvEscape).join(",")).join("\r\n"); }
