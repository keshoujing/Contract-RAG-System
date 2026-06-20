# PDF 解析方案

## 全文字 PDF（数字 PDF）

V1 方案：**MinerU pipeline（`-m txt -b pipeline -l ch`）**，下游消费 `content_list.json`（不是 `.md`）。

> 2026-05-28 在 2026004 水处理合同（9 数字页）上对照 MinerU / unstructured (hi_res) / pdfplumber，**MinerU 是唯一在中文长段 + 密集价格表 + 标题层级 + 页眉页脚 dedup 上全部命中的方案**。详见 [`digital_parsing_evaluation.md`](digital_parsing_evaluation.md)。

**MinerU 给的关键能力**：
- `text_level=1/2/3` → 标题层级，下游按这个切章节
- `type=header/footer` → 自动识别页眉页脚，下游 filter 掉即可（**不用我们自己做 dedup**）
- `type=table` → HTML 表格（带 rowspan/colspan）+ 备份 png img_path
- 每个 element 带 `bbox` + `page_idx` → 前端 click-to-source 高亮直接用

**已知失败模式**（V1 接受）：
- 签字图被公式解析器误识别（`$Z H E N G \sim \Delta N G$` 这种）
- Logo / 装饰图 OCR 成文本（`# OVEOLA` = VEOLIA 公司 logo）
- 偶发字符级错字（`Filig Aadvise` / `JsUS2026004`）

**已否决方案**：
- `unstructured (hi_res)`：中文整段乱码（"ChemAqua7kiha (ts ante ia)"）+ 密集表 80% cell 丢失。**不要再用**。
- `PyPDFLoader baseline`：会把表格打平、不尊重合同结构、`RecursiveCharacterTextSplitter` 会把条款切两半。

**可选 V2 增强**：
- 关键表格用 `pdfplumber.find_tables()` 做"第二意见"——简单 grid 表上 pdfplumber 是金标准（p2 价格对比表 100% 准确）。但复杂版面会列错位（按字符垂直对齐推断列边界），所以是补充不是替代。

---

## 扫描件 PDF（全图片）

`PyPDFLoader` 无法提取任何文字。两条路：

**方案 A：Gemini Vision 逐页识别**（V1 选择）
将每页转为图片，发给 **`gemini-3-flash-preview`** 提取文字和表格，再走和数字 PDF 一样的分块流程。无需本地 GPU，利用现有 Vertex AI 配置。

> 2026-05-26 实测：在 47 页全扫描合同（2026002）上对照 MinerU pipeline、DeepSeek-OCR、Gemini 2.5 Flash，**Gemini 3 Flash 是唯一在 5 个 danger spot（金额首位数字、$ 符号、千分位、列差异化、关键中文短语）上同时无致命错误的方案**。详见 [`ocr_evaluation.md`](ocr_evaluation.md)。
> `gemini-2.5-flash` 作为 fallback：便宜且稳定，但有 fill-down 偷懒和偶发语义幻觉（"第一季度价格" → "第一年提价格"）。

**方案 B：本地 OCR（tesseract via unstructured）**
适合简单排版，复杂合同（骑缝章、多列、中英混排）识别率差，不推荐作为主方案。

---

## 内嵌图片 + 表格（数字 PDF 中的嵌入元素）

> **2026-05-28 更新**：原 PoC（`image_extraction_test.ipynb`）用 fitz + pdfplumber 双通道并跑，是在我们还没确定 MinerU 之前的方案。**MinerU pipeline 已经在 `content_list.json` 里同时给了图片和表格**——`type=image`（带 `img_path`）和 `type=table`（带 HTML body + 备份 `img_path`），都带 `bbox` 和 `page_idx`。所以**不再需要双通道，MinerU 一次就给齐了**。
>
> 但 PoC 里的 **Gemini Vision 图片有效性判别**逻辑仍然适用——MinerU 会把 logo / 印章 / 装饰图也抽出来，需要后过滤。

### 提取方案（V1）

```python
# 已经在 content_list.json 里，直接 walk
for el in content_list:
    if el["type"] == "image":
        # MinerU 抽出来的图片，img_path 指向本地 png
        # 送 Gemini Vision 判断 valid/invalid
        ...
    elif el["type"] == "table":
        # HTML 表格直接当 chunk_type="table" 入库
        # 备份 img_path 留着前端展示用
        ...
```

### 过滤规则

- 图片：发 Gemini Vision 判别（见下方 JSON schema），`valid=false` 不入库
- 表格：MinerU 已做表格检测，不需要 pdfplumber 的"行数 < 2 跳过"启发式（V1）

### Gemini Vision 图片有效性判别 schema

```json
{"valid": true, "type": "table", "content": "Markdown 格式的还原内容"}
{"valid": false, "type": "logo", "content": ""}
```

有效类型（`valid=true`）：`table`、`chart`、`diagram`、`scanned_text`
无效类型（`valid=false`）：`logo`、`signature`、`decorative`、`other`

> 注：MinerU 已识别为 `type=table` 的元素不再过 Gemini Vision，直接入库。Gemini Vision 只判别 MinerU 输出的 `type=image`。

### 正式集成时

- `type=image` 且 Gemini 判 valid → 存为 `chunk_type="image"`，内容是 Gemini 还原的 markdown
- `type=table` → 存为 `chunk_type="table"`，内容是 MinerU 的 HTML
- 阅读顺序：直接按 `content_list.json` 数组顺序（MinerU 已排好）

### 留存：原 PoC 路径作为 V2 fallback

如果 V1 跑起来发现 MinerU 漏图（嵌入图片它没识别成 `type=image`），可以回退到 fitz 双通道补漏：

- `pymupdf`（`fitz`）：`page.get_images()` + `doc.extract_image(xref)` 拿图片字节
- pdfplumber 的 `page.images` 只有元数据 bbox，**不能**提取图片字节，必须用 fitz

### 踩过的坑

- LangChain 调用 Gemini Vision **必须用 `HumanMessage` 包裹**，裸 dict 会报 `'role' and 'content' keys` 错误：
  ```python
  from langchain_core.messages import HumanMessage
  LLM().get_chat_object().invoke([
      HumanMessage(content=[
          {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
          {"type": "text", "text": "..."}
      ])
  ])
  ```

- `response.content` 返回的是 **list of content blocks**，不是字符串，需要提取：
  ```python
  def extract_text(content) -> str:
      if isinstance(content, list):
          return " ".join([b.get("text", "") for b in content if isinstance(b, dict)])
      return content
  ```

- pdfplumber 的 `page.images` 只有元数据（bbox），**不能提取图片字节**；图片字节提取必须用 fitz，不要试图用 pdfplumber 替代。
