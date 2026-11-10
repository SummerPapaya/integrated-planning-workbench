// Optional browser interaction check. Start headless Chrome with --remote-debugging-port=9229 first.
import assert from "node:assert/strict";

const endpoint = process.env.PLANNING_CDP_URL || "http://127.0.0.1:9229";
const pages = await (await fetch(`${endpoint}/json`)).json();
const page = pages.find((entry) => entry.type === "page" && entry.url.includes("/docs/"));
assert(page, "planning workbench page was not found in Chrome");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
let id = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
  if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message.error || message.result.exceptionDetails)));
  else resolve(message.result?.result?.value);
});
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const next = ++id; pending.set(next, { resolve, reject });
    socket.send(JSON.stringify({ id: next, method, params }));
  });
}
function evaluate(expression) { return command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); }

try {
  await command("Page.reload", { ignoreCache: true });
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try { ready = await evaluate("!!document.querySelector('#scope-major') && document.querySelector('#loading')?.hidden"); } catch { /* reload can briefly destroy the execution context */ }
    if (ready) break;
  }
  assert(ready, "planning workbench did not finish loading after reload");
  await evaluate("(()=>{const e=document.querySelector('#scope-major');e.value='Scholar Footwear';e.dispatchEvent(new Event('change'));return true})()");
  const initial = await evaluate("({loaded:document.querySelector('#loading').hidden,major:[...document.querySelector('#scope-major').options].map(o=>o.value),selected:document.querySelector('#scope-major').value,lines:document.querySelector('#scope-category').options.length,skuOptions:document.querySelector('#scope-sku').options.length})");
  assert(initial.loaded, "initial data did not load");
  assert.deepEqual(initial.major, ["Femme Footwear", "Junior Apparel", "Scholar Footwear"]);
  assert.equal(initial.selected, "Scholar Footwear");
  assert(initial.lines === 6 && initial.skuOptions > 100, "initial major and product-line scope failed");
  const modelCount = await evaluate("({options:document.querySelector('#model-policy').options.length,rows:document.querySelectorAll('#model-scoreboard .model-compare-table tbody tr').length})");
  assert.equal(modelCount.options, 8, "auto plus seven forecasting models must be selectable");
  assert.equal(modelCount.rows, 7, "seven candidate model evidence rows must render");
  const chartComparison = await evaluate("(()=>{const policy=document.querySelector('#model-policy').value;document.querySelector('#model-chart-all').click();const count=document.querySelectorAll('#model-chart-options input:checked').length;document.querySelector('#model-chart-reset').click();return {count,reset:document.querySelectorAll('#model-chart-options input:checked').length,policyUnchanged:policy===document.querySelector('#model-policy').value}})()");
  assert.equal(chartComparison.count, 7, "all seven model paths must be selectable together");
  assert.equal(chartComparison.reset, 3, "reset must restore the three-model comparison");
  assert(chartComparison.policyUnchanged, "chart selection must not change the PSI decision model");
  const clickedModel = await evaluate("(()=>{document.querySelector('[data-forecast-model=\"boostedStumps\"]').click();return {policy:document.querySelector('#model-policy').value,pressed:document.querySelector('[data-forecast-model=\"boostedStumps\"]').getAttribute('aria-pressed')}})()");
  assert.equal(clickedModel.policy, "boostedStumps");
  assert.equal(clickedModel.pressed, "true");
  const switchedMajor = await evaluate("(()=>{const e=document.querySelector('#scope-major');e.value='Junior Apparel';e.dispatchEvent(new Event('change'));return {major:e.value,lines:[...document.querySelector('#scope-category').options].map(o=>o.value),skuOptions:document.querySelector('#scope-sku').options.length,status:document.querySelector('#forecast-status').textContent,count:document.querySelector('#scope-count').textContent,skus:[...document.querySelector('#scope-sku').options].slice(1,4).map(o=>o.textContent)}})()");
  assert.equal(switchedMajor.major, "Junior Apparel");
  assert.deepEqual(switchedMajor.lines, ["", "Junior Apparel Cozy Pullovers", "Junior Apparel Crew Tees", "Junior Apparel Printed Tees"]);
  assert(switchedMajor.skuOptions > 300 && switchedMajor.status.includes("大类级") && switchedMajor.count.includes("14 门店"));
  assert(switchedMajor.skus.every((name) => name.includes("Junior Apparel")), "Junior major includes products from another major");
  const switchedCategory = await evaluate("(()=>{const e=document.querySelector('#scope-category');e.value='Junior Apparel Cozy Pullovers';e.dispatchEvent(new Event('change'));return {category:e.value,skuOptions:document.querySelector('#scope-sku').options.length,signals:document.querySelector('#category-signals').textContent,status:document.querySelector('#forecast-status').textContent}})()");
  assert.equal(switchedCategory.category, "Junior Apparel Cozy Pullovers");
  assert(switchedCategory.skuOptions > 30 && switchedCategory.signals.includes("低样本预测") && switchedCategory.status.includes("产品线级"));
  const selectedSku = await evaluate("(()=>{const e=document.querySelector('#scope-sku');e.value=e.options[1].value;e.dispatchEvent(new Event('change'));return {sku:e.value,status:document.querySelector('#forecast-status').textContent,scoreboard:document.querySelector('#model-scoreboard').textContent,rows:document.querySelectorAll('#model-scoreboard [data-forecast-model]').length,lowSample:!!document.querySelector('#model-scoreboard .model-empty')}})()");
  assert(selectedSku.sku && selectedSku.status.includes("SKU 级"));
  assert(selectedSku.rows === 7 || (selectedSku.rows === 0 && selectedSku.lowSample && selectedSku.scoreboard.includes("低样本")), "SKU must show either seven candidates or an explicit low-sample explanation");
  const model = await evaluate("(()=>{const e=document.querySelector('#model-policy');e.value='holtWinters';e.dispatchEvent(new Event('change'));return {policy:e.value,caveat:document.querySelector('#psi-caveat').textContent}})()");
  assert.equal(model.policy, "holtWinters");
  assert(model.caveat.includes("优先选择 Holt-Winters") && model.caveat.includes("低样本 SKU 仍用均值"));
  const service = await evaluate("(()=>{document.querySelector('[data-service=\"98\"]').click();return {active:document.querySelector('.service-card.active').dataset.service,impact:document.querySelector('#psi-impact').textContent}})()");
  assert.equal(service.active, "98");
  assert(service.impact.includes("建议补货量"));
  await evaluate("(()=>{document.querySelector('[data-view=\"category\"]').click();const cell=[...document.querySelectorAll('[data-segment]')].find(x=>Number(x.querySelector('b').textContent)>0);cell.click();return true})()");
  const filtered = await evaluate("({segment:document.querySelector('.matrix-cell.active')?.dataset.segment,count:document.querySelector('#action-count').textContent,rows:document.querySelectorAll('#action-rows tr[data-action-sku]').length})");
  assert(filtered.segment && filtered.rows > 0 && filtered.rows <= 18);
  const reviewed = await evaluate("(()=>{document.querySelector('#action-rows tr[data-action-sku]').click();const note=document.querySelector('#action-note');note.value='已核对当前情景，等待供应商复核';note.dispatchEvent(new Event('input'));document.querySelector('#action-include').click();document.querySelector('[data-view=\"review\"]').click();return {count:document.querySelector('#review-count').textContent,enabled:!document.querySelector('#export-decisions').disabled,log:document.querySelector('#review-log').textContent}})()");
  assert.equal(reviewed.count, "1");
  assert(reviewed.enabled && reviewed.log.includes("已核对当前情景"));
  console.log("Browser interaction checks passed: major category, product line, SKU, model, service target, ABC–XYZ filter and human review.");
} finally { socket.close(); }
