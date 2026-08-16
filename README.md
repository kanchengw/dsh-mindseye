# MindsEye

> 让 DeepSeek 原生看图 —— intent-routed vision for DeepSeek Harness

MindsEye 是一个 DeepSeek Harness（dsh）vision 插件。粘贴图片后，图片原样显示在会话里，DeepSeek 继续负责思考，视觉模型负责看图。插件根据问题自动路由到合适的视觉能力，返回结构化 JSON（含真实 token 用量），并通过缓存与多图批量减少重复开销。

## 核心体验

- **粘贴即看图**：接管 `deepseek-official` 路由，图片原生进入会话；接管不可用时自动降级为路径粘贴，新图始终能发出去
- **模型有建议权，规则有仲裁权**：模型可给出意图建议，内置规则在置信度高时纠正，模糊时尊重模型
- **多图一次读**：批量读取多张图片，批量遇 4xx 按指数拆分降级，失败只影响单张
- **旧会话不毒化**：历史带图会话在回退模式下也能正常对话，图片块自动替换为附件标记
- **每次调用透明**：返回 provider、model、延迟、token usage、fallback 标记，成本可审计

## 已实现功能

### 图片入口

- 原生粘贴/拖拽（接管模式，模型选择器无分身）
- `paste-to-path` 兜底：文本模型场景下自动把粘贴转为路径文本
- `mindseye_read_image` 支持本地路径、单张附件 id、批量附件 id

### 路由与输出

- 三档路由：`understand`（通用理解）、`extract`（OCR/文字提取）、`locate`（像素定位）
- 意图仲裁：模型可建议三档意图，内部规则细分 OCR、视觉问答、定位、布局、图表、颜色、像素差异等，规则置信度 ≥ 0.8 时优先
- 结构化 JSON：`images` / `evidence` / `answer` / `meta`，`meta` 含真实 token usage、调用尝试与回退标记
- 精确缓存：图片 sha256 + 归一化问题 + region + baseUrl + model + prompt 版本，命中时不再调用视觉模型

### Provider

- OpenAI-compatible Chat Completions 与 Responses 协议
- 多路由 fallback 链，失败自动切换
- 多图批量调用 + 指数降级（批量 4xx 按半数拆分重试，`locate` 不支持批量）

### dsh Web 设置卡

- `understand / extract / locate` 三条路由，按需添加，未配置自动回退默认模型
- Base URL、API Key（脱敏 + 眼睛切换）、模型 ID、协议（显式选择）、Max Tokens 常用值下拉
- 模型接管默认开启：修改后重启生效，启动失败自动恢复官方适配器并降级为路径粘贴

## 安装

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-mindseye
```

重启 dsh web 即可原生粘贴图片。“模型接管”默认开启，可在 Settings → Plugins → MindsEye 中调整。

首次使用请在 MindsEye 设置卡中配置一个通用视觉模型（Base URL、API Key、模型 ID）；未配置的 OCR / 定位路由会自动回退到通用模型。

## 开发

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
```
