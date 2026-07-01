import { FormEvent, KeyboardEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, Plus, RotateCcw, RotateCw, Search, Send, ThumbsDown, ThumbsUp, Trash2, X } from "lucide-react";
import { useAskQuestion, useCreateQaConversation, useDeleteQaConversation, useQaConversation, useQaConversations, useSubmitFeedback } from "../../api/hooks";
import { contractPageUrl } from "../../api/client";
import type { FeedbackScore, QaConversationDetail, QueryClauseEvidence, QueryEvidence, QueryRecordEvidence, QueryResponse } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { Card, PageHeader } from "../../components/ui/Panel";

interface ConversationTurn {
  question: string;
  status: "pending" | "done" | "error";
  response?: QueryResponse;
  feedback?: FeedbackScore | null;
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
  const submitFeedback = useSubmitFeedback();
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
      setError("The Q&A service is temporarily unavailable; please try again later.");
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

  function handleFeedback(messageId: string, score: FeedbackScore) {
    setTurns((current) => current.map((turn) =>
      turn.response?.message_id === messageId ? { ...turn, feedback: score } : turn));
    void submitFeedback.mutateAsync({ messageId, score }).catch(() => {
      // Revert the optimistic vote if persisting failed.
      setTurns((current) => current.map((turn) =>
        turn.response?.message_id === messageId ? { ...turn, feedback: null } : turn));
    });
  }

  return (
    <>
      <PageHeader
        title="Contract Q&A"
        subtitle="Retrieval-augmented Q&A over all contracts · answers come with traceable sources"
      />
      <div className="content-pad qa-page">
        <Card className="qa-history">
          <div className="qa-history-header">
            <strong>Chat history</strong>
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => void startNewConversation()}>New conversation</Button>
          </div>
          <div className="qa-history-list" aria-label="Chat history list">
            {(conversations.data ?? []).length > 0 ? (conversations.data ?? []).map((item) => (
              <div className="qa-history-item-wrap" key={item.conversation_id}>
                <button
                  className={`qa-history-item ${activeConversationId === item.conversation_id ? "active" : ""}`}
                  onClick={() => activateConversation(item.conversation_id)}
                >
                  <span>{item.title}</span>
                  <small>{item.message_count} messages</small>
                </button>
                <button
                  className="qa-history-delete"
                  aria-label={`Delete ${item.title}`}
                  onClick={() => setDeleteTarget({ id: item.conversation_id, title: item.title })}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )) : (
              <p className="qa-history-empty">No past conversations</p>
            )}
          </div>
        </Card>
        <Card className="qa-workspace">
          <div className="qa-toolbar">
            <div className="qa-scope-field">
              <span>Scope</span>
              <label className="sr-only" htmlFor="qa-scope-type">Scope type</label>
              <select
                id="qa-scope-type"
                value={scopeType}
                onChange={(event) => {
                  setScopeType(event.target.value as ScopeType);
                  if (event.target.value === "all") setScopeValue("");
                }}
                aria-label="Scope type"
              >
                <option value="all">All</option>
                <option value="contract">Contract No.</option>
                <option value="supplier">Supplier</option>
              </select>
              <label className="sr-only" htmlFor="qa-scope-value">Scope value</label>
              <input
                id="qa-scope-value"
                aria-label="Scope value"
                value={scopeValue}
                onChange={(event) => setScopeValue(event.target.value)}
                disabled={scopeType === "all"}
                placeholder={scopeType === "supplier" ? "Enter a supplier name" : scopeType === "contract" ? "Enter a contract number" : "Search all contracts"}
              />
            </div>
          </div>

          <div className="qa-thread">
            {turns.length > 0 ? (
              <div className="qa-conversation-stack">
                {turns.map((turn, index) => (
                  <Conversation key={`${turn.question}-${index}`} turn={turn} onVerify={(source) => setVerifying({ source, page: source.page ?? 1 })} onFeedback={handleFeedback} />
                ))}
              </div>
            ) : (
              <div className="qa-empty">
                <Search size={28} />
                <h2>Ask the contract corpus</h2>
                <p>Ask about payment terms, liability, amount ranges, or supplier comparisons — answers come with traceable sources.</p>
              </div>
            )}
          </div>

          <form className="qa-composer" onSubmit={(event) => void submitQuestion(event)}>
            {error ? <div className="qa-error" role="alert">{error}</div> : null}
            {conversationLocked ? (
              <div className="qa-locked-notice" role="alert">
                <span>This conversation has reached its length limit. To keep answers fully context-aware, start a new conversation to continue.</span>
                <Button variant="primary" icon={<Plus size={14} />} onClick={() => void startNewConversation()}>Start new conversation</Button>
              </div>
            ) : null}
            <textarea
              aria-label="Enter a contract question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder={conversationLocked ? "This conversation has reached its length limit; start a new one" : "e.g. For contracts with payment terms over 60 days, how is liability for late payment specified?"}
              rows={3}
              disabled={conversationLocked}
            />
            <Button variant="primary" type="submit" loading={askQuestion.isPending} disabled={conversationLocked} icon={<Send size={15} />}>Send</Button>
          </form>
        </Card>
      </div>
      {verifying ? <VerifyModal state={verifying} onClose={() => setVerifying(null)} /> : null}
      {deleteTarget ? (
        <div className="modal-layer">
          <div className="modal-scrim" onClick={() => setDeleteTarget(null)} />
          <section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="qa-delete-title">
            <h2 id="qa-delete-title">Delete conversation?</h2>
            <p>This will delete "{deleteTarget.title}" and all of its Q&A records. This cannot be undone.</p>
            <footer>
              <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
              <Button variant="danger" loading={deleteConversation.isPending} onClick={() => void confirmDeleteConversation()}>Delete</Button>
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

function Conversation({ turn, onVerify, onFeedback }: { turn: ConversationTurn; onVerify: (source: QueryClauseEvidence) => void; onFeedback: (messageId: string, score: FeedbackScore) => void }) {
  return (
    <div className="qa-conversation">
      <div className="qa-question-bubble">{turn.question}</div>
      {turn.status === "pending" ? <ThinkingCard /> : null}
      {turn.status === "error" ? <ErrorAnswerCard /> : null}
      {turn.status === "done" && turn.response ? <AnswerCard response={turn.response} feedback={turn.feedback} onVerify={onVerify} onFeedback={onFeedback} /> : null}
    </div>
  );
}

function ThinkingCard() {
  return (
    <article className="qa-answer-card qa-thinking-card" role="status">
      <div className="qa-thinking-title">
        <span className="qa-thinking-dots" aria-hidden="true"><i /><i /><i /></span>
        <strong>Searching the contract corpus</strong>
      </div>
      <p>Analyzing ledger records and source text to produce a verifiable answer…</p>
    </article>
  );
}

function ErrorAnswerCard() {
  return (
    <article className="qa-answer-card qa-answer-error" role="alert">
      The Q&A service is temporarily unavailable; please try again later.
    </article>
  );
}

function AnswerCard({ response, feedback, onVerify, onFeedback }: { response: QueryResponse; feedback?: FeedbackScore | null; onVerify: (source: QueryClauseEvidence) => void; onFeedback: (messageId: string, score: FeedbackScore) => void }) {
  const { records, clauses } = useMemo(() => partitionEvidence(response.evidence), [response.evidence]);
  const messageId = response.message_id;

  return (
    <article className="qa-answer-card">
      <div className="qa-answer-body">{response.answer}</div>
      {records.length > 0 ? <RecordEvidenceTable records={records} /> : null}
      {clauses.length > 0 ? <ClauseEvidenceList clauses={clauses} onVerify={onVerify} /> : null}
      {records.length === 0 && clauses.length === 0 ? <p className="qa-muted">No traceable sources</p> : null}
      {messageId ? <FeedbackButtons value={feedback} onVote={(score) => onFeedback(messageId, score)} /> : null}
    </article>
  );
}

export function FeedbackButtons({ value, onVote }: { value?: FeedbackScore | null; onVote: (score: FeedbackScore) => void }) {
  return (
    <div className="qa-feedback" role="group" aria-label="Answer feedback">
      <span className="qa-feedback-label">Was this answer helpful?</span>
      <button
        type="button"
        className={`qa-feedback-btn ${value === "up" ? "active" : ""}`}
        aria-label="Helpful"
        aria-pressed={value === "up"}
        onClick={() => onVote("up")}
      >
        <ThumbsUp size={14} />
      </button>
      <button
        type="button"
        className={`qa-feedback-btn ${value === "down" ? "active" : ""}`}
        aria-label="Not helpful"
        aria-pressed={value === "down"}
        onClick={() => onVote("down")}
      >
        <ThumbsDown size={14} />
      </button>
    </div>
  );
}

function RecordEvidenceTable({ records }: { records: QueryRecordEvidence[] }) {
  const columns = recordColumns(records);
  return (
    <section className="qa-evidence-section">
      <div className="qa-section-title">
        <strong>Matched contracts · ledger records</strong>
        <span>{records.length}</span>
      </div>
      <div className="qa-table-wrap">
        <table className="data-table qa-record-table" aria-label="Matched contract evidence">
          <thead>
            <tr>
              <th>Contract No.</th>
              <th>Name</th>
              {columns.map((column) => <th key={column}>{column}</th>)}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={record.contract_id}>
                <td className="mono">{record.contract_id}</td>
                <td>{record.title || "-"}</td>
                {columns.map((column) => <td key={column}>{formatEvidenceValue(record.fields[column])}</td>)}
                <td><Link className="qa-link" to={`/contracts/${record.contract_id}`}>View ledger</Link></td>
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
        <strong>Clause text</strong>
        <span>{clauses.length}</span>
      </div>
      <div className="qa-source-list">
        {clauses.map((source, index) => (
          <article className="qa-source-card" key={`${source.contract_id}-${source.page ?? "na"}-${index}`}>
            <div className="qa-source-meta">{source.contract_id} · p. {source.page ?? "-"}{source.section ? ` · ${source.section}` : ""}</div>
            <p>{source.snippet}</p>
            <Button icon={<Search size={14} />} onClick={() => onVerify(source)} disabled={!source.page}>Verify source</Button>
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
      <section className="qa-verify-modal" role="dialog" aria-modal="true" aria-label="Source verification">
        <header>
          <div>
            <h2>Source verification</h2>
            <p>{state.source.contract_id} · p. {state.page}{state.source.section ? ` · ${state.source.section}` : ""}</p>
          </div>
          <div className="qa-verify-actions">
            <button className="lightbox-tool" onClick={() => setRotation((current) => (current + 270) % 360)} aria-label="Rotate left 90°"><RotateCcw size={16} /></button>
            <button className="lightbox-tool" onClick={() => setRotation((current) => (current + 90) % 360)} aria-label="Rotate right 90°"><RotateCw size={16} /></button>
            <button className="lightbox-close" onClick={onClose} aria-label="Close source verification"><X size={18} /></button>
          </div>
        </header>
        <div className="qa-verify-stage qa-verify-stage-single-page" data-testid="qa-verify-stage">
          <div className="qa-page-image-wrap" data-testid="qa-page-image-wrap" style={{ transform: `rotate(${rotation}deg)` }}>
            <img src={pageUrl} alt={`${state.source.contract_id} page ${state.page} source`} />
            {bbox ? <div data-testid="source-highlight" className="qa-source-highlight" style={bboxToStyle(bbox)} /> : null}
          </div>
        </div>
        <footer>
          <p>{state.source.snippet}</p>
          <a className="button button-secondary" href={pageUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />Open in new window</a>
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
        message_id: message.message_id,
        evidence: message.evidence || []
      };
      current.feedback = message.feedback ?? null;
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
