"use strict";

const $ = (selector) => document.querySelector(selector);
const fmt = (value, digits = 0) => Number(value).toLocaleString("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const pct = (value, digits = 1) => `${fmt(value, digits)}%`;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const state = { data: null, categoryIndex: 0, view: "forecast", models: {}, scenario: null };

function currentCategory() { return state.data.categories[state.categoryIndex]; }
function currentModel() { const category = currentCategory(); return state.models[category.id] || category.recommendedModel; }
function selectedEvidence() { return currentCategory().models[currentModel()]; }
function unsafeModel(category, model) {
  const bestBaseline = Math.min(category.models.seasonal7.wape, category.models.weekday4.wape);
  return category.models[model].wape > 60 || category.models[model].wape - bestBaseline > 10;
}
function metric(label, value, detail, tone = "") { return `<div class="metric ${tone}"><div class="label">${escapeHtml(label)}</div><div class="value">${value}</div><div class="detail">${escapeHtml(detail)}</div></div>`; }
function dateShort(iso) { return `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`; }

function lineChart(lines, labels, options = {}) {
  const w = 920, h = options.compact ? 182 : 215, left = 40, right = 10, top = 10, bottom = 30;
  const all = lines.flatMap((line) => line.values).filter(Number.isFinite);
  const min = options.zeroFloor ? 0 : Math.max(0, Math.min(...all) * .82);
  const max = Math.max(...all, min + 1) * 1.07;
  const x = (index) => left + (index / Math.max(1, labels.length - 1)) * (w - left - right);
  const y = (value) => top + (1 - (value - min) / (max - min)) * (h - top - bottom);
  const axis = [0, 1, 2, 3].map((i) => {
    const value = min + (max - min) * (3 - i) / 3;
    const yp = y(value);
    return `<line x1="${left}" y1="${yp.toFixed(1)}" x2="${w - right}" y2="${yp.toFixed(1)}" stroke="#e5ece5"/><text x="${left - 8}" y="${(yp + 3).toFixed(1)}" text-anchor="end" fill="#8ca094" font-size="10" font-family="DM Mono,monospace">${Math.round(value)}</text>`;
  }).join("");
  const ticks = [0, Math.floor((labels.length - 1) / 2), labels.length - 1].map((index) => `<text x="${x(index).toFixed(1)}" y="${h - 6}" text-anchor="${index === 0 ? "start" : index === labels.length - 1 ? "end" : "middle"}" fill="#8ca094" font-size="10" font-family="DM Mono,monospace">${escapeHtml(dateShort(labels[index]))}</text>`).join("");
  const paths = lines.map((line) => `<polyline points="${line.values.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ")}" fill="none" stroke="${line.color}" stroke-width="${line.width || 2.5}" stroke-linejoin="round" stroke-linecap="round" ${line.dash ? 'stroke-dasharray="5 4"' : ""}/>`).join("");
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeHtml(options.label || "时间序列图")}">${axis}${paths}${ticks}</svg>`;
}

function renderForecast() {
  const category = currentCategory(), model = currentModel(), evidence = selectedEvidence();
  const holdout = category.history.slice(-state.data.meta.holdoutDays);
  const actual = holdout.map((point) => point.units);
  const totalForecast = evidence.future.reduce((a, b) => a + b, 0);
  const biasKind = Math.abs(evidence.bias) > 20 ? "alert" : "";
  $("#forecast-metrics").innerHTML = [
    metric("所选模型 · 28 天 WAPE", `${fmt(evidence.wape, 1)}<span>%</span>`, model === category.recommendedModel ? "当前品类最低 WAPE" : "人工选择的模型", "important"),
    metric("有方向的预测偏差", `${evidence.bias >= 0 ? "+" : ""}${fmt(evidence.bias, 1)}<span>%</span>`, evidence.bias >= 0 ? "正值 = 整体预测偏高" : "负值 = 整体预测偏低", biasKind),
    metric("未来 14 天售出预测", fmt(totalForecast), "件 · 类别总量 / 非真实需求"),
    metric("库存有效区间匹配", `${fmt(category.stockCoveragePct, 1)}<span>%</span>`, `${fmt(category.coveredSalesRows)} / ${fmt(category.positiveSalesRows)} 条正向销售行`),
  ].join("");
  $("#backtest-chart").innerHTML = lineChart([
    { values: actual, color: "#40594f", width: 2.3 },
    { values: evidence.backtest, color: "#0e9b82", width: 2.7 },
  ], holdout.map((point) => point.date), { label: `${category.name} 最近 28 天实际销量与 ${evidence.label} 逐日一步预测` });
  $("#backtest-caption").textContent = `留出期 ${category.backtestStart}—${state.data.meta.asOf}；逐日预测可使用上一天已经观测到的销量。14 天未来预测则递推使用模型输出。`;
  $("#model-list").innerHTML = Object.entries(category.models).map(([key, item]) => `<button type="button" class="model-row ${model === key ? "selected" : ""}" data-model="${key}" aria-pressed="${model === key}"><span class="model-name">${escapeHtml(item.label)}<small>${key === category.recommendedModel ? "本品类最低 WAPE · 推荐" : key === "ridge" ? "机器学习候选" : "透明基线"}</small></span><span class="model-value">${pct(item.wape)}</span><span class="model-bias ${Math.abs(item.bias) > 20 ? "bad" : ""}">偏差 ${item.bias >= 0 ? "+" : ""}${pct(item.bias)}</span></button>`).join("");
  const futureDates = evidence.future.map((_, index) => { const day = new Date(`${state.data.meta.asOf}T12:00:00Z`); day.setUTCDate(day.getUTCDate() + index + 1); return day.toISOString().slice(0, 10); });
  $("#future-chart").innerHTML = lineChart([{ values: evidence.future, color: "#0e9b82", width: 2.8 }], futureDates, { compact: true, zeroFloor: true, label: `${category.name} 未来 14 天预测销量` });
  $("#future-caption").textContent = `合计 ${fmt(totalForecast)} 件；日均 ${fmt(totalForecast / 14, 1)} 件。门店情景按近 28 天售出占比分摊。`;
  const winners = category.rollingWindows.map((window) => Object.keys(window.models).reduce((best, key) => window.models[key].wape < window.models[best].wape ? key : best, "seasonal7"));
  $("#rolling-window-rows").innerHTML = category.rollingWindows.map((window, index) => `<tr><td><strong>${dateShort(window.start)}—${dateShort(window.end)}</strong>${index === 2 ? " · 最近" : ""}</td><td class="num">${fmt(window.actualUnits)}</td><td class="num">${pct(window.models.seasonal7.wape)}</td><td class="num">${pct(window.models.weekday4.wape)}</td><td class="num">${pct(window.models.ridge.wape)}</td><td><span class="risk ${winners[index] === model ? "ok" : "unknown"}">${escapeHtml(category.models[winners[index]].label)}</span></td></tr>`).join("");
  $("#rolling-window-note").textContent = `当前所选模型在 3 个窗口中胜出 ${winners.filter((key) => key === model).length} 次。推荐模型仍按最近窗口最低 WAPE 选择；多窗口胜出只说明回测较稳，不能保证未来表现。`;
  const baseline = Math.min(category.models.seasonal7.wape, category.models.weekday4.wape);
  const ridge = category.models.ridge.wape;
  const previousActual = category.history.slice(-56, -28).reduce((sum, point) => sum + point.units, 0);
  const actualTotal = actual.reduce((a, b) => a + b, 0);
  const change = previousActual ? (actualTotal / previousActual - 1) * 100 : 0;
  const worst = holdout.map((point, index) => ({ ...point, predicted: evidence.backtest[index], error: Math.abs(point.units - evidence.backtest[index]) })).sort((a, b) => b.error - a.error)[0];
  const volumeBias = evidence.backtest.reduce((a, b) => a + b, 0) - actualTotal;
  const modelFinding = ridge > baseline ? `最近窗口岭回归 WAPE ${pct(ridge)}，更好的简单基线为 ${pct(baseline)}。这一窗口不能宣称机器学习提升了预测；系统推荐基线。岭回归在 3 个窗口中胜出 ${winners.filter((key) => key === "ridge").length} 次。` : `最近窗口岭回归 WAPE ${pct(ridge)}，简单基线最低 ${pct(baseline)}，改善 ${fmt(baseline - ridge, 1)} 个百分点；在 3 个窗口中胜出 ${winners.filter((key) => key === "ridge").length} 次。仍需在业务事件与未来月份继续验证。`;
  const shiftFinding = Math.abs(change) >= 35 ? `留出期实际 ${fmt(actualTotal)} 件，前 28 天 ${fmt(previousActual)} 件，变化 ${change >= 0 ? "+" : ""}${pct(change)}。时间序列出现明显水平变化；数据没有促销、价格或缺货暴露，无法确定原因。` : `留出期实际 ${fmt(actualTotal)} 件，前 28 天 ${fmt(previousActual)} 件，变化 ${change >= 0 ? "+" : ""}${pct(change)}；仍要检查突发事件与缺货导致的观测偏差。`;
  const operationalFinding = `所选模型留出期累计预测比实际${volumeBias >= 0 ? "多" : "少"} ${fmt(Math.abs(volumeBias), 1)} 件；若未经复核直接转为采购依据，可能${volumeBias >= 0 ? "增加库存占用" : "扩大缺货暴露"}。最大单日误差出现在 ${worst.date}：预测 ${fmt(worst.predicted, 1)}，实际 ${fmt(worst.units)}。`;
  const worstIndex = state.data.categories.map((item, index) => ({ index, item, gap: item.models.ridge.wape - Math.min(item.models.seasonal7.wape, item.models.weekday4.wape) })).sort((a, b) => b.gap - a.gap)[0];
  const counterexample = worstIndex.index === state.categoryIndex ? "" : `<div class="counterexample"><span><b>跨品类失败案例</b>　${escapeHtml(worstIndex.item.name)}：岭回归 WAPE ${pct(worstIndex.item.models.ridge.wape)}，最佳简单基线 ${pct(Math.min(worstIndex.item.models.seasonal7.wape, worstIndex.item.models.weekday4.wape))}。</span><button type="button" id="open-failure">查看反例 →</button></div>`;
  $("#failure-analysis").innerHTML = `<div class="failure-head"><div><p class="panel-kicker">NEGATIVE EVIDENCE / DO NOT HIDE</p><h3>负结果、工作影响与改进方向</h3></div><span class="failure-badge">${ridge > baseline || evidence.wape > 40 ? "需人工复核" : "优势待复验"}</span></div><div class="failure-grid"><div><b>01 / 模型是否真的更好</b><p>${escapeHtml(modelFinding)}</p></div><div><b>02 / 数据是否发生转折</b><p>${escapeHtml(shiftFinding)}</p></div><div><b>03 / 对计划工作的影响</b><p>${escapeHtml(operationalFinding)}</p></div></div><div class="improvement"><strong>下一轮验证</strong><span>把滚动回测扩展到完整季节周期，并加入促销/价格与缺货记录；对高误差品类设置人工例外，拒绝把回测分数当作未来服务水平保证。</span></div>${counterexample}`;
  $("#open-failure")?.addEventListener("click", () => switchCategory(worstIndex.index));
  document.querySelectorAll("[data-model]").forEach((button) => button.addEventListener("click", () => {
    state.models[category.id] = button.dataset.model;
    resetApproval(); renderAll();
  }));
}

function scenarioInputs() {
  const horizon = Number($("#horizon").value);
  const inbound = clamp(Math.round(Number($("#inbound").value) || 0), 0, 100000);
  $("#arrival").max = String(horizon);
  const arrival = clamp(Math.round(Number($("#arrival").value) || 1), 1, horizon);
  if (Number($("#arrival").value) !== arrival) $("#arrival").value = String(arrival);
  const targetCover = clamp(Math.round(Number($("#target-cover").value) || 60), 7, 120);
  return { horizon, inbound, arrival, targetCover, allocation: $("#allocation").value };
}

function demandSeries(forecast, horizon) {
  return Array.from({ length: horizon }, (_, day) => day < 14 ? forecast[day] : forecast[7 + (day - 14) % 7]);
}

function distributeInteger(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const normalized = sum > 0 ? weights.map((value) => value / sum) : weights.map(() => 1 / weights.length);
  const exact = normalized.map((value) => value * total);
  const allocation = exact.map(Math.floor);
  let remainder = total - allocation.reduce((a, b) => a + b, 0);
  const order = exact.map((value, index) => [value - allocation[index], index]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let i = 0; i < remainder; i++) allocation[order[i][1]]++;
  return allocation;
}

function calculateScenario(category, model, inputs) {
  const forecast = category.models[model].future;
  const daily = demandSeries(forecast, inputs.horizon);
  const stores = category.stores;
  const salesTotal = stores.reduce((sum, store) => sum + store.sales28Units, 0);
  const shares = stores.map((store) => salesTotal > 0 ? store.sales28Units / salesTotal : 1 / stores.length);
  const dailyMean = forecast.reduce((a, b) => a + b, 0) / 14;
  const beforeArrivalDemand = daily.slice(0, inputs.arrival - 1).reduce((a, b) => a + b, 0);
  const needs = stores.map((store, index) => Math.max(0, dailyMean * shares[index] * inputs.targetCover - Math.max(0, store.stock - beforeArrivalDemand * shares[index])));
  const weights = inputs.allocation === "sales" ? shares : needs.some((value) => value > 0) ? needs : shares;
  const allocations = distributeInteger(inputs.inbound, weights);
  function simulate(withInbound) {
    const stock = stores.map((store) => store.stock);
    const unmet = stores.map(() => 0);
    const fulfilled = stores.map(() => 0);
    const totalStock = [], totalUnmet = [];
    daily.forEach((demand, day) => {
      stores.forEach((_, index) => {
        if (withInbound && day + 1 === inputs.arrival) stock[index] += allocations[index];
        const requested = demand * shares[index];
        const served = Math.min(stock[index], requested);
        stock[index] = Math.max(0, stock[index] - served);
        fulfilled[index] += served;
        unmet[index] += requested - served;
      });
      totalStock.push(stock.reduce((a, b) => a + b, 0));
      totalUnmet.push(unmet.reduce((a, b) => a + b, 0));
    });
    return { stock, unmet, fulfilled, totalStock, totalUnmet };
  }
  const baseline = simulate(false), proposed = simulate(true);
  const demand = daily.reduce((a, b) => a + b, 0);
  return { inputs, daily, shares, allocations, baseline, proposed, demand, dailyMean,
    storeRows: stores.map((store, index) => ({ ...store, demand: demand * shares[index], cover: dailyMean * shares[index] > 0 ? store.stock / (dailyMean * shares[index]) : null, allocation: allocations[index], baselineUnmet: baseline.unmet[index], unmet: proposed.unmet[index], closing: proposed.stock[index] })) };
}

function renderPsi() {
  const category = currentCategory(), result = calculateScenario(category, currentModel(), scenarioInputs());
  state.scenario = result;
  const { inputs, baseline, proposed } = result;
  const modelWarning = unsafeModel(category, currentModel()) ? ` <b>所选模型回测失效，只能用于诊断；行动单导出已暂停。</b>` : "";
  $("#scenario-method-banner").innerHTML = inputs.horizon > 14 ? `<strong>${inputs.horizon} 天压力测试 / 非预测精度承诺</strong><span>模型只生成未来 14 天；第 15—${inputs.horizon} 天重复第二周节奏。页面中的未满足件数是条件模拟，不是观测到的缺货。${modelWarning}</span>` : `<strong>14 天模型范围</strong><span>未来销量由所选模型生成；门店分配与到货仍是假设，未满足件数不是实际缺货。${modelWarning}</span>`;
  const baselineUnmet = baseline.unmet.reduce((a, b) => a + b, 0);
  const proposedUnmet = proposed.unmet.reduce((a, b) => a + b, 0);
  const closing = proposed.stock.reduce((a, b) => a + b, 0);
  $("#psi-metrics").innerHTML = [
    metric("期初可用在手", fmt(category.stock), `件 · ${fmt(category.excludedNegativeSkuCount)} 条负数记录已排除`),
    metric("不到货时未满足", fmt(baselineUnmet, 1), `${inputs.horizon} 天模拟 · 不是实际缺货`, baselineUnmet > 0 ? "alert" : ""),
    metric("本情景未满足", fmt(proposedUnmet, 1), inputs.inbound ? `改善 ${fmt(baselineUnmet - proposedUnmet, 1)} 件` : "当前未设置假设到货", proposedUnmet > 0 ? "alert" : "important"),
    metric("本情景期末在手", fmt(closing, 1), `供需守恒 · 到货 ${fmt(inputs.inbound)} 件`),
  ].join("");
  const dates = result.daily.map((_, index) => { const day = new Date(`${state.data.meta.asOf}T12:00:00Z`); day.setUTCDate(day.getUTCDate() + index + 1); return day.toISOString().slice(0, 10); });
  $("#psi-chart").innerHTML = lineChart([
    { values: baseline.totalStock, color: "#40594f", width: 2.1 },
    { values: proposed.totalStock, color: "#0e9b82", width: 2.8 },
  ], dates, { label: `${category.name} ${inputs.horizon} 天库存模拟，基线与当前情景` });
  $("#psi-caption").textContent = `预测售出 ${fmt(result.demand, 1)} 件；情景到货 ${fmt(inputs.inbound)} 件（第 ${inputs.arrival} 天）。累计未满足需求：基线 ${fmt(baselineUnmet, 1)} 件 → 当前 ${fmt(proposedUnmet, 1)} 件。`;
  const atRisk = result.storeRows.filter((row) => row.unmet > .01).length;
  const belowTarget = result.storeRows.filter((row) => row.cover !== null && row.cover < inputs.targetCover).length;
  const largeSurplus = result.storeRows.filter((row) => row.cover !== null && row.cover > inputs.targetCover * 1.5).length;
  const noServiceGain = inputs.inbound > 0 && baselineUnmet - proposedUnmet < .01;
  const note = atRisk ? `在 ${inputs.horizon} 天情景里，${atRisk} 家门店出现模拟未满足件数；${belowTarget} 家低于 ${inputs.targetCover} 天目标。建议先核查这些门店的 SKU 可用量与在途单，再决定调拨或采购。` : `在 ${inputs.horizon} 天情景里没有计算出未满足件数。${largeSurplus} 家门店的品类库存超过目标覆盖的 1.5 倍；可优先评估采购暂缓与 SKU 级滞销风险。`;
  $("#psi-insight").className = `insight ${atRisk ? "warning" : ""}`;
  $("#psi-insight").innerHTML = `<strong>${atRisk ? "局部风险需要核查" : "当前情景无新增到货必要"}</strong>　${escapeHtml(note)}${noServiceGain ? ` <em>负结果：增加 ${fmt(inputs.inbound)} 件到货没有改善模拟未满足量，只增加库存占用。</em>` : ""}${inputs.horizon > 14 ? " <em>第 15 天后为周期外推，不能当作已验证预测。</em>" : ""}`;
  $("#store-count").textContent = `${result.storeRows.length} 家门店`;
  const ranked = [...result.storeRows].sort((a, b) => b.unmet - a.unmet || (a.cover ?? 999) - (b.cover ?? 999));
  $("#store-rows").innerHTML = ranked.map((row) => {
    const quality = row.stockCoveragePct === null ? "无近期 SKU 对照" : row.stockCoveragePct < 60 ? `匹配 ${pct(row.stockCoveragePct, 0)}` : row.excludedNegativeSkuCount ? `负数 ${row.excludedNegativeSkuCount}` : "已对照";
    const risk = row.unmet > .01 ? `<span class="risk">${escapeHtml(quality)}</span>` : quality === "已对照" ? `<span class="risk ok">${quality}</span>` : `<span class="risk unknown">${escapeHtml(quality)}</span>`;
    return `<tr><td><strong>${escapeHtml(row.id)}</strong></td><td class="num">${fmt(row.stock)}</td><td class="num">${fmt(row.sales28Units)}</td><td class="num">${row.cover === null ? "—" : `${fmt(row.cover, 1)} 天`}</td><td class="num">${fmt(row.closing, 1)}</td><td class="num">${fmt(row.unmet, 1)}</td><td class="num">${fmt(row.allocation)}</td><td>${risk}</td></tr>`;
  }).join("");
}

function categorySignals(category) {
  const model = state.models[category.id] || category.recommendedModel;
  const average = category.models[model].future.reduce((a, b) => a + b, 0) / 14;
  const cover = average > 0 ? category.stock / average : null;
  const risk = category.stockCoveragePct < 60 || category.models[model].wape > 40 ? "证据核查" : cover > 90 ? "库存偏厚" : cover < 30 ? "补货核查" : "保持观察";
  return { cover, risk, model };
}

function actionBrief(category, result) {
  const evidence = category.models[currentModel()];
  const source = categorySignals(category);
  const atRisk = result.storeRows.filter((row) => row.unmet > .01);
  const highStock = result.storeRows.filter((row) => row.cover !== null && row.cover > result.inputs.targetCover * 1.5);
  const lowMatch = result.storeRows.filter((row) => row.stockCoveragePct !== null && row.stockCoveragePct < 60);
  const failed = unsafeModel(category, currentModel());
  const title = failed ? "模型失效：暂停基于此预测的补货建议" : atRisk.length ? "先核查局部门店，再决定调拨与采购" : "暂缓新增采购，先消化与核对现有库存";
  const explanation = failed ? `所选 ${evidence.label} 的留出期 WAPE 为 ${pct(evidence.wape)}，未通过应用的模型门槛（WAPE 不超过 60%，且不比最佳简单基线差超过 10 个百分点）。当前 PSI 仅可用于失败诊断；请切回推荐模型，再核查库存与在途。` : atRisk.length ? `${atRisk.length} 家门店在当前 ${result.inputs.horizon} 天压力测试中出现模拟未满足件数；品类总量仍有 ${fmt(category.stock)} 件在手。跨店调拨必须再核查 SKU 一致性。` : `当前 ${result.inputs.horizon} 天情景没有计算出未满足件数；品类总在手约可覆盖 ${fmt(source.cover, 1)} 天的模型日均销量。追加到货需要独立的业务理由。`;
  const lines = [
    `模型证据：${evidence.label} 的 28 天 WAPE 为 ${pct(evidence.wape)}、偏差 ${evidence.bias >= 0 ? "+" : ""}${pct(evidence.bias)}。${evidence.wape > 40 ? "误差较高，行动前应人工复核。" : ""}`,
    `库存证据：${fmt(category.stock)} 件有效在手；${fmt(category.stockCoveragePct, 1)}% 的正向销售行能匹配当日库存有效区间，${fmt(category.excludedNegativeSkuCount)} 条当前负库存记录已排除。`,
    `门店优先级：${atRisk.length} 家情景缺口门店、${highStock.length} 家高于目标 1.5 倍的门店；${lowMatch.length} 家近期售出 SKU 与当前库存记录匹配率低于 60%。`,
    `品类运营：近 28 天净毛利 ${fmt(category.grossMargin28, 1)}（样本金额单位）、退货 ${fmt(category.returnUnits28)} 件。退货率与真实缺货原因无法由样本直接判定。`,
  ];
  const historicalWapes = category.rollingWindows.map((window) => window.models[currentModel()].wape);
  if (Math.max(...historicalWapes) > 60) lines.push(`稳定性例外：所选模型三个连续窗口的 WAPE 为 ${historicalWapes.map((value) => pct(value)).join(" / ")}。高误差窗口说明不能仅凭最近一个月的改善直接执行。`);
  return { title, explanation, lines };
}

function renderAction() {
  const category = currentCategory(), result = state.scenario, brief = actionBrief(category, result);
  $("#action-category").textContent = category.name;
  $("#action-summary").innerHTML = `<div class="brief-callout"><h4>${escapeHtml(brief.title)}</h4><p>${escapeHtml(brief.explanation)}</p></div><ol class="brief-list">${brief.lines.map((line, index) => `<li><b>0${index + 1}</b><span>${escapeHtml(line)}</span></li>`).join("")}</ol>`;
  $("#realworld-gap").innerHTML = `<div class="failure-head"><div><p class="panel-kicker">IMPLEMENTATION GAP / NEXT ITERATION</p><h3>如果放进真实工作，还缺什么</h3></div><span class="failure-badge">工作边界</span></div><div class="gap-grid"><div><b>预测</b><p>当前选用模型最近窗口 WAPE 为 ${pct(category.models[currentModel()].wape)}，现有三个连续 28 天滚动窗口。下一步扩展跨季节验证，接入促销、售价、节假日和缺货暴露，给不稳定品类设置人工例外。</p></div><div><b>库存</b><p>${pct(category.stockCoveragePct)} 的正向销售行能对上当日库存区间，当前 ${fmt(category.excludedNegativeSkuCount)} 条负在手量被排除。下一步建立日终库存快照、异常修复队列及可销售库存定义。</p></div><div><b>执行</b><p>没有真实采购单、在途、供应商交期与 SKU 替代规则。下一步接入 ERP/WMS 的订单和主数据，做 SKU 级调拨可行性校验，再把草稿接到审批流程。</p></div></div><div class="improvement"><strong>AI 的工作位置</strong><span>机器学习帮助比较预测候选，规则把异常排成核查顺序；库存守恒、金额汇总与导出仍由可复算逻辑完成。模型证据不足时使用简单基线或人工判断。</span></div>`;
  $("#category-list").innerHTML = state.data.categories.map((item, index) => {
    const signal = categorySignals(item);
    const worstWindow = Math.max(...item.rollingWindows.map((window) => window.models[signal.model].wape));
    return `<button type="button" class="category-item ${item.id === category.id ? "selected" : ""}" data-category-index="${index}"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(signal.risk)} · 库存约 ${fmt(signal.cover, 0)} 天 · 3 窗口最高误差 ${pct(worstWindow, 0)}</small><b>${fmt(item.models[signal.model].wape, 1)}%</b></button>`;
  }).join("");
  document.querySelectorAll("[data-category-index]").forEach((button) => button.addEventListener("click", () => switchCategory(Number(button.dataset.categoryIndex))));
  const storeRows = [...result.storeRows].sort((a, b) => b.unmet - a.unmet || (a.cover ?? 999) - (b.cover ?? 999) || b.grossMargin28 - a.grossMargin28).slice(0, 8);
  $("#priority-store-rows").innerHTML = storeRows.map((row) => {
    const reason = row.unmet > .01 ? `模拟缺口 ${fmt(row.unmet, 1)} 件` : row.stockCoveragePct !== null && row.stockCoveragePct < 60 ? "先核查库存记录" : row.cover < result.inputs.targetCover ? "低于覆盖目标" : "关注库存分布";
    return `<tr><td><strong>${escapeHtml(row.id)}</strong></td><td class="num">${row.cover === null ? "—" : `${fmt(row.cover, 1)} 天`}</td><td class="num">${fmt(row.grossMargin28, 1)}</td><td class="num">${fmt(row.returnUnits28)}</td><td>${escapeHtml(reason)}</td></tr>`;
  }).join("");
  const eligible = category.skus.filter((sku) => sku.sales28Units >= 2);
  const candidates = eligible.map((sku) => {
    const cover = sku.stock / (sku.sales28Units / 28);
    const match = sku.recentStoreCount ? sku.stockMatchedStoreCount / sku.recentStoreCount * 100 : null;
    const score = (match !== null && match < 50 ? 100 : 0) + (cover < 28 ? 80 : cover < 60 ? 40 : 0) + Math.min(40, sku.sales28Units);
    return { ...sku, cover, match, score };
  }).sort((a, b) => b.score - a.score || b.sales28Units - a.sales28Units).slice(0, 8);
  $("#priority-sku-rows").innerHTML = candidates.map((sku) => {
    const reason = sku.activeStockStoreCount === 0 ? "无当前库存记录" : sku.match !== null && sku.match < 50 ? "门店库存对照不足" : sku.cover < 28 ? "低覆盖，核查补货" : sku.returnUnits28 >= 2 ? "核查退货" : "核查门店分布";
    return `<tr><td class="sku-name" title="${escapeHtml(sku.description)}"><strong>${escapeHtml(sku.id)}</strong></td><td class="num">${sku.activeStockStoreCount ? fmt(sku.stock) : "未知"}</td><td class="num">${fmt(sku.sales28Units)}</td><td class="num">${sku.match === null ? "—" : pct(sku.match, 0)}</td><td>${escapeHtml(reason)}</td></tr>`;
  }).join("");
}

function resetApproval() { $("#approval-check").checked = false; $("#export-button").disabled = true; $("#approval-label").textContent = state.data && unsafeModel(currentCategory(), currentModel()) ? "模型失效 · 暂停导出" : "待人工确认"; }
function switchCategory(index) { state.categoryIndex = index; $("#category-select").value = String(index); const url = new URL(window.location.href); url.searchParams.set("category", currentCategory().id); history.replaceState(null, "", url); resetApproval(); renderAll(); }
function renderAll() { if (!state.data) return; renderForecast(); renderPsi(); renderAction(); }
function switchView(view) {
  state.view = view;
  for (const id of ["forecast", "psi", "action"]) {
    const active = id === view;
    $(`#${id}-view`).hidden = !active;
    const button = $(`.view-tab[data-view="${id}"]`);
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  }
  const url = new URL(window.location.href); url.hash = view; history.replaceState(null, "", url);
}

function csvCell(value) {
  let text = String(value ?? "");
  if (typeof value !== "number" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
function exportAction() {
  if (!$("#approval-check").checked || unsafeModel(currentCategory(), currentModel())) return;
  const category = currentCategory(), scenario = state.scenario, model = currentModel(), evidence = selectedEvidence(), brief = actionBrief(category, scenario);
  const rows = [
    ["APP01 行动单", "公开样本 · 人工审阅草稿"],
    ["品类", category.name], ["观测截止", state.data.meta.asOf], ["数据来源", state.data.meta.source],
    ["模型", evidence.label], ["28天WAPE", evidence.wape], ["28天偏差", evidence.bias],
    ["情景天数", scenario.inputs.horizon], ["假设到货", scenario.inputs.inbound], ["假设到货日", scenario.inputs.arrival],
    ["目标覆盖天数", scenario.inputs.targetCover], ["分配规则", scenario.inputs.allocation],
    ["建议", brief.title], ["说明", brief.explanation],
    [], ["门店", "期初在手", "近28天售出", "覆盖天数", "假设到货分配", "情景期末", "情景未满足", "库存匹配率"],
    ...scenario.storeRows.map((store) => [store.id, store.stock, store.sales28Units, store.cover?.toFixed(1) ?? "", store.allocation, store.closing.toFixed(1), store.unmet.toFixed(1), store.stockCoveragePct ?? ""]),
    [], ["注释", "库存为已发布有效区间；未来需求、到货与分配均为模拟。第15天后为周期外推。导出不构成采购或调拨指令。"],
  ];
  const blob = new Blob(["\uFEFF", rows.map((row) => row.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = `app01-action-${category.id}-${state.data.meta.asOf}.csv`;
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function init() {
  try {
    const response = await fetch("data.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.schemaVersion !== 1 || !Array.isArray(data.categories) || !data.categories.length) throw new Error("数据结构不符合预期");
    state.data = data;
    $("#as-of").textContent = data.meta.asOf;
    $("#category-select").innerHTML = data.categories.map((category, index) => `<option value="${index}">${escapeHtml(category.name)}</option>`).join("");
    const requested = new URL(window.location.href).searchParams.get("category");
    const requestedIndex = data.categories.findIndex((category) => category.id === requested);
    if (requestedIndex >= 0) state.categoryIndex = requestedIndex;
    $("#category-select").value = String(state.categoryIndex);
    $("#category-select").addEventListener("change", (event) => switchCategory(Number(event.target.value)));
    document.querySelectorAll(".view-tab").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
    $("#scenario-form").addEventListener("input", () => { resetApproval(); renderPsi(); renderAction(); });
    $("#scenario-form").addEventListener("change", () => { resetApproval(); renderPsi(); renderAction(); });
    $("#scenario-form").addEventListener("reset", () => setTimeout(() => { resetApproval(); renderPsi(); renderAction(); }, 0));
    $("#approval-check").addEventListener("change", (event) => { const failed = unsafeModel(currentCategory(), currentModel()); $("#export-button").disabled = !event.target.checked || failed; $("#approval-label").textContent = failed ? "模型失效 · 暂停导出" : event.target.checked ? "已人工核查 · 可导出" : "待人工确认"; });
    $("#export-button").addEventListener("click", exportAction);
    $("#loading").hidden = true; $("#app-content").hidden = false;
    renderAll();
    switchView(["forecast", "psi", "action"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "forecast");
  } catch (error) {
    $("#loading").innerHTML = `<strong>案例数据未能加载。</strong><br>请通过本地服务器打开此页面（例如在仓库根目录运行 <code>python3 -m http.server 8766</code>）。<br><small>${escapeHtml(error.message)}</small>`;
  }
}

init();
