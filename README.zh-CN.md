# MindsEye

![MindsEye header](assets/MindsEye-header.png)

[![dsh.so security](https://www.dsh.so/badges/dsh-mindseye.svg)](https://www.dsh.so/artifact/dsh-mindseye/)

> 让 DeepSeek 原生看图 —— model-driven vision tools for DeepSeek Harness

[English](README.md) | [中文](README.zh-CN.md)

当前版本：0.2.6

MindsEye 是一个 DeepSeek Harness（dsh）vision 插件。粘贴图片后，图片原样显示在会话里，DeepSeek 继续负责思考，视觉模型负责看图。插件暴露一组按任务拆分的视觉工具，由模型根据用户意图选择工具，每个工具固定映射到对应的意图和模型路由，返回结构化 JSON，并通过缓存与证据复用减少重复开销。

## 核心体验

- **粘贴即看图**：图片以 dsh 原生附件进入会话；DeepSeek 原生多模态模型完整直收，纯文本 DeepSeek 模型保持同一个选择器条目并通过 MindsEye 适配器桥接
- **模型选意图，插件管路由**：`mindseye_read_image` 用 `intent` 选任务（visual-qa / ocr / layout / chart / color / pixel-diff / general），可加 `extract` 一次拿多种结构化证据；`mindseye_ground` 单独负责坐标定位
- **生图即所见**：`mindseye_generate_image` 委托专用图片生成模型，结果作为 dsh 附件直接显示在会话中，不自动保存、不自动回验
- **图片轮自动挂载**：检测到图片消息时自动注册视觉工具；纯文本轮默认只保留一个激活入口，避免常驻占用模型上下文
- **可视浏览器接管**：浏览器自动化会打开独立的可见 Chrome/Edge agent 窗口；`auto` 优先跟随受支持的系统默认浏览器，其他浏览器回退到已安装的 Chrome/Edge
- **多图一次读**：批量读取多张图片，批量遇 4xx 按指数拆分降级，失败只影响单张
- **历史按路由处理**：多模态路由完整保留图片块；文本路由只在请求边界接收附件标记，不改写持久会话表面
- **每次调用透明**：返回 provider、model、延迟、token usage、fallback 标记，成本可审计

## 浏览器自动化

启用后，MindsEye 会打开独立的可见 Chrome/Edge 浏览器会话，执行打开页面、截图、点击、输入、按键和滚动。遇到验证码、登录或权限确认时，任务会暂停在 dsh 原生提问卡片上，用户可以接管浏览器，完成后继续，或放弃任务。插件不会接管用户现有的浏览器 profile。

![交互](assets/ScreenShot_interaction.png)


## 已实现功能

### 图片入口

- 通过 dsh 原生粘贴/拖放，不增加 provider 或模型分身
- `paste-to-path` 仅在适配器桥接不可用且当前模型确认是纯文本时兜底
- `mindseye_read_image` 通用看图，支持本地路径、单张附件 id、批量附件 id

### 工具与路由

| 工具 | 意图 | 路由 | 批量 |
| --- | --- | --- | --- |
| `mindseye_read_image` | 通用视觉问答 + `intent` 专项（ocr / layout / chart / color / pixel-diff / general），可选 `extract` 一次多证据 | understand / extract | 支持 |
| `mindseye_ground` | 目标像素坐标定位 | locate | 不支持 |

- `understand / extract / locate` 三档模型路由可分别配置，未配置时自动回退到通用理解模型
- 图片轮自动挂载视觉工具；纯文本轮只保留 `mindseye_vision_activate` 作为激活入口，工具不会常驻挤占模型上下文
- 结构化 JSON：`images` / `evidence` / `answer` / `meta`，`meta` 含真实 token usage、调用尝试与回退标记
- 精确缓存：图片 sha256 + 归一化问题 + region + baseUrl + model + prompt 版本，命中时不再调用视觉模型

### 图片生成

- `mindseye_generate_image(intentId)`：文生图，走 `image.generate`
- `mindseye_edit_image(intentId, attachmentId)`：图生图，走 `image.edit`，把参考图原图交给生图模型
- 生成结果作为 dsh 附件直接显示在会话中，附带 `(token_usage=..., 宽x高, 大小)` 审计行


### Provider

- OpenAI-compatible Chat Completions 与 Responses 协议
- `vision.fallbacks` 是识别链路的备用模型列表；图片生成和编辑分别使用有序的 `image.generate` / `image.edit` 链路
- 生图路由支持配置 `endpoint`、`bodyMode`（`json` / `multipart`）、`imageField`，适配不同 provider
- 多图批量调用 + 指数降级（批量 4xx 按半数拆分重试，`locate` 不支持批量）

### 记忆

- 图片级硬事实按 sha256 持久化，evidence 按容量 LRU 淘汰（默认 1000 条）
- 软记忆 BM25 检索历史问答注入上下文，历史问答按容量滚动淘汰（默认 1000 条）
- `mindseye_memory_put / get / search / diff` 四个 dsh 工具，调用在会话中可见，并记录审计

### 数据处理与安全边界

- **原生附件优先**：支持图片输入的模型保留 dsh 原生附件；MindsEye 通过附件 ID 关联图片，不要求用户手动选择本地文件。
- **自动临时路径降级**：适配器桥接不可用且当前模型确认是纯文本时，`paste-to-path` 会校验用户刚粘贴或拖放的 PNG、JPEG、WebP 或 GIF（单张最多 25 MiB），保存到独立的系统临时目录并自动返回分配的路径。临时文件以 `0600` mode 创建，用户无需手动提供路径。
- **外部视觉调用**：只有执行任一 MindsEye 视觉工具并调用用户配置的视觉 Provider 时，图片字节与问题内容才会发送到该 Provider 的 Base URL。用户应仅配置自己信任的服务。
- **凭据与缓存**：API Key 从环境变量、dsh Credentials 或插件设置解析，并仅以 Bearer 认证发送给对应 Provider。精确缓存只保存在当前 dsh 进程内存，最多 500 条；它不写入持久化数据库，并会在进程退出时清空。
- **执行边界**：插件不启动 shell，也不执行下载后的代码。用户明确启用浏览器自动化后，插件可能启动本地 Chrome/Edge 子进程；浏览器使用独立会话，不接管用户已有的个人 profile。正常 Web 粘贴降级只读取插件刚为该次粘贴生成的临时图片；工具接口也支持 dsh 附件 ID。

### dsh Web 设置卡

- `understand / extract / locate` 三条路由，按需添加，未配置自动回退默认模型
- Base URL、API Key（脱敏 + 眼睛切换）、模型 ID、协议（显式选择）、Max Tokens 常用值下拉
- DeepSeek 桥接在原 `deepseek-official` 路由上原位装饰：选择器仍只有一个 provider 和一份模型；原生视觉模型不改写，纯文本请求只在 adapter 边界净化

## 安装

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-mindseye
```

安装后重启 dsh web。适配器桥接默认自动启用且不提供用户开关；桥接失败时恢复官方适配器并启用路径兜底。

首次使用请在 MindsEye 设置卡中配置一个通用视觉模型（Base URL、API Key、模型 ID）；未配置的 OCR / 定位路由会自动回退到通用模型。

## 开发

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
```
