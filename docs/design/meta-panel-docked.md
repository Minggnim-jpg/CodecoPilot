# Meta Panel（Docked）与文件树并行方案（V1.1）

> 日期：2026-02-17  
> 状态：Draft / For Review（含已落地策略）  
> 关联文档：`docs/design/meta-channel-implementation.md`（Meta Explain 功能本身的 V1.2 方案）

## 1. 背景

当前 Meta 问答（Meta Explain）在桌面端以 `fixed` 右侧 Overlay Drawer 形式展示（带遮罩层），会覆盖右侧文件树面板（Files / File Tree）。这导致：

- 文件树与 Meta 面板无法同时可见、无法并行使用；
- 用户需要频繁开关面板，打断“查文件/看上下文 ↔ 提问解释”的工作流；
- 叠层 UI 在多面板场景（Files + DocPreview）下更难管理层级与交互优先级。

本方案目标是将 Meta 面板改造成“第二个右侧停靠面板（Docked Right Panel）”，与文件树面板共同存在、互不重叠，并提供一个显式按钮用于打开/关闭。

## 2. 目标与非目标

### 2.1 目标

1. **并行可见**：桌面端（`>= lg`）Meta 面板与文件树面板可以同时打开，互不覆盖。  
2. **显式入口**：提供一个固定位置的按钮（或折叠栏图标）用于打开/关闭 Meta 面板；保留“选中→Explain”入口。  
3. **最小侵入**：不改动 Meta Explain 的后端协议、流式消费逻辑与问答 UI 主体，仅调整容器形态与布局集成。  
4. **一致体验**：交互形态尽量对齐现有 Files 面板（折叠/展开、可选宽度记忆、桌面端停靠）。  

### 2.2 非目标（本次不做）

1. 不将 Files 与 Meta 合并为一个面板/Tab（避免重构与耦合）。  
2. 不改造 Meta Explain 的 Prompt、SSE 协议、Provider 解析逻辑（除非为适配新增入口必须）。  
3. 不实现 Meta 会话持久化（仍保持面板生命周期内的短会话历史，按现状）。  
4. 不做复杂的多面板编排系统（例如“右侧面板管理器”“可拖拽 Dock”）。  

## 3. 用户交互（UX）需求

### 3.1 打开/关闭入口

需要同时支持两类入口：

1. **显式按钮入口（新增）**  
   - 在 `/chat/[id]` 桌面端始终可见；  
   - 点击后打开/关闭 Meta 停靠面板；  
   - 当打开时，如果当前没有 selection，则展示引导态（见 3.3）。  

2. **Selection Explain 入口（保留）**  
   - 用户在消息区选中内容后点击 `Explain`，打开 Meta 面板并自动发起首问；  
   - 若 Meta 面板已打开，则复用同一面板、重置/开始新一轮解释（按现有逻辑）。  

### 3.2 桌面端面板形态（Docked）

桌面端（`>= lg`）Meta 面板应表现为布局流中的一个右侧 `aside`，而非 `fixed` 叠层：

- **Open 状态**：渲染完整面板（Header + Selection + Q&A + Input）。  
- **Closed 状态**：渲染一个窄条折叠栏（collapsed strip），仅包含一个图标按钮（带 tooltip），用于重新打开。  
- 不再渲染遮罩层；点击页面其他区域不触发关闭（通过 Close 按钮/快捷键关闭）。  

### 3.3 无 Selection 时的行为（新增入口会遇到）

显式按钮打开 Meta 面板时可能没有 selection（因为用户未选中文本）。需要定义降级策略：

推荐 V1（实现简单、可引导用户）：
- 面板顶部保留 Header；
- Selection 区域展示空态：提示用户“选中消息文本后点击 Explain”；
- 输入框可保持可用（允许用户手动提问，但后端请求需要 selection；因此要么禁用 Ask，要么要求先选择文本）。

建议二选一（需要你确认）：
- **策略 A（更严谨）**：没有 selection 时禁用 Ask，并提示“请先选中一段文本”。  
- **策略 B（更灵活）**：允许 Ask，把“当前 selection 为空”视作纯问答（会改变后端 prompt 组装/上下文输入，属于额外需求）。  

本方案默认采用 **策略 A**（不改变后端契约，避免 scope creep）。

### 3.4 响应式（移动端）

移动端（`< lg`）现状是：
- Files 面板整体隐藏（`lg:flex`），不参与布局；
- Meta 面板通过 `Sheet` 全屏/抽屉展示。

本次改造建议保持移动端行为不变：仍使用 `Sheet`，避免窄屏下多面板挤压。

## 4. 布局与技术方案

### 4.1 现状布局（简化）

`AppShell` 目前在根部 Flex 行内挂载：

- 主内容区（Chat）
-（可选）DocPreview（右侧停靠）
-（可选）ResizeHandle（DocPreview）
-（可选）ResizeHandle（Files）
- RightPanel（Files，包含折叠条形态）

同时 `MetaPanel` 目前不在 Flex 流里，而是在外层以 `fixed` 叠加在右侧。

### 4.2 目标布局（推荐顺序）

将 Meta 面板移入 Flex 行，并作为 Files 右侧的第二个停靠面板：

从左到右（`>= lg`）建议顺序：

1. 主内容区（Chat）
2.（可选）DocPreview
3.（可选）ResizeHandle：DocPreview
4.（可选）ResizeHandle：Files
5. Files RightPanel（现有）
6.（可选）ResizeHandle：Meta（新增，位于 Files 与 Meta 之间）
7. Meta Docked Panel（由 MetaPanel 负责渲染停靠形态）

这样可以保证：
- Meta 与 Files 并排且互不覆盖；
- 两个面板的 resize 互不干扰（各自的 handle 位于自身左侧边界）；
- Meta 的折叠条在最右侧边缘，符合“工具面板”习惯。

### 4.3 组件改造建议

为控制改动范围，建议优先采用“原组件内部适配”的方式，不新增过多抽象：

- 保留 `MetaPanelBody`（现有，负责 UI 与交互）；  
- 将 `MetaPanel` 组件的“容器层”改造成双形态：
  - Desktop：Docked `aside` + collapsed strip；
  - Mobile：沿用 `Sheet`；
- 移除/废弃桌面端 `fixed overlay + backdrop` 相关 DOM。

若希望更清晰的职责划分，也可（可选）拆出：
- `MetaDockPanel.tsx`（只负责桌面端停靠/折叠与宽度）
- `MetaPanel.tsx`（保留移动端 Sheet 与 body 组装）

但优先推荐“**只改 `MetaPanel.tsx`**”以保证 diff 更小、可回滚。

### 4.4 状态管理与事件流

保持现有状态边界：

- 面板开关、selection、requestId 仍由 `MetaPanelContext` 管理；
- Files 面板开关仍由 `PanelContext` 管理；
- 二者互不写入对方 context，避免耦合与顶层重渲染。

关键行为：

- **显式按钮打开**：`setOpen(true)`；不改变 selection。  
- **Explain 打开**：`startExplain(selection)` 内部会 `setOpen(true)` 并更新 requestId；此时 Meta 面板若关闭，应自动展开。  
- **关闭**：`setOpen(false)`，并按现有逻辑 abort 当前流、清理本轮 messages/draft。  

### 4.5 面板宽度与 Resize（建议做，且与 Files 对齐）

为了让用户在“文件树 + Meta”并排时可控空间占用，建议加入可调整宽度与记忆：

- 新增 `metaPanelWidth` state（桌面端有效）  
  - 默认值：建议 440（与现有 overlay 宽度接近）  
  - 最小/最大：建议 `260..560`（可按 UI 实测调整）  
- 通过 `ResizeHandle` 实现拖拽调整：
  - handle 位于 Meta 面板左侧（Files 与 Meta 之间）；
  - 计算逻辑与 Files 面板一致：`width = clamp(width - delta)`（因为 handle 在面板左侧，鼠标右移会让面板变窄）。  
- 宽度持久化到 localStorage（对齐现有约定）：
  - key 建议：`codepal_metapanel_width`
  - 写入时机：`onResizeEnd`。

> 注：若希望减少首版改动，也可以 V1 先固定宽度不支持 resize；但并排模式下更容易挤压主内容区，用户体验会明显受影响。

### 4.6 与 DocPreview 的并存策略（已确定）

在极端情况下（小屏但仍 >= lg，或用户把面板拉得很宽），可能同时出现 3 个右侧面板：

- DocPreview（可选）
- Files
- Meta

为避免主内容区被压到不可用，V1.1 采用以下自动折叠规则：

- **触发条件**：桌面端（`>= lg`）且 `/chat/[id]` 下，`Meta(open) + Files(open) + DocPreview(open)` 三者同时存在。  
- **判定方式**：读取主内容区（`main`）实时宽度；若 `< 480px`，触发自动折叠。  
- **折叠目标**：自动关闭 `DocPreview`，保留 `Meta + Files`。  
- **优先级**：`Meta + Files` > `DocPreview`。  
- **触发时机**：Meta 打开后、Meta 宽度拖拽后、窗口尺寸变化、主内容区宽度变化（`ResizeObserver`）。  

该策略为最小侵入实现，不新增全局“面板编排器”。

## 5. 开发改动点（文件级清单）

### 必改

- `src/components/layout/AppShell.tsx`  
  - 将 Meta 面板从 flex 外部“叠层挂载”改为 flex 内“停靠挂载”；  
  - 在 Files 与 Meta 之间插入新的 `ResizeHandle`（若做可调宽度）。  

- `src/components/meta/MetaPanel.tsx`  
  - 桌面端：改为渲染 docked `aside` + collapsed strip；移除 overlay/backdrop；  
  - 移动端：保留 `Sheet`；  
  - 增加显式入口（collapsed strip 的 icon button）。  

### 可能改动（按具体实现选择）

- `src/components/meta/MetaPanelContext.tsx`  
  - 若需要提供 `toggleOpen()` / `reset()` 等辅助方法，保持职责清晰。  

- `src/components/layout/RightPanel.tsx`  
  - 仅当你决定把 Meta 的入口按钮放进 Files 面板 header（本方案不推荐作为唯一入口）。  

### 测试建议（项目已有 Playwright）

- `src/__tests__/e2e/...` 新增或扩展用例：  
  - 打开 Files + 打开 Meta，两者同时可见且不重叠；  
  - Meta 关闭时折叠条按钮可见；  
  - Explain 入口可自动打开 Meta 并开始流式渲染；  
  - 关闭 Meta 时中断流式（可通过 UI 状态/按钮变换断言）。  

## 6. 验收标准（Acceptance Criteria）

1. `/chat/[id]` 且 `>= lg`：Meta 与 Files 两个面板可同时处于 Open 状态，且不发生覆盖（均为布局流内元素）。  
2. Meta 提供显式开关按钮：Closed 状态下按钮可见可点；Open 状态下可关闭。  
3. Selection Explain 流程不回归：选中文本→Explain→Meta 自动打开并发送首问；连续追问正常。  
4. 关闭 Meta 能中断当前请求（Abort），UI 回到非 streaming 状态。  
5.（若实现 resize）拖拽 Meta 的 resize handle 可调整宽度，且刷新后宽度可恢复。  
6. 当 `Meta + Files + DocPreview` 同时开启且主内容区宽度 `< 480px` 时，`DocPreview` 自动折叠。  

## 7. 实施步骤（建议分阶段）

### Phase 0：需求确认（你需要拍板的决策）

1. 无 selection 时的策略：禁用 Ask（推荐）还是允许纯问答（扩展需求）？  
2. DocPreview 与三面板并存优先级：**已定稿为 `Meta + Files` 优先，阈值 480px 自动折叠 DocPreview**。  
3. Meta 面板位置顺序：最右侧（推荐）还是 Files 左侧？  

### Phase 1：桌面端停靠改造（最小可用）

1. 调整 `AppShell`：把 Meta 面板放入 Flex 行并确定顺序；  
2. 调整 `MetaPanel`：桌面端渲染 docked `aside`，Closed 时渲染折叠条按钮；  
3. 保持移动端 `Sheet` 逻辑不变；  
4. 手工回归：Files 与 Meta 并开、Explain 流程、关闭 abort。  

### Phase 2：宽度调整与持久化（推荐）

1. 增加 `metaPanelWidth`、min/max、localStorage key；  
2. 插入 Meta 的 `ResizeHandle`；  
3. 回归：拖拽、刷新恢复、与 Files/DocPreview 共存。  

### Phase 3：补齐测试

1. 新增/扩展 Playwright 用例覆盖并行与入口；  
2. 跑最小相关测试集，确保不引入 UI 回归。  

---

## 8. 讨论点（供评审）

- 是否需要把右侧“折叠条”统一成一个“Right Rail”（包含 Files/Meta 两个 icon），避免出现两个窄条相邻？（本次非目标，但可作为后续优化）  
- 是否要让 Meta 面板记住 open/close 状态（跨会话/跨刷新）？默认建议不记忆，避免误占空间。  
- 未来如果要把 Meta 面板支持“多条 selection 历史/切换”，是否需要更强的 state 模型（本次不做）。  
