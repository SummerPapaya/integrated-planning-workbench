# Integrated Planning Workbench｜计划与品类决策

面向需求计划员与品类经理的可运行决策原型，将 **预测擂台 → PSI 决策台 → 品类行动台** 放在同一业务范围中。采用浏览器原生 HTML、CSS 和 JavaScript，无须安装依赖、账户或 API key。

这是工作台的独立仓库：[SummerPapaya/integrated-planning-workbench](https://github.com/SummerPapaya/integrated-planning-workbench)。作品集介绍见 [Supply Chain Lab](https://supply-chain-lab.summercommences.com/)。

## 本地运行

要求 Python 3.10+；自动校验另需 Node.js 22+。

```sh
python3 -m http.server 8768 --bind 127.0.0.1
```

打开 [工作台](http://127.0.0.1:8768/docs/)、[90 秒讲解](http://127.0.0.1:8768/docs/walkthrough.html) 或[原方法案例](http://127.0.0.1:8768/docs/method-case/)。JSON 和模块需要通过 HTTP 加载，直接双击 HTML 无法正常运行。

## 能力与边界

- **预测**：按业务大类、产品线与 SKU 比较七种模型，同图勾选结果；56 天选模与最后 28 天独立时间测试分开。弱模型、恶化和低样本回退照实展示。
- **PSI**：在 SKU × 门店粒度滚动库存；比较 90/95/98% 安全量情景、交期与容量假设，并提供逐日明细。服务目标尚未经实际达成率校准。
- **品类**：ABC–XYZ、销售、成本、退货和风险排序；人工纳入、暂缓或不采纳，再导出有数据摘要和情景编号的行动建议。
- **执行证据**：可接入可售库存、PO/ETA、促销、后续观测与回执。公开数据缺少这些记录，独立合成案例用虚构记录演示负结果。

公开样本、独立合成案例和用户 CSV 是三种互相替换的数据模式，不跨源连接。上传文件在浏览器会话内处理；没有服务器、身份权限、持久审批或 ERP/WMS 回写。导出不是采购单。

## 数据与复现

业务样本源于 [Mendeley Data，DOI 10.17632/27x8mjm8k4.1](https://data.mendeley.com/datasets/27x8mjm8k4/1)，源数据许可为 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。此仓库保留筛选后的派生 JSON，不包含原始 CSV。构建脚本按记录的 SHA-256 核对原始文件，下载缓存忽略于 Git。数据的底层企业来源未经独立核验，不能将情景结果称作企业实绩。详见 [数据来源与许可](DATA-NOTICE.md)。

```sh
python3 scripts/build_planning_workbench.py
python3 scripts/build_planning_console_demo.py
python3 scripts/build_console_templates.py
```

首次重建会下载源 CSV，运行现成演示不需要下载。构建脚本也支持 `--sales` / `--inventory` 指定相同版本的本地源文件。

## 校验与发布

```sh
node scripts/check_planning_console.mjs
python3 scripts/check_planning_workbench.py
python3 scripts/check_static_links.py
python3 scripts/check_public_repo.py
python3 scripts/check_push_target.py
git config core.hooksPath .githooks
```

仓库提供本地 pre-push 检查和 CI 配置模板；本地 hook 需要上面的配置命令启用。当前 GitHub Actions 尚未启用：现有推送凭据没有 `workflow` 权限，模板保存在 `ci/validate.github-actions.yml`。可在 GitHub 网页编辑器中将其创建为 `.github/workflows/validate.yml` 后启用。安全扫描不打印命中值，覆盖文件、ZIP 成员、Git 历史、提交元数据与远程地址。它是模式检查，无法保证发现所有敏感信息；发布前仍需审阅暂存区。见 [SECURITY.md](SECURITY.md)。

如需 GitHub Pages，可在该独立仓库 Settings → Pages 选择 `main` 分支的 `/docs` 目录。推送源代码不代表已经启用网页托管。

## 文档

- [完整功能、业务口径与 CSV 契约](docs/README.md)
- [演示版本与预期负结果](docs/RELEASE.md)
- [生产化架构与差距清单](docs/production-readiness.html)
- [App01 × Power BI 能力对照](docs/reference/app01-vs-power-bi-preview.html)
- [Power BI 对照案例规划](docs/reference/power-bi-counterpart-project-plan.html)

目录：`docs/` 是可独立托管的完整站点，`docs/method-case/` 保留原叙述案例，`docs/reference/` 保存辅助分析，`scripts/` 保存构建与校验工具。
