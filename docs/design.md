# DSH Vision Plugin 设计文档

> 文档状态：Draft v1  
> 日期：2026-08-16  
> 目标产品：DeepSeek Harness（dsh）Vision Plugin

## 2. 产品命名

```text
MindsEye（产品）
├── Fovea    视觉引擎：结构化证据、定位、像素分析
├── Nexus    视觉记忆：神经丛，非简单存储，而是融合、检索、遗忘、推理的记忆网络
└── Effector GUI 操作模块（V3 启用）
```

说明：记忆模块不使用 `Memory` 这类通用词，也不把记忆定义为纯存储；Nexus（神经丛）强调“多条记忆路径交汇、融合、协同推理”的记忆网络。

## 1. 背景与目标

DeepSeek Harness 的核心 DeepSeek 模型是纯文本模型，不能原生读取图片。社区已有多个 vision 插件解决“让 DeepSeek 看见图片”的问题，但大多停留在：

- 单一桥接：把图片转成一段描述注入上下文；
- 简单工具链：截图、定位、OCR、像素对比；
- 内存级缓存：仅按图片哈希缓存，会话结束即失效。

本插件要解决的问题：

1. 让 DeepSeek 用户粘贴图片即可用，使用门槛最低；
2. 按意图路由到最合适的 OCR / 视觉理解 / 定位模型；
3. 输出稳定、结构化、可复用的 JSON 证据；
4. 建立轻量的持久视觉记忆，而不是“每次重新看图”；
5. 后续以 GUI 自动化作为差异化能力，但 vision 本身是主线。

## 2. 产品定位与战略

核心判断：**vision 是所有 DeepSeek 用户的最大共性需求；GUI 自动化是小众但高溢价的能力。**

因此产品按两层设计：

```text
核心层（所有用户）：
  粘贴即看图
  模型选工具 + 多模型路由
  结构化 JSON 证据
  轻量记忆与复用

差异化层（Pro 用户，默认关闭）：
  Browser Automation 模块
  Desktop Automation 模块（后期）
  高级语义检索
```

产品原则：

- GUI 模块不进入默认体验，避免膨胀工具 schema；
- 记忆层默认轻量，不引入向量库；工具选择由模型驱动，不维护规则分类器或本地 embedding 路由；
- 产品主体必须是原生 dsh 插件，不依赖第三方 MCP server 作为核心能力；
- MCP 只用于原型验证或作为可选执行器适配器。

## 3. 调研结论

### 3.1 现有 5 款 vision 插件

| 插件 | 核心机制 | 能力 | 缺口 |
| --- | --- | --- | --- |
| ModLens | Node CLI + dsh 工具 + LLM 路由包装 | 后端池广、粘贴体验好、结构化证据 | 无像素工具链 |
| agent-vision-toolkit | Python CLI + 透明代理 + skill | intent-aware、跨 harness | 非 dsh 原生 |
| dsh-vision-router | LLM 模型组包装 + 11 个工具 | 零配置免费链、像素闭环 | 无动作执行器 |
| dsh-vision | 替换 DeepSeek adapter | 原生粘贴桥接、多级 fallback | 无工具链 |
| dsh-vision-toolkit | 原生工具 + skill + managed Python runtime | 工程化最强、Artifacts、Web/Headless | 不自动桥接、无动作执行器 |

结论：**原生 dsh 支持视觉模型作为主模型，但所有插件补的是“文本模型 + 视觉模型桥接”或“视觉工具链”。真正的共同空缺是动作执行器、持久视觉记忆和视觉评测。**

### 3.2 MemEye 的启发

MemEye 用二维矩阵评估多模态 agent 记忆：

```text
X 轴：视觉证据粒度：场景 → 区域 → 实例 → 像素
Y 轴：推理深度：原子检索 → 关系关联 → 演化综合
```

关键发现：

- caption 对场景/区域级足够，但实例/像素级不足；
- 语义检索会混淆“相关”与“时间权威”，过期证据可能排到前面；
- 原生视觉证据帮助大，但不等于演化综合能力。

对项目的直接含义：**结构化证据必须和描述性 caption 分离，记忆必须带时间与可信度。**

### 3.3 视觉记忆方法的启发

- M2A：append-only raw store + semantic memory + evidence_ids，BM25 + dense text + image embedding 二级 RRF；
- MMA：source credibility + temporal decay + consensus 的置信度加权检索；
- SimpleMem-MM：只存图片指针，回答时按需加载图片；
- agentic-memory：semantic / episodic / procedural 分库，relevance + recency + importance 排序，含遗忘与去重。

对本项目的吸收结论：

1. 证据层和答案层分离；
2. 软记忆用“相关性 + 时间 + 可信度”排序；
3. 图片和原始工具结果按需加载；
4. 需要遗忘、更新、去重机制；
5. 需要自己的评测矩阵。

## 4. 总体架构

```text
用户粘贴图片
  → 附件/路径进入 dsh
  → vision plugin
      ├── 工具选择与模型路由
      ├── 视觉模型调用（OCR / QA / grounding / 本地算法）
      ├── 结构化 JSON 输出
      ├── 证据写入（后台异步）
      ├── 精确缓存查询
      ├── 软记忆检索（可选）
      └── 注入 DeepSeek 上下文 / 返回工具结果
```

插件对外暴露的工具建议：

```text
mindseye_read_image(path | attachmentId | attachmentIds, query?, region?, model?)
mindseye_ocr(path | attachmentId | attachmentIds, query?, region?, model?)
mindseye_ground(path | attachmentId, query, region?, model?)
mindseye_colors(path | attachmentId | attachmentIds, query?, region?, model?)
mindseye_vision_activate()
mindseye_memory_put / get / search / diff
```

## 5. 核心设计

### 5.1 工具选择与模型路由

意图用于**路由**，不用于**缓存判等**。意图不再由插件猜测，也不再要求模型显式传 `intent` 参数：插件把每个意图固化为一个工具，由 DeepSeek 根据用户问题选择工具，工具内部再按固定映射选择模型链。

```text
DeepSeek 选工具（意图路由）
  → 工具固定意图（注册时确定）
  → 意图映射到路由族（understand / extract / locate）
  → 路由族映射到可配置的 provider/model fallback 链
```

当前工具与路由映射：

| 工具 | 固定意图 | 路由族 | 批量 |
| --- | --- | --- | --- |
| `mindseye_read_image` | visual-qa | understand | 支持 |
| `mindseye_ocr` | ocr | extract | 支持 |
| `mindseye_ground` | grounding | locate | 不支持 |
| `mindseye_colors` | color | understand | 支持 |

设计要点：

- 模型只负责“选工具”，不需要知道内部模型链；工具描述是路由的第一层约束；
- 每个路由族可配置独立模型链，未配置的 extract / locate 自动回退到 understand，再回退到全局 fallbacks；
- 图片轮通过 `agent/pre-step` 检测图片消息并自动挂载视觉工具；
- 纯文本轮只注册 `mindseye_vision_activate`，避免工具定义常驻挤占 DeepSeek 上下文；图片轮或显式调用后注册全套工具；
- 不再维护关键词规则、正则评分或 embedding semantic router，消除了“颜色词 + 位置词”这类规则冲突的持续维护成本；
- 路由结果进入输出 JSON 的 `intent` 字段，便于审计和证据复用。

### 5.2 结构化 JSON 输出契约

所有视觉结果统一为 JSON，示例：

```json
{
  "version": 1,
  "intent": "visual-qa",
  "query": "normalized-query",
  "images": [
    {
      "sha256": "abc...",
      "path": "/workspace/img.png",
      "width": 1280,
      "height": 720,
      "format": "png"
    }
  ],
  "evidence": {
    "ocr": { "full_text": "...", "language": "chi_sim+eng" },
    "layout": [{ "region": "x1,y1,x2,y2", "content": "..." }],
    "elements": [{ "type": "button", "label": "Send", "box": {"x1":1,"y1":2,"x2":3,"y2":4} }],
    "colors": [{ "hex": "#FFFFFF", "share": 0.7 }]
  },
  "answer": {
    "text": "...",
    "structured": {}
  },
  "meta": {
    "provider": "qwen-vl",
    "model": "qwen3-vl-plus",
    "latencyMs": 1200,
    "attempts": [
      { "provider": "qwen-vl", "ok": true, "latencyMs": 1200, "usage": { "inputTokens": 800, "outputTokens": 120, "totalTokens": 920 } }
    ],
    "cache": "miss",
    "usage": { "inputTokens": 800, "outputTokens": 120, "totalTokens": 920 }
  }
}
```

契约原则：

- `evidence` 是意图无关事实，可复用；
- `answer` 是意图相关结果，不可随意复用；
- `meta` 记录路由、provider、模型、延迟、尝试、真实 token 用量，便于审计和评测；
- 所有字段必须是 JSON，禁止把 UI 格式塞进模型可见内容。

### 5.3 证据层

证据层按 `sha256(image)` 复用，只存不随问题变化的事实：

- OCR 全文；
- 布局区域；
- 元素列表 + 坐标；
- 色板（`{ hex, share }`）/ 尺寸 / 来源。

证据层是视觉记忆的基础。同一张图，OCR 全文和布局区域不会因为问题变化而改变，可以安全复用；色板只对明确整图级颜色问题（如“整体主色”“整张图有哪些颜色”）直接复用，其他颜色问题注入色板后仍调模型；元素列表只注入、不直接复用。

V1 只负责把证据结构化输出到结果里（单图 `evidence`、批量 `answer.structured.results[id].evidence`），跨调用按哈希复用属于 V2 Nexus 记忆层。

### 5.4 精确缓存

精确缓存用于“同图同问法”的答案复用：

```text
key = sha256(image)
    + normalized_query
    + region
    + provider
    + model
    + prompt_version
```

normalized_query 的生成：

```text
NFC 规范化
转小写（英文）
全角转半角、统一标点、折叠空白
去掉礼貌/填充词（请、帮我、你能、please、谢谢）
同义词归一（图片/图像/截图/image/screenshot → image）
统一数量/格式表达
保留关键问句词（是什么 / 在哪 / 有几个 / 有没有 / 为什么）
```

判定标准：**两个问题只有在“对同一图、同一区域、同一模型，答案可以安全复用”时才视为同一问题。** 拿不准就不命中；miss 的代价是一次调用，wrong 的代价是用户信任。

精确缓存是 V1 的“同图同问法”去重，只解决 agent 反复问同一句话的场景，收益有限。它不是产品主线，真正的主线是证据复用（图片哈希级硬事实）和软记忆（历史问答参考），V2 会用更丰富的决策元数据替换 `cache: hit/miss` 这种二元标记。

### 5.5 软记忆

软记忆不是硬缓存。它把历史问答作为**参考上下文**注入，而不是直接返回旧答案：

```text
新问题未命中精确缓存
  → 检索同一 sha 或相似图片的历史记录
  → 按 relevance + recency + confidence 排序
  → 注入：
      [历史参考，未经验证]
      这张图之前被问过：Q1 → A1；Q2 → A2
  → 当前模型重新回答，可以采纳、纠正或忽略
```

v1 不引入 embedding；软记忆检索用 BM25 / 文本相似度即可。

### 5.6 视觉记忆库 Schema

建议使用 SQLite 或 JSONL，放在 workspace 或 `DSH_HOME` 下。

```text
visual_evidence
  id
  sha256
  path / attachment_id
  width / height / format
  ocr_json
  layout_json
  elements_json
  colors_json
  provider / model
  created_at

visual_analysis
  id
  evidence_id
  intent
  normalized_query
  region
  provider / model
  prompt_version
  answer_json
  confidence
  source            -- user-verified / model-inferred / tool-result
  created_at
  last_accessed_at
  access_count
  importance

visual_memory_meta
  id
  session_id
  workspace
  superseded_by
  deleted_at
```

### 5.7 遗忘与更新

- 静态图片（设计稿、文档、图表）：长 TTL；
- live 截图（GUI/浏览器状态）：短 TTL，默认不跨会话长期复用；
- 用户确认过的事实：高重要性；
- 模型推断：低可信度；
- 新证据覆盖旧证据；
- 重复记录和矛盾记录定期清理；
- 存储容量按 workspace 限制，支持用户清除。

### 5.8 调用元数据（V2）

`meta` 不只描述模型调用，还要描述插件的决策路径：

```text
modelCall            本次是否真的调用了视觉模型
source               model | exact-cache | evidence | soft-memory
matchedEvidenceIds   命中的硬事实（图片哈希级证据）
softMemoryHits       注入的软记忆条数
usage                模型真实 token 用量（仅 modelCall 时存在）
retrievalMs          检索/记忆耗时
```

这样一次调用的成本、命中路径、证据来源都可见，既服务评测，也让用户明白“这次是不是又花钱调了模型”。

用户感知与转述：

- 逻辑层生成 `userNotice` 人话摘要，如“命中 3 条硬事实，注入 2 条软记忆，未调用模型，估算节省约 N tokens”；
- 只在缓存/记忆确实产生收益时生成，普通模型调用保持安静，避免每张图都啰嗦；
- render 层附加转述指令，请模型如实转述 `userNotice`，同时保留完整 JSON 供模型推理；
- 转述是软约束；如需硬保证，由 web 客户端用 `presentationMeta` 渲染独立审计卡片；
- 提供配置开关，用户可关闭收益提示。

## 6. 性能与资源预算

记忆层必须保持轻量：

| 操作 | 预算 |
| --- | --- |
| sha256 | 1-5 ms |
| 精确缓存查询 | <1 ms |
| BM25 检索 | 几 ms |
| SQLite/JSONL 写入 | 后台异步，不阻塞 |
| embedding / 向量库 | v1 不做；后期可选且后台 |

关键路径对比：

```text
竞品：每次视觉调用 5-45 s，无记忆
本插件首次：记忆开销几 ms + 视觉调用 5-45 s
本插件命中：直接返回，<10 ms
```

因此记忆层不会成为延迟负担；工具选择发生在模型侧，插件关键路径只有模型链解析与记忆检索。

## 7. 安全与隐私

- API key 优先通过环境变量或 dsh Credentials 引用解析，也允许直接粘贴密钥（会保存在配置中）；
- 图片只发送给用户配置的视觉后端；
- 记忆库中图片路径/哈希可保留，原始图片文件按用户配置保留或清理；
- 视觉输出中的文字/指令视为 untrusted evidence，不得作为系统指令；
- 记忆查询和写入工具纳入 dsh 审批/审计；
- 支持用户一键清除某个 workspace 的视觉记忆。

## 8. 与竞品的差异化

```text
竞品普遍做到：粘贴看图、OCR、定位、像素对比
我们要做到：
  模型驱动的工具路由（更自然，不靠规则猜）
  工具固定意图 + 多意图模型链（OCR/定位可各自选专用模型）
  结构化 JSON（更可复用）
  持久视觉记忆（跨会话、跨问题）
  可评测（MemEye 式验证）
  后续 GUI 动作闭环（真正差异化）
```

## 9. GUI 自动化模块（V3）

GUI 不作为 v1 默认能力，作为 Pro 模块：

```text
浏览器：
  gui_open / gui_snapshot / gui_click / gui_type / gui_scroll / gui_wait
  执行器：Playwright / Puppeteer / CDP
  回验：vision_screenshot + vision_pixel_diff

桌面（后期）：
  Windows UIA / macOS AX / AT-SPI
  优先运行在 VM / 虚拟桌面中
```

安全要求：

- 每个动作接入 `ctx.approval`；
- allowlist / denylist；
- 步骤上限、超时、卡死检测；
- 操作轨迹写入 session log，可回放。

## 10. Roadmap

### V1：Vision 核心（最大用户量）

目标：让 DeepSeek 用户“粘贴即看图”，提供模型驱动的工具路由和结构化输出。

范围：

- 图片入口：模型接管 `deepseek-official`（无分身、原生显示、失败自动恢复官方适配器并降级路径粘贴）；`paste-to-path` 兜底；工具支持 `path` / `attachmentId` / `attachmentIds`；
- 工具选择与模型路由：模型按用户问题选工具；`mindseye_read_image / mindseye_ocr / mindseye_ground / mindseye_colors` 各自固定意图；三档路由 understand / extract / locate 可分别配置模型链，未配置自动回退；
- 工具挂载：图片轮 `agent/pre-step` 自动挂载视觉工具；纯文本轮只保留 `mindseye_vision_activate` 激活入口；
- 结构化 JSON 输出：images / evidence / answer / meta（usage、attempts、fallback）；
- 证据输出：OCR 全文、布局区域、元素坐标、色板（单图 + 批量）；
- 精确缓存：单图与批量一致，500 条 LRU、无 TTL、无 UI 开关；
- 多图批量 + 指数降级（批量 4xx 半数拆分重试；locate 不支持批量）；
- 真实图片尺寸（PNG/JPEG/WebP/GIF 头部解析）；
- 历史带图会话 sanitizer，回退模式不毒化旧会话；
- 基础设置页：understand/extract/locate 三路由按需添加、Base URL、API Key 脱敏、模型 ID、协议、Max Tokens 常用值；
- 支持 Web profile。

V1 不做：

- 本地像素算法（color / pixel-diff / measure）→ V2；
- 不做 embedding / 向量库 / semantic router；
- 软记忆检索与 evidence 跨问题复用 → V2（Nexus）；
- GUI 自动化 → V3；
- 不引入第三方 MCP server 作为核心依赖。

验收：

- 首次看图延迟与主流竞品持平；
- 同图同问法命中缓存时显著快于竞品；
- OCR/QA/grounding 模型链选择正确、工具调用无必填参数报错；
- 无 Python、无常驻服务、低内存占用。

### V2：持久视觉记忆

目标：把“看过的东西”变成可查询、跨会话、可评测的记忆。

范围：

- SQLite/JSONL 视觉记忆库；
- evidence + analysis 双层存储；
- BM25 软记忆检索；
- 模型驱动工具路由持续演进：新增视觉能力时新增工具并映射模型链，不引入规则分类器；
- 决策元数据：modelCall / source / matchedEvidenceIds / softMemoryHits / usage / 检索耗时；
- userNotice 与模型转述：仅在收益明显时生成，可开关；可选 UI 审计卡片；
- 记忆工具：put / get / search / diff（已暴露为 dsh 工具，调用走审批与审计）；
- 遗忘、TTL、去重、矛盾覆盖：evidence 按容量 LRU 淘汰，软记忆 30 天 TTL；
- MemEye 式评测矩阵：暂缓，代码侧不再提供 routingAccuracy；

验收：

- 新会话能回答“上次这张图的分析”；
- 同一图片不同问题不误用旧答案；
- 软记忆注入有可观测的准确率提升；
- 记忆库体积和延迟在预算内；

### V2.5：图片生成路由

目标：让纯文本模型能委托专用图片生成模型创建可追溯的视觉资产，并把结果作为 dsh 附件交回现有视觉工具链。V2.5 的闭环是“生成 -> 保存 -> 回验 -> 继续对话”，而不是把 `images/generations` 做成一次性的 prompt 转发。

#### 设计边界

- 图片生成是独立能力，不进入 `understand / extract / locate`，也不复用视觉阅读 Provider；两者的协议、响应形态、失败策略不同。
- 第一版只做文本到图像生成，不做 inpainting、outpainting、参考图编辑、工作流编排或浏览器自动化。
- `mindseye_generate_image` 返回附件引用和可审计元数据；assistant 侧 `ImageBlock` 渲染仍是前向兼容项，不能成为调用成功的前提。
- 图片生成默认不做精确缓存。一次生成的意图通常是取得新候选；除非未来显式提供“复用已有 artifact”的参数，否则相同 prompt 也应发起新请求。

#### 工具契约

```text
mindseye_generate_image(prompt, size?, n?)

prompt  必填，描述要生成的画面；最大长度由 schema 限制
size    可选，使用 Provider 支持的画布尺寸；未指定时使用配置默认值
n       可选，候选数，1-4；默认 1，超过上限直接拒绝，不隐式拆分调用
```

工具的内部请求在调用前归一化为 `ImageGenerationSpec`：

```text
prompt
size
n
requestVersion
```

这一步只为审计、测试和未来演进提供稳定边界，不添加未被调用方支持的“通用风格”“负面 prompt”或 seed 参数。Provider 专有参数如有必要，后续通过明确版本化的扩展加入，不能默默透传用户输入。

成功返回：

```text
images[]
  attachmentId
  path
  sha256
  width / height / format

meta
  provider / model
  latencyMs
  attempts[]
  requestVersion
  source = generated
  qa[]                         -- 每张图的回验结果；未请求回验时为空
```

`attachmentId` 是后续 `mindseye_read_image` 的唯一关联方式；本地 `path` 只是兼容性信息，不能要求模型在文本里拼接或读取任意路径。

#### Provider 与路由

新增独立的图片生成配置族，而不是给 `VisionRoute` 增加可选字段：

```text
image.routes[]
  baseUrl
  apiKeyEnv
  model
  defaultSize
```

- 协议为 OpenAI-compatible `POST /images/generations`；第一版支持 Provider 返回 `b64_json` 或下载型 URL。
- 路由按顺序尝试主模型与后备模型。仅 `quota`、`rate-limit`、网络错误和 5xx 可以切换后备；认证错误和无效参数应直接报告，避免掩盖错误配置或花费第二次调用。
- API Key 仍只通过 dsh Credentials、环境变量或插件设置解析；请求、日志、工具结果和 artifact 元数据都不得包含密钥。
- 图片生成调用同样经过 dsh approval 与审计。审批内容应显示候选数、尺寸、目标 Provider 与模型，但不展示完整 API Key。

对于 URL 响应，下载器是一个安全边界：只接受 HTTPS，禁止重定向到内网/回环/链路本地地址，限制响应字节数并校验实际图片 MIME 与 magic bytes。`b64_json` 也必须在解码后执行尺寸、格式和字节上限校验。任何校验失败都不得保存附件。

#### Artifact 与视觉回验

每个成功候选立即由 `ctx.attachments.saveImage()` 保存，计算 SHA-256 与真实尺寸，并记录生成 provenance。保存成功才视为生成成功；Provider 返回的临时 URL 不能直接暴露为长期结果。

默认回验调用现有 `mindseye_read_image(attachmentId, query)`，但回验问题由 ME 根据生成 spec 构造，而不是把整段用户 prompt 机械复述。第一版只检查：

1. 图像是否可读、尺寸与格式是否符合请求；
2. 画面主体是否与 prompt 的核心对象一致；
3. 是否出现用户未要求的可读文字或疑似水印。

回验是质量信号，不会自动修改、裁剪或“擦除”图像。发现不合格候选时，工具应如实返回 QA 结果；调用方可以明确要求重新生成。若 Provider 按其产品政策加入水印，MindsEye 不尝试规避该政策。

对 README header、Logo 或 slogan 等品牌资产，生成模型只负责视觉底图和构图。文字、Logo、字距与对齐必须由确定性的 SVG/排版层完成后，再对最终合成图做一次回验；不得把品牌文字正确拼写的责任交给图片模型。

#### 失败、成本与可观测性

- 每次调用记录真实 provider、model、总延迟、每次 attempt 的错误类别和成功候选数；错误信息不回显密钥或完整 Provider 响应体。
- 单个候选保存或回验失败不丢弃其他已保存候选；返回每张候选的独立状态。
- 生成与回验是两段成本，`meta` 必须分别记录生成调用与视觉 QA 调用的 usage/latency，不能把 QA 成本误算为生成成本。
- V2.5 不把生成结果写入 Nexus 的 OCR/layout 等“图片硬事实”记忆。生成 provenance 作为 artifact 元数据保存；只有用户随后主动分析或确认的事实才进入现有 evidence/analysis 记忆。

#### 验收与测试

- 文本模型会话可以从一次已批准的调用得到可显示、可继续追问的附件；无论 Provider 返回 base64 还是 URL，保存后的结果都使用同一附件契约。
- 主模型失败于可降级错误时，后备模型被调用；认证和参数错误不触发后备调用。
- 所有输出带 provider/model/latency/attempts/request version，并且测试断言 API Key 不出现在输出或日志。
- 覆盖 b64、URL 下载校验、异常响应、候选部分失败、附件保存失败、回验成功/不合格和无水印策略的单元测试。
- 生成路由不进入读取意图分类，且在未配置图片生成路由时提供明确错误，不影响现有 `mindseye_read_image` 工具。

### V3：GUI 自动化与高级检索

目标：形成 vision + action 的完整闭环，并支持高级语义检索。

范围：

- GUI 自动化正式模块：browser 执行器完整化；
- 桌面 GUI：UIA / AX / AT-SPI，VM 优先；
- 可选的图像 embedding 检索（SigLIP/CLIP 或云端 embedding）；
- 跨图片语义记忆；
- 视觉评测与 provider 路由看板；
- 企业级安全：审批、沙箱、审计、按 workspace 隔离。

验收：

- GUI 自动化在 OSWorld / WindowsAgentArena 类基准上有可报告结果；
- 高级检索不进入默认关键路径；
- 记忆层可通过开关关闭，关闭后行为与普通 vision 插件一致；
- 有完整的成本、延迟、准确率可观测面板。

## 11. 风险与开放问题

风险：

- 模型选错工具时，视觉模型会按错误工具的任务 prompt 回答，需要工具描述足够清晰；
- 工具定义常驻会占用模型上下文，靠渐进式暴露和图片轮自动挂载控制；
- 每个工具固定映射到路由族，新增视觉能力时要同步扩展工具集与设置页；
- 软记忆注入可能误导模型，必须标记为参考而非权威；
- 记忆库可能积累过期截图，必须依赖 TTL 和用户控制；
- GUI 自动化的安全边界较难完全保证，必须默认隔离运行；
- dsh 仍处于 developer preview，插件 API 可能变化。

开放问题：

- 记忆库放 workspace 还是 `DSH_HOME`，需兼顾团队协作与隐私；
- 是否默认开启记忆，还是由用户显式开启；
- GUI 模块的免费额度与付费分层。
