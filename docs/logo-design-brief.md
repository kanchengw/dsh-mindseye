# MindsEye Logo 设计方案

> 状态：**几何版 8/8 已生成**；卡通版未生成（用户中止）
> 日期：2026-08-16（按设计文档修订）
> 用途：为 MindsEye（dsh vision 插件）设计两版各 8 个 logo 候选

## 品牌基准（从现有品牌资产提取）

| 维度 | 取值 |
| --- | --- |
| 产品名 | MindsEye（"让 DeepSeek 原生看图"） |
| 模块体系 | MindsEye / Fovea（视觉引擎）/ Nexus（视觉记忆）/ Effector（GUI） |
| 核心隐喻 | 眼睛（视觉）× 神经网络节点（连接/记忆 Nexus）× 像素（结构化证据） |
| 主背景 | 深海军蓝 `#080d26` |
| 主文字 | 白 `#ffffff` |
| 强调色 | 电光青 `#00d4ff`、淡紫 `#8a4fff` |
| Slogan | Vision that Remembers. |

设计原则（依据 docs/design.md §V2.5）：

- 图片生成只负责视觉底图与构图；**文字/字距/对齐必须由确定性 SVG/排版层完成**，所以生成 prompt 一律要求"无文字、纯符号"；
- 16 个候选共享同一套品牌色与"眼睛 × 网络"语义，保证两版风格统一可对比；
- 每张图生成后自动回验：可读性、主体一致性、无多余文字/水印。

## 一、几何风格（8 个）— Geometric

统一约束：flat vector、几何硬边、深蓝背景、青/紫渐变发光、居中、no text。

| # | 名称 | 设计概念 |
| --- | --- | --- |
| G1 | Low-Poly Eye 低多边形之眼 | 三角面切割的眼睛，顶点处白色连线如神经网络，青紫渐变面 |
| G2 | Lens Rings 同心透镜 | 纯圆环与圆弧构成的眼睛，虹膜为渐变环，瞳孔实心，极简 |
| G3 | Hex Retina 蜂巢视网膜 | 六边形蜂窝拼出眼睛轮廓，蜂窝=视网膜感光细胞隐喻 |
| G4 | Constellation Eye 星座节点眼 | 圆点+直线构成的星座式眼睛，最接近现有 header 的网络眼语言 |
| G5 | Third Eye Prism 第三只眼 | 金字塔三角+中心圆，神秘几何，适合"洞察/感知" |
| G6 | Pixel Grid Eye 像素网格眼 | 像素方块拼成的眼睛，呼应结构化证据/像素分析（Fovea） |
| G7 | Facet Gem Eye 多面宝石眼 | 宝石切割面构成的眼睛，棱面反射青紫光，高端科技感 |
| G8 | Reticle Focus 准星聚焦 | 圆+十字准星与极简眼形融合，扫描/定位（grounding）语义 |

## 二、卡通风格（8 个）— Cartoon

统一约束：圆润扁平卡通、深蓝背景、青/紫点缀、居中、no text。

| # | 名称 | 设计概念 |
| --- | --- | --- |
| C1 | Glossy Mascot Eye 大眼吉祥物 | 圆润大眼睛角色+迷你微笑，水汪汪高光，亲和力 |
| C2 | Kawaii Eyeball 呆萌眼球 | 经典卡哇伊眼球，高光+腮红，极简圆角 |
| C3 | Lens Bot 镜头机器人 | 相机镜头眼的呆萌机器人/猫头鹰，科技+可爱 |
| C4 | Doodle Eye 涂鸦手绘眼 | 手绘线条风，带小星星/省略号，轻松感 |
| C5 | Vision Sprite 视觉精灵 | 手持放大镜的小精灵，镜片即眼睛，探索语义 |
| C6 | Jelly Eye 软糖果冻眼 | 果冻质感圆团+眼睛，Q 弹光泽，记忆"软糖"意象 |
| C7 | Cool Shades 酷墨镜 | 反光墨镜+像素瞳孔倒影，酷感时尚 |
| C8 | Starry Sparkle Eye 星星眼 | 漫画风闪亮大眼睛，眼中有星星/数据点，惊喜感 |

## 生成执行记录

### 已生成（几何版，8/8）✅

Provider：`ark.cn-beijing.volces.com` / `doubao-seedream-5-0-260128`，尺寸 2048x2048 JPEG，均已回验（qwen3.6-flash）。

| # | 文件 | 附件 sha256（前缀） | 回验 |
| --- | --- | --- | --- |
| G1 | `assets/logos/geometric/G1-low-poly-eye.jpeg` | aa73cd50 | 主体一致；右下角有 "AI生成" 水印 |
| G2 | `assets/logos/geometric/G2-lens-rings.jpeg` | 2a44afec | 主体一致；右下角有 "AI生成" 水印 |
| G3 | `assets/logos/geometric/G3-hex-retina.jpeg` | 155ae355 | 主体一致；右下角有 "AI生成" 水印 |
| G4 | `assets/logos/geometric/G4-constellation-eye.jpeg` | 4567aa06 | 主体一致；右下角有 "AI生成" 水印 |
| G5 | `assets/logos/geometric/G5-third-eye-prism.jpeg` | 5cf12f4c | 主体一致；右下角有 "AI生成" 水印 |
| G6 | `assets/logos/geometric/G6-pixel-grid-eye.jpeg` | 4e4b606f | 主体一致；右下角有 "AI生成" 水印 |
| G7 | `assets/logos/geometric/G7-facet-gem-eye.jpeg` | 05d33848 | 主体一致；右下角有 "AI生成" 水印 |
| G8 | `assets/logos/geometric/G8-reticle-focus.jpeg` | cfdb0198 | 主体一致；右下角有 "AI生成" 水印 |

水印说明：按 docs/design.md §V2.5「若 Provider 按其产品政策加入水印，MindsEye 不尝试规避该政策」。该水印为火山引擎 doubao-seedream 产品政策水印，如需正式发布，应使用确定性 SVG 排版层重绘图形并叠加字标（MindsEye wordmark）。

### 未生成（卡通版 0/8）

用户在中止调用时明确「就先要这些 不用继续调用了」。卡通版 8 个概念（C1-C8）保留在本文档第二节，后续需要可随时按同一模式生成。

## 生成执行清单

- [x] 恢复审批策略为 `ask`
- [x] 8 个几何 logo 生成 + 回验（请求 1024x1024 → 实际 2048x2048）
- [ ] 8 个卡通 logo 生成（已中止）
- [x] 逐张回验：主体一致 ✅ / 无多余文字 ❌（Provider 政策水印）
- [x] 落盘到 `assets/logos/geometric/`
- [ ] 产出《logo 交付说明》+ 与现有 header 的对比（待用户确认风格后）
