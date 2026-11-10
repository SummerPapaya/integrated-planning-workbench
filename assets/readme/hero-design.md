# README hero · Integrated Planning Workbench

面向需求计划员、品类经理与招聘方。头图展示同一业务链的三个动作：预测比较、PSI 情景和人工复核；不宣称精度提升或补货收益。

视觉采用工作台现有的纸张与墨色语言：深灰绿 `#242a26`、暖白 `#f3f0e7`、陶土橙 `#b7653e`、灰蓝 `#839393`。一个连续的计划纸面承载三个视图，避免渐变、浮动卡片和过多边框。中英文标题始终显示；所有曲线和矩阵都明确标为流程示意。

## 文件

- `hero-bilingual.svg`：1200 × 600，自包含 SVG；9 秒 CSS 动画，依次绘出预测、库存与复核标记，随后静止阅读。支持 `prefers-reduced-motion`。
- `hero-bilingual-static.svg`：同构静态版。适用于不播放 SVG 动画的图片查看器；关闭动画不影响理解。
- `hero-preview.html`：渲染预览，提供动画 / 静态、900 / 360px 和背景切换。
- `made-with-beautify.svg`：项目风格的 credits 徽标。

SVG 不加载脚本、外部字体或远程图片，也不使用 foreignObject、渐变或滤镜。不同 Markdown 查看器与图片代理对 SVG 动画的处理可能不同，请以实际渲染为准。

## README 引用

```html
<p align="center">
  <img src="./assets/readme/hero-bilingual.svg" width="100%" alt="Integrated Planning Workbench｜计划与品类决策：比较预测、推演 PSI、人工复核品类行动。">
</p>
```

需静态展示时，将文件名改为 `hero-bilingual-static.svg`。正文与命令保持为 Markdown。

## Credits

本组资产的视觉设计使用 [beautify-github-readme](https://github.com/oil-oil/beautify-github-readme) 技能，按仓库的现有风格编写 SVG；由项目方选择和复核。署名按仓库所有者要求提供。

```html
<p>
  <a href="https://github.com/oil-oil/beautify-github-readme"><img src="./assets/readme/made-with-beautify.svg" width="320" alt="README made with beautify-github-readme"></a>
</p>
```
