# DS Margin · 留白 产品调研与路线图

2026-11-10 · 基于 0.2.4 源码、现有受控测试记录、开源仓库和产品官方资料。Chrome 商店描述由开发者提供。竞品功能按公开资料核对，未安装逐项实测。开发顺序和验收目标是产品建议。

本文保留 0.2.4 时期的调研与设想。0.4.0 已移除串行任务，后续开发重点转向划词旁问。 [当前说明](README.md#划词旁问)

## 方向

先把 DS Margin 做成 **打开 DeepSeek 就能继续上次工作** 的工具。用三个操作衡量体验好坏。找到旧对话里的那一句，带着正确的材料继续问，出错后找到接着做的位置。

0.2.4 已有 `Alt+K` 命令面板、`Alt+O` 目录、带文件夹和标签的本地书库、摘录和来源定位、`/` 变量模板、草稿冲突保护、Markdown/JSON 导出，以及串行研究和小说任务。已有的 Chromium 和 Edge 验证各覆盖 38 项受控界面检查、9 项受控任务检查。官网记录到达登录页，真实账号里的首屏、生成与任务恢复仍待验收。 [现版说明](README.md) · [验证记录](TESTING.md#024--2026-11-10北京时间)

`Alt+K` 已可搜本地已收录的正文，命中时只显示对话标题。书库会显示片段，结果仍以整场对话为单位。目录能跳到当前加载的消息，临时翻回旧内容后缺少一个明确的「回到刚才」。把搜索和目录接通，既能改善普通聊天，也能给收藏、分支和研究成果提供同一套定位能力。 [命令面板](src/ui/Command.tsx#L94) · [书库搜索](src/shared/model.ts#L115) · [目录](src/ui/App.tsx#L193)

## 可借鉴的交互

| 场景 | 已核对的做法 | DS Margin 的落点 |
| --- | --- | --- |
| 找一句旧回答 | ChatGPT 在同一搜索入口支持标题和正文，并用类型筛选区分对象。Raycast 在同一搜索框找不同对象，再按所选对象给出可用动作。 | **统一 `Alt+K`。** 搜对话、消息、摘录、成果和命令。结果显示命中原句、来源和类型。回车读命中段落，「打开原对话」作为后续动作。空查询显示最近浏览和常用入口。 [ChatGPT 搜索](https://help.openai.com/en/articles/10056348-finding-your-chats-projects-and-files-in-chatgpt) · [Raycast 搜索](https://manual.raycast.com/search-bar) · [Raycast 动作面板](https://manual.raycast.com/action-panel) |
| 在长对话来回读 | ChatOutline 提供当前位置、跳转高亮和阅读位置前进／后退。Thread Atlas 在生成中短暂保护用户主动跳到的位置。 | **读到哪就记到哪。** 目录用问题和回答小标题分层，标出当前位置。点击跳转后给「回到刚才」。用户向上读旧内容时，显示「回到最新」，优先尊重用户的滚动意图。 [ChatOutline](https://chromewebstore.google.com/detail/chatoutline/egpdhibeofloknmlehcdigcjnbgcegpj) · [Thread Atlas](https://chromewebstore.google.com/detail/thread-atlas-for-chatgpt/dbpoalkoombjenienpgkljdflfdoecdc) |
| 选中一句就能用 | Voyager 的 DeepSeek 功能矩阵包含划词引用和公式复制。LibreChat 可以将选中段落加入输入框。 | **划词后就地给「引用追问」「摘录」。** 引用可移除，插入前预览，保留现有草稿和光标。公式支持复制 LaTeX；代码、表格的独立操作按内容类型出现。 [Voyager 功能矩阵](https://github.com/voyager-crew/voyager#what-you-get) · [LibreChat 消息操作](https://www.librechat.ai/docs/features/message_actions) |
| 收藏后还能找回出处 | Obsidian Web Clipper 的高亮回访时仍可见。W3C 的文本引用选择器用原句加前后文区分重复文本。 | **让摘录可回访。** 保存对话、消息 ID、版本指纹和必要的前后文。原文可确认时高亮对应段落；重新生成、未加载或有多个匹配时，打开当时的本地快照并标明原因。 [Obsidian 高亮](https://obsidian.md/help/web-clipper/highlight) · [W3C 文本锚点](https://www.w3.org/TR/annotation-model/#text-quote-selector) |
| 导出可复用的内容 | DeepSeek Toolbox 的导出只覆盖当前页面已加载消息。Obsidian Web Clipper 支持用变量与模板整理来源等元数据。 | **先做段落／选中消息／本地快照三种范围。** 导出前显示条数、覆盖范围和已知缺项。优先让 Markdown 的代码、表格和公式在 Obsidian 中可用，附来源、收录日期和用户备注。 [DeepSeek Toolbox 兼容说明](https://github.com/Hamzaaw/deepseek-toolbox#compatibility-notes) · [Obsidian 导出模板](https://obsidian.md/help/web-clipper/templates) |
| 反复用同一份提示词 | PromptDeck 的 `/` 表单支持默认值、下拉选项，并能从选区存模板。Open WebUI 支持有类型的变量和提示词版本管理。 | **补齐现有模板的日常细节。** 自建模板原地编辑，常用和最近使用排前；变量支持必填、默认值和选项。预览展开结果，再填进原生输入框。团队级管理和版本对比可后置。 [PromptDeck](https://chromewebstore.google.com/detail/promptdeck-%E2%80%94-prompts-for/lbkggjbgjkhcomobicakgpmphcmkcboo) · [Open WebUI 提示词](https://docs.openwebui.com/features/workspace/prompts/) |
| 第二天继续同一个项目 | ChatGPT Projects 可以把一条回答存成项目资料，与聊天、文件、项目指令一起管理。 | **把书库文件夹扩成可选的本地项目。** 聚合对话、摘录、模板和任务成果，显示「上次进展／下一步」。从旧对话带资料到新对话时，逐项显示将发送的原文或摘要。 [ChatGPT 项目资料](https://help.openai.com/en/articles/10169521-projects-in-chatgpt) |
| 从一条回答试另一条思路 | LibreChat 的 Fork 菜单说明会复制哪部分消息，可以排除附件。Better DeepSeek 的商店说明列出长对话摘要后开启新会话。 | **做「带资料新开对话」。** 选择该条回答、前几轮、摘录或手写摘要，预览后填进新对话草稿。记录来源与子对话关系。DeepSeek 的未加载分支、附件和服务端上下文不在迁移范围内。 [LibreChat Fork](https://www.librechat.ai/docs/features/fork) · [Better DeepSeek](https://chromewebstore.google.com/detail/better-deepseek/aabiopennjmopfippagcalmkdjlepdhh) |
| 把回答变成可交付成果 | Claude Artifacts 将成果放在聊天旁，可独立查看、编辑和导出。 | **从已有书库成果做起。** 允许把长回答保存为可单独打开的报告、章节或代码草稿。先支持安全的 Markdown 阅读、人工修订和版本回看，并保留对话出处。 [Claude Artifacts](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them) |
| 判断研究结论有无根据 | Gemini Notebook 的引用可悬停查看摘句、点击回到来源上下文，并能把带引用的回答存成笔记。 | **研究报告加逐条证据核查。** 每条主张关联来源、摘句、核查时间和状态。区分「待核查」「证据支持」「证据不支持」「无法访问」。打开链接与验证主张分开记录。 [Gemini Notebook 引用](https://support.google.com/gemininotebook/answer/16179559) |
| 持续写长篇小说 | SillyTavern 的 Lorebook 按关键词找到设定条目，并控制带入的上下文量。 | **把已有设定集拆成可维护的卡片。** 人物、时间线、已确立事实、待回收伏笔分别管理。写下一章时提示相关卡片，用户决定带哪些，显示实际字符量。保留章稿、设定冲突和修订对应关系。 [SillyTavern World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/) |
| 当前回复没完，先写下一问 | Cursor 把排队内容放在当前任务下方，支持重排。Better DeepSeek 的商店说明列出生成结束后自动提交队列。 | **先做待发草稿队列。** 允许编辑、取消和重排，原会话未结束时清楚标记「待发」。自动续发放到真实网页验收之后，按会话明确开启；切会话、改模式或发送状态不确定时暂停。 [Cursor 队列](https://cursor.com/docs/agent/overview#queued-messages) · [Better DeepSeek](https://chromewebstore.google.com/detail/better-deepseek/aabiopennjmopfippagcalmkdjlepdhh) |
| 任务被打断 | n8n 执行历史可按状态筛选，从保存的执行状态重试，并提醒失败节点可能已经完成部分外部动作。Perplexity Computer 将等待确认的动作放到用户当前操作的位置。 | **让状态和下一步一起出现。** 开跑前显示计划、将发送的材料与上限。运行时区分「准备」「已确认发送」「等待回答」「需处理」。若发送结果未知，把「查看原对话」放在重试前。完成项继续可读可导出。 [n8n 执行记录](https://docs.n8n.io/build/understand-workflows/understand-executions/view-all-executions) · [Perplexity 交互](https://www.perplexity.ai/en-GB/changelog/deep-research-command-panel-forking-inline-actions-and-enterprise-controls) |
| 原站改版后还能用 | Voyager 将功能和站点语义选择器分开，公开按站点列出能力。Better DeepSeek 的更新说明记录过因 DeepSeek 改版发布热修。 | **按能力分别降级。** 找不到发送按钮就停任务，目录识别不稳就提示范围，独立书库仍能读。沿用现有适配器集中维护，保留关闭增强的入口。 [Voyager 站点适配](https://github.com/voyager-crew/voyager#how-it-works) · [Better DeepSeek 更新说明](https://chromewebstore.google.com/detail/better-deepseek/aabiopennjmopfippagcalmkdjlepdhh) |

DeepSeek Toolbox 已把文件夹、回复书签、提示词链和导出放进同一插件，Voyager 也覆盖一批常见增强。判断 DS Margin 是否更好用，可以直接比较找回一段话、把它带入下一问、处理一次中断各需几步。调研以交互为单位。若将来复用代码，按各仓库许可证核对，Voyager 与 Toolbox 均采用 GPL-3.0 系列许可。 [DeepSeek Toolbox 仓库](https://github.com/Hamzaaw/deepseek-toolbox) · [Voyager 仓库](https://github.com/voyager-crew/voyager)

## 开发顺序

### 第一轮 · 找回、摘录、继续问

1. **统一搜索和消息定位。** 复用 `Alt+K`、现有书库和 IndexedDB。第一批做消息级结果、来源预览和快照兜底。正文只检索已加载或已收录范围，搜索框旁直接写清范围。大库按条分页和按变更更新，避免每次输入都把整库送到聊天页。 [命令入口](src/ui/Command.tsx#L94) · [书库读取](src/background/index.ts#L10)
2. **给长对话一条返回路。** 目录先做小标题、当前位置、「回到刚才」和「回到最新」。在 0.2.4 的纸色、衬线正文和轻磨砂面板内调整层级。正文保留短而直接的动作，工具栏常驻入口维持现有数量。窄屏、键盘和中文输入法是同一批验收项。 [目录实现](src/ui/App.tsx#L193) · [0.2.4 受控阅读预览](output/playwright/0.2.4/reading-light.png)
3. **给划词和导出共用同一套来源。** 选中即显示「引用追问」「摘录」，在命令面板能搜到摘录。所选段落可以复制 Markdown，命中本地旧版时明确显示快照时间。 [现有选区和收藏](src/content/controller.ts#L243) · [导出实现](src/shared/export.ts)

### 第二轮 · 项目和任务可靠性

- 先完成真实已登录 DeepSeek 的首屏、普通发送、深度思考、搜索、刷新和停止验收。再做任务启动预览和失败恢复。复用现有发送检查点，检查未知结果时是否避免重复提交，避免争抢人工正在使用的输入框。 [真实验收用例](TESTING.md#登录后验收)
- 项目资料、带资料新开对话和可独立阅读的成果共用第一轮的来源标识。项目按用户选择归类，避免凭页面标题推断账号。补充本地收录状态和范围开关，验证旧数据迁移、自产备份导入、清空与暂停收录。 [本地记录和备份](README.md#本地记录的范围)
- 优先验证一个研究任务能把主张追溯到证据，以及一个小说任务能查到设定冲突和修订。用户能读到实际传入的材料、步骤和成果后，再评估自动续发和更多任务模板。

### 第三轮 · 有数据后再决定的能力

- **更多历史。** 评估用户手动提供的导出包离线导入，先拿实际样本确认结构、权限和覆盖范围。当前归档的来源是已观察消息。虚拟列表、未打开会话和未观察分支都可能缺失。 [当前归档范围](README.md#本地记录的范围) · [同类扩展的页面范围说明](https://github.com/Hamzaaw/deepseek-toolbox#compatibility-notes)
- **更多自动化。** 执行继续使用已登录的网页控件，依赖浏览器和运行标签页可用。优先投入外发材料预览、会话绑定和不确定时暂停。DeepSeek 协议第 3.5 条涉及自动化抓取和复制，扩展自动化范围前需按具体行为核对。 [DeepSeek 用户协议](https://cdn.deepseek.com/policies/zh-CN/deepseek-terms-of-use.html) · [Chrome 扩展后台生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)

## 用反例验收

| 任务 | 建议通过标准 |
| --- | --- |
| 只记得一句正文 | 用 `Alt+K` 输入中文关键词，结果显示命中的句子，回车落到该句。原站未加载时仍可从本地快照阅读，并可打开原会话。 |
| 两处有相同的句子 | 根据来源消息和版本区分；无法确定时显示两处或回退快照，避免静默跳错。 |
| 在生成期间回看较早的回答 | 跳到旧段后能继续读，生成结束可用「回到最新」。临时跳转后能返回原位置。 |
| 一边打中文一边打开模板 | 输入法选字的回车照常生效。退出模板后焦点回原位，既有草稿和选区可预期，插入模板由用户决定何时发送。 |
| 导出一段含公式、代码和表格的回答 | 所选范围在导出前可见，在目标 Markdown 阅读器中验证这些结构。较大备份要实际导出后回导，不能只测小样本。 |
| 两标签页编辑或执行同一对话 | 手工草稿与任务提示词各有归属；刷新、停止、切会话或发现发送状态未知时，界面显示已确认步骤和可执行的下一步。 |
| 从旧版本升级并切换 DeepSeek 账号 | 旧数据可读取和备份。明确展示这是当前浏览器配置的本地库。启用显式工作区后，搜索、引用和任务材料遵从所选工作区。 |
| 大库里搜索，同时新回复正在流式生成 | 在固定的 Windows 测试机上，以 1 万条本地消息作为首轮样本，记录 p95 搜索耗时和输入卡顿。暂定本地搜索 p95 在 200 ms 内，最终以实测和用户操作感受校准。 |

首个可交付版本可收在一条路径里验收。**搜索旧答案 → 回到那一段 → 选中引用并继续问 → 原位置可返回。** 这条路径使用已有的命令面板、目录、书库和输入框，也为项目资料与研究证据建立同一套来源定位。
