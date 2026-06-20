import { FormEvent, KeyboardEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, Plus, RotateCcw, RotateCw, Search, Send, Trash2, X } from "lucide-react";
import { useAskQuestion, useCreateQaConversation, useDeleteQaConversation, useQaConversation, useQaConversations } from "../../api/hooks";
import { contractPageUrl } from "../../api/client";
import type { QaConversationDetail, QueryClauseEvidence, QueryEvidence, QueryRecordEvidence, QueryResponse } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { Card, PageHeader } from "../../components/ui/Panel";

interface ConversationTurn {
  question: string;
  status: "pending" | "done" | "error";
  response?: QueryResponse;
}

interface VerifyState {
  source: QueryClauseEvidence;
  page: number;
}

type ScopeType = "all" | "contract" | "supplier";

let rememberedConversationId: string | null = null;

export function QuestionAnswerPage() {
  const askQuestion = useAskQuestion();
  const conversations = useQaConversations();
  const createConversation = useCreateQaConversation();
  const deleteConversation = useDeleteQaConversation();
  const [question, setQuestion] = useState("");
  const [scopeType, setScopeType] = useState<ScopeType>("all");
  const [scopeValue, setScopeValue] = useState("");
  const [activeConversationId, setActiveConversationId] = useState<string | null>(() => rememberedConversationId);
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [error, setError] = useState("");
  const [verifying, setVerifying] = useState<VerifyState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const activeConversation = useQaConversation(activeConversationId);

  useEffect(() => {
    if (!activeConversation.data) return;
    setTurns(turnsFromConversation(activeConversation.data));
  }, [activeConversation.data]);

  // The conversation reached the message cap (retrieval.history_max_messages):
  // the just-answered turn reports it live; a reloaded conversation reports it
  // via the detail's `full`. Either way we force the user into a new thread so
  // earlier turns never silently fall out of the agent's context.
  const lastTurn = turns[turns.length - 1];
  const conversationLocked =
    Boolean(activeConversation.data?.full) || Boolean(lastTurn?.response?.conversation_full);

  async function submitQuestion(event: FormEvent) {
    event.preventDefault();
    await sendQuestion();
  }

  async function sendQuestion() {
    const trimmed = question.trim();
    if (!trimmed || askQuestion.isPending || conversationLocked) return;
    setError("");
    setQuestion("");
    setTurns((current) => [...current, { question: trimmed, status: "pending" }]);
    try {
      const response = await askQuestion.mutateAsync({
        question: trimmed,
        contract_id: scopeType === "contract" ? scopeValue.trim() || null : null,
        conversation_id: activeConversationId,
        scope_type: scopeType,
        scope_value: scopeType === "all" ? null : scopeValue.trim() || null
      });
      if (response.conversation_id) activateConversation(response.conversation_id);
      void conversations.refetch();
      setTurns((current) => replacePendingTurn(current, trimmed, { question: trimmed, status: "done", response }));
    } catch {
      setError("问答服务暂时不可用，请稍后重试。");
      setTurns((current) => replacePendingTurn(current, trimmed, { question: trimmed, status: "error" }));
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void sendQuestion();
  }

  async function startNewConversation() {
    setError("");
    const created = await createConversation.mutateAsync();
    activateConversation(created.conversation_id);
    setTurns([]);
    setQuestion("");
  }

  async function confirmDeleteConversation() {
    if (!deleteTarget) return;
    await deleteConversation.mutateAsync(deleteTarget.id);
    if (activeConversationId === deleteTarget.id) {
      activateConversation(null);
      setTurns([]);
    }
    setDeleteTarget(null);
  }

  return (
    <>
      <PageHeader
        title="合同问答"
        subtitle="基于全部合同的检索增强问答 · 回答附可追溯来源"
      />
      <div className="content-pad qa-page">
        <Card className="qa-history">
          <div className="qa-history-header">
            <strong>历史聊天</strong>
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => void startNewConversation()}>New conversation</Button>
          </div>
          <div className="qa-history-list" aria-label="历史聊天列表">
            {(conversations.data ?? []).length > 0 ? (conversations.data ?? []).map((item) => (
              <div className="qa-history-item-wrap" key={item.conversation_id}>
                <button
                  className={`qa-history-item ${activeConversationId === item.conversation_id ? "active" : ""}`}
                  onClick={() => activateConversation(item.conversation_id)}
                >
                  <span>{item.title}</span>
                  <small>{item.message_count} 条消息</small>
                </button>
                <button
                  className="qa-history-delete"
                  aria-label={`删除 ${item.title}`}
                  onClick={() => setDeleteTarget({ id: item.conversation_id, title: item.title })}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )) : (
              <p className="qa-history-empty">暂无历史会话</p>
            )}
          </div>
        </Card>
        <Card className="qa-workspace">
          <div className="qa-toolbar">
            <div className="qa-scope-field">
              <span>范围</span>
              <label className="sr-only" htmlFor="qa-scope-type">范围类型</label>
              <select
                id="qa-scope-type"
                value={scopeType}
                onChange={(event) => {
                  setScopeType(event.target.value as ScopeType);
                  if (event.target.value === "all") setScopeValue("");
                }}
                aria-label="范围类型"
              >
                <option value="all">全部</option>
                <option value="contract">合同编号</option>
                <option value="supplier">供应商</option>
              </select>
              <label className="sr-only" htmlFor="qa-scope-value">范围值</label>
              <input
                id="qa-scope-value"
                aria-label="范围值"
                value={scopeValue}
                onChange={(event) => setScopeValue(event.target.value)}
                disabled={scopeType === "all"}
                placeholder={scopeType === "supplier" ? "输入供应商名称" : scopeType === "contract" ? "输入合同编号" : "检索全部合同"}
              />
            </div>
          </div>

          <div className="qa-thread">
            {turns.length > 0 ? (
              <div className="qa-conversation-stack">
                {turns.map((turn, index) => (
                  <Conversation key={`${turn.question}-${index}`} turn={turn} onVerify={(source) => setVerifying({ source, page: source.page ?? 1 })} />
                ))}
              </div>
            ) : (
              <div className="qa-empty">
                <Search size={28} />
                <h2>向合同库提问</h2>
                <p>可以问付款期限、违约责任、金额范围、供应商对比，回答会附上可追溯来源。</p>
              </div>
            )}
          </div>

          <form className="qa-composer" onSubmit={(event) => void submitQuestion(event)}>
            {error ? <div className="qa-error" role="alert">{error}</div> : null}
            {conversationLocked ? (
              <div className="qa-locked-notice" role="alert">
                <span>本次对话已达长度上限。为保证回答能完整参考上下文，请开启新对话继续提问。</span>
                <Button variant="primary" icon={<Plus size={14} />} onClick={() => void startNewConversation()}>开启新对话</Button>
              </div>
            ) : null}
            <textarea
              aria-label="输入合同问题"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder={conversationLocked ? "本次对话已达长度上限，请开启新对话" : "例如：付款期限超过 60 天的合同，逾期付款怎么约定违约责任？"}
              rows={3}
              disabled={conversationLocked}
            />
            <Button variant="primary" type="submit" loading={askQuestion.isPending} disabled={conversationLocked} icon={<Send size={15} />}>发送</Button>
          </form>
        </Card>
      </div>
      {verifying ? <VerifyModal state={verifying} onClose={() => setVerifying(null)} /> : null}
      {deleteTarget ? (
        <div className="modal-layer">
          <div className="modal-scrim" onClick={() => setDeleteTarget(null)} />
          <section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="qa-delete-title">
            <h2 id="qa-delete-title">删除对话？</h2>
            <p>将删除「{deleteTarget.title}」及其中所有问答记录，不可恢复。</p>
            <footer>
              <Button onClick={() => setDeleteTarget(null)}>取消</Button>
              <Button variant="danger" loading={deleteConversation.isPending} onClick={() => void confirmDeleteConversation()}>删除</Button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );

  function activateConversation(conversationId: string | null) {
    rememberedConversationId = conversationId;
    setActiveConversationId(conversationId);
  }
}

function Conversation({ turn, onVerify }: { turn: ConversationTurn; onVerify: (source: QueryClauseEvidence) => void }) {
  return (
    <div className="qa-conversation">
      <div className="qa-question-bubble">{turn.question}</div>
      {turn.status === "pending" ? <ThinkingCard /> : null}
      {turn.status === "error" ? <ErrorAnswerCard /> : null}
      {turn.status === "done" && turn.response ? <AnswerCard response={turn.response} onVerify={onVerify} /> : null}
    </div>
  );
}

function ThinkingCard() {
  return (
    <article className="qa-answer-card qa-thinking-card" role="status">
      <div className="qa-thinking-title">
        <span className="qa-thinking-dots" aria-hidden="true"><i /><i /><i /></span>
        <strong>正在检索合同库</strong>
      </div>
      <p>分析台账记录和原文片段，生成可核实回答…</p>
    </article>
  );
}

function ErrorAnswerCard() {
  return (
    <article className="qa-answer-card qa-answer-error" role="alert">
      问答服务暂时不可用，请稍后重试。
    </article>
  );
}

function AnswerCard({ response, onVerify }: { response: QueryResponse; onVerify: (source: QueryClauseEvidence) => void }) {
  const { records, clauses } = useMemo(() => partitionEvidence(response.evidence), [response.evidence]);

  return (
    <article className="qa-answer-card">
      <div className="qa-answer-body">{response.answer}</div>
      {records.length > 0 ? <RecordEvidenceTable records={records} /> : null}
      {clauses.length > 0 ? <ClauseEvidenceList clauses={clauses} onVerify={onVerify} /> : null}
      {records.length === 0 && clauses.length === 0 ? <p className="qa-muted">暂无可追溯来源</p> : null}
    </article>
  );
}

function RecordEvidenceTable({ records }: { records: QueryRecordEvidence[] }) {
  const columns = recordColumns(records);
  return (
    <section className="qa-evidence-section">
      <div className="qa-section-title">
        <strong>匹配合同 · 台账记录</strong>
        <span>{records.length} 条</span>
      </div>
      <div className="qa-table-wrap">
        <table className="data-table qa-record-table" aria-label="匹配合同证据">
          <thead>
            <tr>
              <th>合同编号</th>
              <th>名称</th>
              {columns.map((column) => <th key={column}>{column}</th>)}
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={record.contract_id}>
                <td className="mono">{record.contract_id}</td>
                <td>{record.title || "-"}</td>
                {columns.map((column) => <td key={column}>{formatEvidenceValue(record.fields[column])}</td>)}
                <td><Link className="qa-link" to={`/contracts/${record.contract_id}`}>查看台账</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ClauseEvidenceList({ clauses, onVerify }: { clauses: QueryClauseEvidence[]; onVerify: (source: QueryClauseEvidence) => void }) {
  return (
    <section className="qa-evidence-section">
      <div className="qa-section-title">
        <strong>条款原文</strong>
        <span>{clauses.length} 处</span>
      </div>
      <div className="qa-source-list">
        {clauses.map((source, index) => (
          <article className="qa-source-card" key={`${source.contract_id}-${source.page ?? "na"}-${index}`}>
            <div className="qa-source-meta">{source.contract_id} · 第 {source.page ?? "-"} 页{source.section ? ` · ${source.section}` : ""}</div>
            <p>{source.snippet}</p>
            <Button icon={<Search size={14} />} onClick={() => onVerify(source)} disabled={!source.page}>核实原文</Button>
          </article>
        ))}
      </div>
    </section>
  );
}

function VerifyModal({ state, onClose }: { state: VerifyState; onClose: () => void }) {
  const pageUrl = contractPageUrl(state.source.contract_id, state.page);
  const bbox = state.page === state.source.page ? normalizeBbox(state.source.bbox) : null;
  const [rotation, setRotation] = useState(0);

  useEffect(() => {
    document.body.classList.add("modal-open");
    return () => document.body.classList.remove("modal-open");
  }, []);

  return (
    <div className="modal-layer">
      <div className="modal-scrim" onClick={onClose} />
      <section className="qa-verify-modal" role="dialog" aria-modal="true" aria-label="原文核实">
        <header>
          <div>
            <h2>原文核实</h2>
            <p>{state.source.contract_id} · 第 {state.page} 页{state.source.section ? ` · ${state.source.section}` : ""}</p>
          </div>
          <div className="qa-verify-actions">
            <button className="lightbox-tool" onClick={() => setRotation((current) => (current + 270) % 360)} aria-label="左转 90 度"><RotateCcw size={16} /></button>
            <button className="lightbox-tool" onClick={() => setRotation((current) => (current + 90) % 360)} aria-label="右转 90 度"><RotateCw size={16} /></button>
            <button className="lightbox-close" onClick={onClose} aria-label="关闭原文核实"><X size={18} /></button>
          </div>
        </header>
        <div className="qa-verify-stage qa-verify-stage-single-page" data-testid="qa-verify-stage">
          <div className="qa-page-image-wrap" data-testid="qa-page-image-wrap" style={{ transform: `rotate(${rotation}deg)` }}>
            <img src={pageUrl} alt={`${state.source.contract_id} 第 ${state.page} 页原文`} />
            {bbox ? <div data-testid="source-highlight" className="qa-source-highlight" style={bboxToStyle(bbox)} /> : null}
          </div>
        </div>
        <footer>
          <p>{state.source.snippet}</p>
          <a className="button button-secondary" href={pageUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />新窗口打开</a>
        </footer>
      </section>
    </div>
  );
}

function partitionEvidence(evidence: QueryEvidence[]) {
  return evidence.reduce<{ records: QueryRecordEvidence[]; clauses: QueryClauseEvidence[] }>((groups, item) => {
    if (item.kind === "record") groups.records.push(item);
    if (item.kind === "clause") groups.clauses.push(item);
    return groups;
  }, { records: [], clauses: [] });
}

function recordColumns(records: QueryRecordEvidence[]) {
  return Array.from(new Set(records.flatMap((record) => Object.keys(record.fields || {}))));
}

function formatEvidenceValue(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

function normalizeBbox(bbox?: number[]) {
  if (!bbox || bbox.length < 4 || bbox.some((value) => typeof value !== "number" || Number.isNaN(value))) return null;
  return bbox.slice(0, 4) as [number, number, number, number];
}

function bboxToStyle([x, y, width, height]: [number, number, number, number]) {
  return {
    left: `${x * 100}%`,
    top: `${y * 100}%`,
    width: `${width * 100}%`,
    height: `${height * 100}%`
  };
}

function turnsFromConversation(conversation: QaConversationDetail): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const message of conversation.messages) {
    if (message.role === "user") {
      turns.push({ question: message.content, status: "pending" });
      continue;
    }
    const current = turns[turns.length - 1];
    if (current && current.status === "pending") {
      current.status = "done";
      current.response = {
        question: current.question,
        answer: message.content,
        conversation_id: conversation.conversation_id,
        evidence: message.evidence || []
      };
    }
  }
  return turns;
}

function replacePendingTurn(turns: ConversationTurn[], question: string, next: ConversationTurn) {
  const index = [...turns].reverse().findIndex((turn) => turn.question === question && turn.status === "pending");
  if (index === -1) return turns;
  const target = turns.length - 1 - index;
  return turns.map((turn, turnIndex) => turnIndex === target ? next : turn);
}
