# 数字 PDF 解析方案评估 — 2026-05-28

**目的**：解决 [`ingestion_pipeline.md`](ingestion_pipeline.md)（写"数字页→MinerU"）和 [`pdf_parsing.md`](pdf_parsing.md)（写"unstructured + pdfplumber"）两份文档的方案打架问题，在真实数字合同上实测拍板。
**结论**：数字页用 **MinerU pipeline (txt 方法 + ch 语言)**。可选用 pdfplumber 做表格二次精修，但 V1 不需要。**unstructured (hi_res) 在中文合同上不可用**——大段中文乱码。

---

## 测试样本

`sample_contract/2026004-JSUS2026006-2026-2028 水处理合同（价格框架协议）.pdf`

通过 `_probe_digital_pages.py`（fitz 元数据按页判图片覆盖率 + 文字层字符数）筛出来的**唯一一份"几乎全数字"的样本**：10 页里 9 页判 digital + 1 页 mixed。10 份合同里这是唯一可用的数字 PDF 样本——其他要么全扫描、要么混合（财务审计 2 数字 + 11 扫描，已印证"按页混合"设计假设）。

内容结构：
| 页 | 内容 | 难点 |
|---|---|---|
| p1 | 中英双语审批表（合并单元格） | 复杂 rowspan/colspan + 中文长段说明 + e-签名 |
| **p2** | **14 行 × 10 列价格对比表**（ChemAqua 2024 vs 2026 vs Veolia） | **密集中英混合数字表，最关键的页** |
| p3 | Chem-Aqua 提案封面 | 公司 logo + 联系信息 |
| p4 | 提案说明信 | 纯英文叙述 |
| p5 | Chem-Aqua 合同正文（14 行 × 6 列价格表 + 签字） | 表格 + 签字行 |
| p6–7 | Veolia 反报价 + Terms & Conditions p1 | 多列布局 + 长段法律条款 |
| p8–9 | 19 条 Terms & Conditions | 密集编号条款（合同主体） |
| p10 | 末页 | 短文本 + 装饰图 |

## 测试方法

跑两个方案 + pdfplumber 单独跑表格，对照 144 DPI 渲染图（`_test_2026004_refpng/`）spot-check：

| 引擎 | 调用 | 备注 |
|---|---|---|
| **MinerU** | `mineru -p ... -o ... -m txt -b pipeline -l ch` | digital PDF 用 txt 方法，ch 语言 |
| **unstructured** | `partition_pdf(strategy="hi_res", infer_table_structure=True, languages=["chi_sim", "eng"])` | hi_res 用 Detectron2 版面模型 |
| pdfplumber | `page.find_tables() + table.extract()` | 仅表格 |

## 结果

### Danger Spot 横评

| Spot | MinerU | unstructured (hi_res) | pdfplumber |
|---|---|---|---|
| **p1 中文 Brief Description**（长段中文说明，~600 字） | ✅ 完整保留 | ❌ **大段乱码**（"ChemAqua7kiha (ts ante ia)" / "ZAAAKIERAR, HRMS"） | ✅ 完整（在表格 cell 里） |
| **p1 审批表合并单元格** | ✅ rowspan/colspan HTML 准确 | ⚠️ 结构错位（Petitioner / Seller's Party / Contract Amount / Project Name 挤进一个 rowspan="4" 的 cell） | ✅ 14r × 16c 全量保留 |
| **p2 价格表 14 行 × 10 列**（**最关键的页**） | ✅ 全部数字命中（$3.01 / $6,682.20 / 5% / $355.20 / $5.84 / $12,964.80 / ...） | ❌ **约 80% 单元格丢失**（前 4 行除最后列外几乎全空） | ✅ **完美**——数字、$ 符号、千分位、负号、百分比、"未报价"全保留 |
| p2 中文"未报价" | ✅ "未报价" | ❌ "FRR" / "FRY" / "FRAT" / "ART"（乱码） | ✅ "未报价" |
| p2 合计行 $46,424.09 → $49,221.35 → 6% → $2,797.26 → $61,439.19 | ✅ 全对 | ⚠️ 部分对 | ✅ 全对 |
| p5 Chem-Aqua 价格表 $ 符号 | ✅ `$ 3.17` | ⚠️ `S$ 3.17` / `S 3.17`（$→S OCR 错） | ✅ `$ 3.17` |
| p6 Veolia 表（PRODUCT / CONTAINER 等列） | ✅ 表头 + 数据准确 | ⚠️ 表头部分误读 `PRODUCT` 重复出现 | ❌ **列错位**（按字母笔画切列，"Solus AP25" → "Solus A P25"） |
| p7–9 T&C 19 条编号条款 | ✅ 全部 19 条编号 + 内容完整 | ⚠️ ListItem 切碎但内容保留 | n/a |
| 章节标题层级（# / ##） | ✅ MinerU `text_level=1/2/3` 区分 H1/H2/H3 | ⚠️ Title 类型识别一半，没有层级 | n/a |
| **页眉页脚 dedup**（"CHINA JUSHI USA"、地址行重复 N 页） | ✅ **自动分类成 `type=header/footer`**（8 headers + 7 footers） | ❌ 没有该字段，混在 Text 里 | n/a |

### MinerU `content_list.json` 结构（直接消费的真值）

10 页 → 131 个 element：

| type | count | 用途 |
|---|---|---|
| text | 106 | 普通段落，含 `text_level` 字段标识 H1-H3 |
| table | 6 | HTML 表格（带 rowspan/colspan）+ 备份 png img_path |
| **header** | **8** | **页眉，下游直接 filter 掉，省了我们做 dedup** |
| **footer** | **7** | **页脚，同上** |
| image | 3 | 图片（带 img_path） |
| aside_text | 1 | 边栏 |

每个 element 都有 `bbox` + `page_idx` → 前端 click-to-source 高亮直接拿来用。

### 性能 & 成本

| 引擎 | 耗时（10 页） | 输出大小 | 成本 |
|---|---|---|---|
| MinerU pipeline + txt + ch | ~4 min（CPU i5-1145G7） | md 60KB + content_list 85KB + middle 1.1MB（含 bbox） | ~0（电费） |
| unstructured hi_res | ~4 min（含一次模型下载） | md 54KB + elements.json 74KB | ~0 |
| pdfplumber | 4.7 s | tables.json 15KB | ~0 |

---

## 各引擎主要失败模式

### MinerU pipeline (txt mode)
- 签字图被公式解析器误识别（`$Z H E N G \sim \Delta N G$` 出现在第 1 页审批表的总裁签字位置）
- Logo OCR 成文本（`# OVEOLA` = VEOLIA 公司 logo）
- 偶发字符级错字：`Sellr's Party`（应为 `Seller's`，原 PDF 也可能就这么写）、`Filig Aadvise`、`JsUS2026004`（应为 JSUS）
- 表头偶发缺空格：`OrderQuantitydrums` 应是 `Order Quantity drums`
- **优点**：中文 100% 保真、价格表 100% 保真、自动 header/footer 分类、`text_level` 标题层级、bbox 完整、content_list.json 即用即取

### unstructured (hi_res with Detectron2 layout)
- **致命：中文乱码**——p1 Brief Description 整段约 600 字中文输出为不可读乱码（`ChemAqua7kiha (ts ante ia)` / `ZAAAKIERAR` 等）；p2 表格"未报价"输出成 `FRR/FRY/FRAT/ART`
- **致命：密集表大面积丢 cell**——p2 关键价格表前 4 行除最后列外几乎全空
- `$` → `S` 字符级错（p5 Chem-Aqua 表）
- Title/Text 二分粒度，没有 H1/H2/H3 层级
- 没有 header/footer 类型识别
- **优点**：无（在我们这场景）

### pdfplumber.find_tables()
- **表格内容保真度极高**（数字、$、千分位、中文全对）
- **但仅做表格**——没有标题、没有段落、没有 reading order
- **复杂表格列错位**：p6 Veolia 表"Solus AP25" 被切成 "Solus A P25"，因为它按字符垂直对齐推断列边界
- **优点**：表格内容真值，可用于关键表格的"第二意见"

---

## 关键 lessons

1. **MinerU 在数字 PDF 上是主场**——和扫描页评估那波（MinerU 在扫描件上输给 Gemini）形成对照。**不能因为扫描页 MinerU 输了就否定它在数字 PDF 上的能力**。

2. **unstructured hi_res 在中文 PDF 上不可用**——Detectron2 版面模型 + 默认 OCR 后处理对中文支持差。装了 `chi_sim` 语言包也没救。**不要再为它花时间**。

3. **MinerU 的 `content_list.json` 比 markdown 文件更有用**——下游 chunking 应该读 JSON，不应该重新 parse markdown。`type=header/footer` 自动给了我们之前担心要自己做的"页眉页脚 dedup"。

4. **pdfplumber 是表格"第二意见"工具**，不是主解析方案。复杂版面（多列、awkward 间距）下表格识别会错位。简单 grid 表上是金标准。

5. **签字图 / logo 这种 OCR-as-text 失误是 MinerU 通病**——但定位明确（公式区域 + 装饰图区域），下游可以靠"text_level=None + 短文本 + bbox 在签字区"启发式过滤。

---

## 决策

| 角色 | 选择 |
|---|---|
| **数字页主解析** | **MinerU pipeline（`-m txt -b pipeline -l ch`）** |
| **下游消费格式** | **直接读 `content_list.json`**，不要重新 parse `.md` |
| **页眉页脚 dedup** | **用 MinerU 的 `type==header/footer` 直接 filter**，不再实现自己的 |
| **章节切分** | **用 `text_level` 字段切**（1=H1, 2=H2, 3=H3） |
| **表格** | V1：直接用 MinerU 输出的 HTML table；V2：如发现关键表格精度问题，加 pdfplumber 二次精修 |
| **签字图误识别** | V1 接受；V2 加"text_level=None + bbox 在底部 + 包含特殊符号"启发式过滤 |
| **不要做的** | unstructured（中文不可用）；PyPDFLoader baseline（已知会丢表 + 不尊重结构） |

**关键设计原则**：MinerU 不是黑盒——`content_list.json` 是清晰的结构化中间格式。下游 chunking 模块对接这个 schema，不对接具体引擎。**未来换 MinerU 也只换适配器**。

## 留档文件

```
_test_2026004_refpng/                                   10 页 144 DPI 渲染图（ground truth 对照）
_test_2026004_mineru/                                   MinerU 输出（md / content_list / middle / layout pdf）
_test_2026004_mineru.log                                MinerU run log
_test_2026004_unstructured/                             unstructured + pdfplumber 输出
_test_2026004_unstructured.py                           unstructured + pdfplumber runner
_test_2026004_unstructured.log                          run log
_probe_digital_pages.py                                 fitz 元数据按页判数字/扫描的探针脚本
_render_2026004_refpng.py                               PNG 渲染脚本
```

## 关联文档

- [`ingestion_pipeline.md`](ingestion_pipeline.md) 决策 3 + 流程图：数字页路径已实测 → MinerU
- [`pdf_parsing.md`](pdf_parsing.md) 数字 PDF 章节：**已修正**——原写"unstructured + pdfplumber"，改为"MinerU 主，pdfplumber 二次精修可选"
- [`ocr_evaluation.md`](ocr_evaluation.md) 扫描页路径：Gemini 3 Flash（数字页 MinerU 之外的另一条路）
- `_probe_digital_pages.py` 输出验证了"按页路由"假设（财务审计 2 数字 + 11 扫描混合页样本真实存在）
