# 数据来源与许可

公开业务样本来源：Smith, Jimmy (2026), [Retail Transactions and Stocks Data，Mendeley Data，版本 1](https://data.mendeley.com/datasets/27x8mjm8k4/1)，DOI `10.17632/27x8mjm8k4.1`。作者与许可按该 DOI 的 DataCite 元数据核对。源数据采用 [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/)。

`docs/demo.json` 和 `docs/method-case/data.json` 是筛选、清洗及计算后的派生文件；它们不代表原始数据集的全部门店或商品。数据许可保留为 CC BY 4.0；该许可不自动扩展到本仓库的软件代码。

构建会核对两份原始 CSV 的 SHA-256：

- 销售 `retail_sales_ml_apl.csv`：`da4763939baed1f46bfca7e893f9512a0294544494b1e794e5b8f2c59efbd2a1`
- 库存 `retail_inventory_ml_apl.csv`：`c765678a26c2d024e8300b8f5b4a67cb2e2bde6e24213f202914557d000ce37d`

工作台派生样本截至 2026-04-24，包含三个大类、九条产品线及二十家按鞋类销售选定的门店。Junior Apparel 只覆盖其中十四家门店。原方法案例使用六条鞋类产品线，范围与工作台不同；两个入口各自注明口径。

库存来自有效期间记录，不能称为截止日实盘或可售库存。源数据缺少真实采购到货、交期、促销执行和缺货暴露，相关输出必须标为情景模拟。构建脚本与方法页面保留具体筛选规则和输入摘要。

`docs/synthetic-case.mjs` 及 `docs/templates/` 为独立虚构教学输入；不声称来自 Mendeley、客户或任何企业系统。用户运营文件不属于发布材料，不应提交至公开仓库。
