# Memory Index

| 文件 | 内容 |
|------|------|
| [ingestion_pipeline.md](ingestion_pipeline.md) | 合同入库 Pipeline 总方案：页段分流、扫描/数字路由、原件对齐、存储分层、阈值参数（先读这个） |
| [pdf_parsing.md](pdf_parsing.md) | PDF 解析底层方案：全文字 PDF、扫描件、内嵌图片的处理思路与实验结论 |
| [ocr_evaluation.md](ocr_evaluation.md) | 2026-05-26 在 2026002 扫描件上实测 MinerU / DeepSeek-OCR / Gemini 2.5 Flash / Gemini 3 Flash 四个 OCR 方案的横评结果与决策（扫描页→Gemini 3 Flash） |
| [digital_parsing_evaluation.md](digital_parsing_evaluation.md) | 2026-05-28 在 2026004 数字合同上实测 MinerU pipeline / unstructured hi_res / pdfplumber 的横评（数字页→MinerU；unstructured 中文乱码不可用） |
| [embedding_pitfalls.md](embedding_pitfalls.md) | 2026-05-28 向量化踩坑：`embed_documents` 在 Vertex 上静默丢数据（已修，batch_size=1）+ 检索质量基线（2026004 recall@1=90%/recall@3=100%，跨语言可用） |
| [retrieval_eval.md](retrieval_eval.md) | 2026-06-08 检索接通 `POST /api/query` + RAGAS 评测基线（2026004 scoped：faithfulness 0.86/answer_correctness 0.44 等）+ 模型分层 + ⚠️RAGAS judge 不能用 gemini-3-flash-preview（list-content 致 faithfulness=0）+ 七奠基石 baseline-vs-agentic 对比（困难混合/跨合同题上 agent retrieval_coverage 0.30→0.77、source_precision 0.60→1.00、answer_sim +0.07，问题越难差距越大；切端点的权威证据）。开发检索/问答前先读 |
