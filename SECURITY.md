# 公开仓库发布检查

本项目是公开静态决策原型。仅发布代码、公开数据的筛选派生物和明确标注的虚构教学样本。

提交前运行 `python3 scripts/check_public_repo.py`，推送前运行 `python3 scripts/check_push_target.py`。配置 `git config core.hooksPath .githooks` 后，pre-push hook 会运行这两项检查。业务规则和本地链接另有本地检查命令；`ci/validate.github-actions.yml` 是待启用的 GitHub Actions 模板，当前没有已运行的托管 CI。

扫描范围包括 tracked 文件、未被忽略的新文件、ZIP 成员、所有可达 Git 历史、提交消息、作者/提交者元数据和远程地址。扫描器只打印文件与风险类型，不打印匹配值。GitHub noreply 提交邮箱允许用于 Git 元数据；应用文件和提交消息中的邮箱仍会被报告。

`.gitignore` 排除环境变量、凭据、私钥、常见聊天导出、本地数据库、原始下载缓存、用户输入、行动导出和诊断文件。忽略规则对已经跟踪的文件无效，不能代替审阅暂存区。截图中可见的文字、未覆盖的密钥格式、隐写内容及外部服务缓存也不能仅靠模式扫描排除。

浏览器加载用户 CSV 后，数据在当前会话内处理；不提供运营数据接收接口。请勿将企业文件、调试日志、HAR、浏览器会话、聊天记录或本地审计展示页提交到本仓库。

发布目标仅为 `SummerPapaya/integrated-planning-workbench`。本仓库独立初始化，不继承作品集的旧提交历史。
