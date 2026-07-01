import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DatabaseZap, FolderArchive, Save, Settings2 } from "lucide-react";
import { patchConfig, updateContractVersions, updateFileNoRules } from "../../api/client";
import { useConfig } from "../../api/hooks";
import type { ConfigState, FileNoRule } from "../../api/types";
import { Card, PageHeader } from "../../components/ui/Panel";
import { Button } from "../../components/ui/Button";
import { useToast } from "../../components/ui/Toast";

export function SettingsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useConfig();
  const toast = useToast();
  const [rag, setRag] = useState(data?.ragEnabled ?? false);
  const [confirming, setConfirming] = useState<"rag" | null>(null);
  const [ruleDrafts, setRuleDrafts] = useState<FileNoRule[]>([]);
  const [ruleError, setRuleError] = useState("");
  const [savingRules, setSavingRules] = useState(false);
  const [versionDrafts, setVersionDrafts] = useState<string[]>([]);
  const [versionInput, setVersionInput] = useState("");
  const [savingVersions, setSavingVersions] = useState(false);

  useEffect(() => {
    if (!data) return;
    setRag(data.ragEnabled);
    setRuleDrafts(data.fileNoRules);
    setVersionDrafts(data.contractVersions ?? []);
  }, [data]);

  function requestToggle(kind: "rag", next: boolean) {
    if (!next) {
      setConfirming(kind);
      return;
    }
    void saveConfig({ ragEnabled: true });
  }

  function confirmDisable() {
    if (confirming === "rag") {
      void saveConfig({ ragEnabled: false });
    }
    setConfirming(null);
  }

  function currentConfig(): ConfigState {
    return {
      ragEnabled: rag,
      fileNoRules: ruleDrafts,
      contractVersions: versionDrafts
    };
  }

  function applyConfig(config: ConfigState) {
    setRag(config.ragEnabled);
    setRuleDrafts(config.fileNoRules);
    setVersionDrafts(config.contractVersions ?? []);
    queryClient.setQueryData<ConfigState>(["config"], config);
  }

  async function saveConfig(partial: Partial<ConfigState>) {
    const previous = currentConfig();
    const optimistic = { ...previous, ...partial };
    applyConfig(optimistic);
    try {
      const savedConfig = await patchConfig(partial, optimistic);
      applyConfig(savedConfig);
    } catch (error) {
      applyConfig(previous);
      toast.error(`Failed to save: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  function updateRulePrefix(category: string, prefix: string) {
    setRuleError("");
    setRuleDrafts((current) => current.map((rule) => rule.category === category ? { ...rule, prefix, example: `${prefix.trim()}2026001` } : rule));
  }

  async function saveFileNoRules() {
    if (hasDuplicatePrefix(ruleDrafts)) {
      setRuleError("Prefixes must be unique");
      return;
    }
    setSavingRules(true);
    try {
      const savedRules = await updateFileNoRules(ruleDrafts);
      setRuleDrafts(savedRules);
      queryClient.setQueryData<ConfigState>(["config"], (current) => ({ ...(current ?? data), fileNoRules: savedRules }) as ConfigState);
      toast.success("File-No. rules saved");
    } catch (error) {
      setRuleDrafts(data?.fileNoRules ?? []);
      toast.error(`Failed to save: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setSavingRules(false);
    }
  }

  function addVersion() {
    const trimmed = versionInput.trim();
    if (!trimmed || versionDrafts.includes(trimmed)) return;
    setVersionDrafts([...versionDrafts, trimmed]);
    setVersionInput("");
  }

  async function saveContractVersions() {
    setSavingVersions(true);
    try {
      const saved = await updateContractVersions(versionDrafts);
      setVersionDrafts(saved);
      queryClient.setQueryData<ConfigState>(["config"], (current) => ({ ...(current ?? data), contractVersions: saved }) as ConfigState);
      toast.success("Contract versions saved");
    } catch (error) {
      setVersionDrafts(data?.contractVersions ?? []);
      toast.error(`Failed to save: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setSavingVersions(false);
    }
  }

  const duplicatedPrefixes = getDuplicatedPrefixes(ruleDrafts);

  if (isLoading && !data) {
    return (
      <>
        <PageHeader title="Settings" subtitle="Runtime mode, registry storage, and model config" />
        <div className="content-pad settings-page">
          <div className="settings-skeleton" role="status" aria-label="Loading settings">
            <div className="settings-skeleton-grid">
              <Card><div className="skeleton-list" /></Card>
              <Card><div className="skeleton-list" /></Card>
            </div>
            <Card><div className="skeleton-list" /></Card>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Settings" subtitle="Runtime mode, registry storage, and model config" />
      <div className="content-pad settings-page">
        <section className="settings-section">
          <h2>Runtime mode</h2>
          <div className="settings-grid">
            <SettingToggle icon={<DatabaseZap />} title="RAG module" badge={rag ? "On" : "Off"} checked={rag} onChange={(next) => requestToggle("rag", next)} description="When off, runs in 'entry-only mode': it only extracts approval-page fields, archives the full PDF, and writes the ledger. No body parsing, chunking, or vectorization — fastest and cheapest." />
          </div>
        </section>
        <div className="settings-grid">
          <Card className="settings-card">
            <h3><FolderArchive size={18} />Ledger storage</h3>
            <ReadOnlyRow label="Backend mode" value="SQLite source of truth" />
            <ReadOnlyRow label="Archive root" value="./storage/{contract_id}/" />
            <ReadOnlyRow label="Spreadsheet export" value="On demand from the ledger page" />
          </Card>
          <Card className="settings-card">
            <h3><Settings2 size={18} />AI models</h3>
            <ReadOnlyRow label="Approval-page OCR" value="gemini-3-flash-preview" />
            <ReadOnlyRow label="Field extraction" value="Forced JSON-Schema output" />
            <ReadOnlyRow label="Body RAG" value="Not run when RAG is off" />
          </Card>
        </div>
        <Card className="settings-card">
          <div className="settings-card-header">
            <div>
              <h3>File-No. rules</h3>
              <p>Set a number prefix per category; the system auto-generates a running sequence by year and category.</p>
            </div>
            <Button variant="primary" icon={<Save size={15} />} loading={savingRules} onClick={saveFileNoRules}>Save File-No. rules</Button>
          </div>
          <table className="data-table compact-table">
            <thead><tr><th>Category</th><th>Prefix</th><th>Example</th></tr></thead>
            <tbody>
              {ruleDrafts.map((rule) => {
                const isDuplicated = duplicatedPrefixes.has(rule.prefix.trim());
                return (
                  <tr key={rule.category}>
                    <td className="mono">{rule.category}</td>
                    <td>
                      <label className="file-rule-prefix">
                        <span>{rule.category} prefix</span>
                        <input
                          className="input mono"
                          value={rule.prefix}
                          aria-invalid={isDuplicated ? "true" : "false"}
                          onChange={(event) => updateRulePrefix(rule.category, event.target.value)}
                        />
                      </label>
                    </td>
                    <td className="mono">{rule.example}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {ruleError ? <p className="form-error file-rule-error">{ruleError}</p> : null}
        </Card>
        <Card className="settings-card">
          <div className="settings-card-header">
            <div>
              <h3>Contract versions</h3>
              <p>Manage the list of contract version types, used as options for the ledger's Contract Version field.</p>
            </div>
            <Button variant="primary" icon={<Save size={15} />} loading={savingVersions} onClick={saveContractVersions}>Save contract versions</Button>
          </div>
          <ul className="version-list">
            {versionDrafts.map((v) => (
              <li key={v} className="version-list-item">
                <span>{v}</span>
                <button
                  className="version-remove"
                  aria-label={`Delete ${v}`}
                  onClick={() => setVersionDrafts(versionDrafts.filter((item) => item !== v))}
                >×</button>
              </li>
            ))}
          </ul>
          <div className="version-add-row">
            <label className="file-rule-prefix">
              <span>Add contract version</span>
              <input
                className="input"
                aria-label="Add contract version"
                value={versionInput}
                onChange={(event) => setVersionInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") addVersion(); }}
                placeholder="Enter a version name"
              />
            </label>
            <Button onClick={addVersion}>Add version</Button>
          </div>
        </Card>
      </div>
      {confirming ? (
        <div className="modal-layer">
          <div className="modal-scrim" onClick={() => setConfirming(null)} />
          <section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="settings-confirm-title">
            <h2 id="settings-confirm-title">Disable RAG module?</h2>
            <p>
              When off, it runs in entry-only mode: it only extracts approval-page fields and archives them, with no body parsing or vectorization. Already-ingested data is unaffected. Disable it?
            </p>
            <footer>
              <Button onClick={() => setConfirming(null)}>Cancel</Button>
              <Button variant="danger" onClick={confirmDisable}>Confirm disable</Button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}

function getDuplicatedPrefixes(rules: FileNoRule[]) {
  const counts = new Map<string, number>();
  rules.forEach((rule) => {
    const prefix = rule.prefix.trim();
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  });
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([prefix]) => prefix));
}

function hasDuplicatePrefix(rules: FileNoRule[]) {
  return getDuplicatedPrefixes(rules).size > 0;
}

function SettingToggle({ icon, title, badge, description, checked, onChange }: { icon: React.ReactNode; title: string; badge: string; description: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <Card className="setting-toggle">
      <div className="setting-main">
        <div className="setting-icon">{icon}</div>
        <div><h3>{title} <span className={`badge ${checked ? "badge-on" : "badge-off"}`}>{badge}</span></h3><p>{description}</p></div>
        <button className={`switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)} aria-label={title}><span /></button>
      </div>
    </Card>
  );
}

function ReadOnlyRow({ label, value, action }: { label: string; value: string; action?: string }) {
  return <div className="settings-row"><span>{label}</span><strong>{value}</strong>{action ? <button>{action}</button> : null}</div>;
}
