# OCR 引擎评估 — 2026-05-26

**目的**：为 `ingestion_pipeline.md` 决策 3"扫描页 → MinerU 解析"找一份实证依据，回答"对我们的合同到底用哪个 OCR"。
**结论**：选 **Gemini 3 Flash Preview**（4 个方案中唯一在我们的 5 个 danger spot 上同时无致命错误的）。接口设计成可替换 Provider。详见下文证据。

---

## 测试样本

`sample_contract/2026002-JSUS2026002-2026海石内陆，石英砂钠长石运费.pdf`

47 页，**全部扫描件无文字层**（fitz 抽不到任何字符），故意挑了最难的一份：

| 页段 | 内容 | 难点 |
|------|------|------|
| p1–4 | 中英双语审批表 | 半结构化表格、双语 key-value、手写签名/印章 |
| p5 | 微信对话截图 | 多张小图缩略图 |
| p6 | 比价表（4 供应商 × 3 物料） | 密集数字 + 价格首位数字 |
| p7–10 | 英文 Trucking Service Agreement | 中等密度英文条款 |
| p11–14 | 同合同签字扫描版 | 手写中文批注、印章 |
| p15–32 | 美国城市运费大表 | 上百行 × 15 列密集数字表，跨页 |
| p33 | 微信截图 | 复杂 UI |
| p45 | Adobe Sign 审计报告 | 数字 PDF 风格扫描 |
| p47 | Outlook 邮件截图 | 中文邮件 |

## 测试方法

每个引擎跑完输出对照原 PDF 渲染图（`_test_2026002_refpng/page_XX.png`，144 DPI），spot-check **5 个关键 danger spot**：

| Spot | 原文 | 为什么挑这个 |
|------|------|-------------|
| p1 审核人日期 | "Jan 14, 2026 23:26:12 EST" | 看 OCR 数字保真度（e-签名时间） |
| p1 项目名 | "2026年度合同—巨石美国..." | em-dash vs 汉字"一"、"巨石"会不会漏字 |
| p4 法务批注关键短语 | "第一季度价格" | 手写中文 + 上下文相关词 |
| p6 Quartz 单价 | 17.98 / 1139.28 美金 | 数字首位 1 容易丢、是法律意义上的关键数 |
| p15 大表 $1,150 / $1,290 | $1,150.00 / $1,290.00 | $ 符号会不会变 5、千分位逗号会不会变句点 |

## 结果

### 横评对照

| Spot | MinerU pipeline | DeepSeek-OCR | Gemini 2.5 Flash | **Gemini 3 Flash** |
|------|-----------------|--------------|-------------------|--------------------|
| p1 审核人日期 | "yong pengng"（混乱） | "Yingjing Ke 2026.05.26"（幻觉日期）| "Jan 8, **2016**" ❌ | "Jan 8, **2026**" ✅ |
| p1 项目名 em-dash | "**一**"（汉字）❌ | "—" ✅ | "——" ✅ | "—" ✅ |
| p1 "巨石美国" | "巨美国"（漏石）❌ | "巨石美国" ✅ | "巨石美国" ✅ | "巨石美国" ✅ |
| p4 关键短语 | "第一季度价格" ✅ | "条款很俗"（乱码）❌ | "**第一年提价格**" ❌ | "**第一季度价格**" ✅ |
| p4 手写人名 | "美艳" | （未捕获） | "孙美艳" | "**彭美艳**" ✅ |
| p6 Quartz 石英砂 | **7.98** ❌ | 进入死循环 ❌ | 17.98 ✅ | 17.98 ✅ |
| p6 Quartz 钠长石 | **139.28** ❌ | 进入死循环 ❌ | 1139.28 ✅ | 1139.28 ✅ |
| p6 Spruce Pine | Spruceine ❌ | Spruce Pine ✅ | Spruce Pine ✅ | Spruce Pine ✅ |
| p15 $ 符号 | **$→5** ❌（$1,150→51,150） | **$→5** ❌ | $ ✅ | $ ✅ |
| p15 千分位 | **逗号→句点** ❌（$1.290） | 句点 ❌ | 逗号 ✅ | 逗号 ✅ |
| p15 列差异化 | 列错位 ❌ | **整列同值**（fill 幻觉）❌ | 列同值**可疑**（Abingdon 全列 $1,190）⚠️ | **列值各不相同** ✅ |

### 性能 & 成本

| 引擎 | 硬件 | 47 页耗时 | 输出 token | 成本 |
|------|------|-----------|------------|------|
| MinerU pipeline | 本地 CPU (i5-1145G7) | 19 min | — | ~0（电费） |
| DeepSeek-OCR (Gundam mode) | Colab T4 GPU | **>1 小时（中断）** | — | Colab 免费档时间 |
| Gemini 2.5 Flash | Vertex AI us-central1 | 5 min（5 路并发）| 254,208 | $0.6575 实测 |
| Gemini 3 Flash Preview | Vertex AI | 4 页 109s（外推 ~20 min） | p15 单页 21k（2.5 是 40k）| 未实测，估 ~$0.30–0.50 |

---

## 各引擎主要失败模式

### MinerU pipeline（开源 CV 流水线）
- **数字首位丢失**：`17.98 → 7.98`、`1139.28 → 139.28`、`$1,150 → 51,150`
- 经典 OCR 字符级错误：rn→m、$→5、, → .
- 中文偶尔漏字（"巨石美国" → "巨美国" 反复发生）
- 表格 cell 检测对密集表不稳，state 列大面积丢失
- **优点**：本地 0 成本、隐私可控、文字保真度对中等密度页面够用、`middle.json` 里有 span-level score 可以做 confidence 闸

### DeepSeek-OCR（开源专用 VLM，~3B）
- **重复死循环**：复杂页生成时撞 8192 token 上限，进入 "RoOms RoOms RoOms..." loop
- **列填充幻觉**：大表里"不知道填什么就把上一个值复制到所有 cell"——错得"看起来很整齐"，**比 MinerU 危险**
- p33（微信截图）退化成 "1. 1. 1. 1. 2. 2."
- 同样存在 $→5
- **优点**：英文条款页比 MinerU 干净得多；简单结构化页（Focus Freight / VanMile 表）很稳；输出带 bbox 可以做 grounding

### Gemini 2.5 Flash
- **fill-down 偷懒**：列同值时所有列填同一个值（p15 Abingdon 那行 $1,190 复制了 6 列）——可疑但难以分辨真假
- 偶尔语义性幻觉：把"第一季度价格"读成"第一年提价格"（**MinerU 反而对了这个，因为它只看像素不试图理解**）
- 日期年份偶错（"Jan 8, 2026" → "Jan 8, 2016"）
- **优点**：数字字段保真度高、$ 符号稳、千分位稳、English clean、表格结构清晰

### Gemini 3 Flash Preview
- 5 个 danger spot 全部命中
- 列差异化正确（不再 fill-down）
- 输出比 2.5 Flash 紧凑 ~50%
- **唯一保留风险**：preview 模型，API/价格可能变；走 GCP 不解决跨境数据问题

---

## 关键 lessons

1. **scanned-page OCR 是研究问题**——OpenAI/Google 整个团队都没做到 100%，单人短期不会突破。**任何工程上限定的 SLA（"准确率 ≥ 99%"）都是吹的**

2. **失败模式分两类**，下游兜底策略不同：
   - **像素级错误**（MinerU 把"17.98"读成"7.98"）：错得明显，正则 + 字段格式校验能 catch
   - **语义性幻觉**（Gemini 把"第一季度"改成"第一年"）：错得"合理"，**只能人工 review 或多 OCR 共识 catch**

3. **fill-down 是 VLM 大表通病**（DeepSeek 严重、Gemini 2.5 轻度、Gemini 3 修复）。检测方法：列内重复值率 > 阈值时 flag，让人工 review。

4. **VLM 比传统 OCR 在表格语义上强**，但**在密集数字上风险更大**——它会"理解"成"该列应该填这个"

5. **本地 CPU 不要试图跑 3B 级 VLM**（i5-1145G7 上 DeepSeek-OCR 估 >8 小时；MXFP4 量化不解决 CPU 算力问题）

6. **GGUF 多模态支持还不成熟**（NexaAI 有 fork 但生态封闭），llama.cpp 主线对 DeepSeek-OCR 这种自定义视觉架构暂未支持

---

## 决策

| 角色 | 选择 |
|------|------|
| **MVP / 简历 demo** | **Gemini 3 Flash Preview** via Vertex AI |
| 接口设计 | `OCRProvider` 抽象类，`GeminiOCRProvider` 是 V1 唯一实现 |
| 备选方案文档化 | 把今天 4 个引擎的对照写进 README "Technical Exploration" 章节 |
| V2（真上线，合规敏感） | 改 `OCRProvider` 实现：本地 PaddleOCR + LLM 后处理 / 或自托管 DeepSeek-OCR + 强后处理 |

**关键设计原则**：不要 hard-code `gemini-3-flash-preview` 到 chunking 逻辑里。OCR 是个独立责任，今天选 Gemini，明天合规要求换成本地——只改 Provider，不改下游。

## 关键字段保护（任何 OCR 实现都要做）

考虑到今天看到的 5 类失败模式，下游 chunking 之前对**关键字段**做格式校验：

| 字段 | 正则 | 失败动作 |
|------|------|---------|
| 合同号 | `^[A-Z]{2,8}\d{7}$` 或 `^CN[A-Z]+\d+$` | 标 low_confidence，前端字段级红框 |
| 金额 | `^\$[\d,]+\.\d{2}$` | 同上 |
| 日期 | `^\d{4}[-/]\d{1,2}[-/]\d{1,2}$` | 同上 |
| 邮箱 | 标准邮箱 regex | 同上 |
| 单价 | `\d+\.\d{2}\s*(美金|美元|USD)` | 同上 |

**fill-down 检测**：如果某行多列出现完全相同的数字值，且这些列 header 是不同实体，标 `column_fill_suspect=true`，前端提示重点核对。

## 留档文件

实验代码 + 输出全部保留：

```
_test_2026002_mineru.log                     MinerU pipeline run log
_test_2026002_out/                           MinerU markdown + content_list.json + images
_test_2026002_gemini.py                      Gemini 2.5 Flash 47-page 脚本
_test_2026002_gemini_out/                    Gemini 2.5 输出 + cost.json
_test_2026002_gemini3.py                     Gemini 3 Flash 4-page 脚本
_test_2026002_gemini3_out/                   Gemini 3 输出 + summary.json
_test_2026002_refpng/                        47 页 PDF 渲染图（ground truth 对照用）
deepseek_ocr_colab.ipynb                     DeepSeek-OCR Colab notebook
```

简历复盘时这些数字 + 例子可以直接用进 README。

## 关联文档

- 上游策略：[[ingestion_pipeline.md]] 决策 3（扫描 vs 数字判别）、决策 6（OCR 置信度质量闸）
- 解析方案：[[pdf_parsing.md]]——**今天结论修正了那里"Gemini Vision = gemini-2.5-flash"的措辞，应该是"Gemini 3 Flash Preview，2.5 作为 fallback"**
