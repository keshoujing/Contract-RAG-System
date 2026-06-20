import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DatabaseZap, FileCog, FolderArchive, Info, Save, Settings2 } from "lucide-react";
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
  const [excel, setExcel] = useState(data?.excelEnabled ?? true);
  const [backup, setBackup] = useState(true);
  const [lock, setLock] = useState(true);
  const [confirming, setConfirming] = useState<"rag" | "excel" | null>(null);
  const [ruleDrafts, setRuleDrafts] = useState<FileNoRule[]>([]);
  const [ruleError, setRuleError] = useState("");
  const [savingRules, setSavingRules] = useState(false);
  const [versionDrafts, setVersionDrafts] = useState<string[]>([]);
  const [versionInput, setVersionInput] = useState("");
  const [savingVersions, setSavingVersions] = useState(false);

  useEffect(() => {
    if (!data) return;
    setRag(data.ragEnabled);
    setExcel(data.excelEnabled);
    setBackup(data.backupEnabled);
    setLock(data.lockCheckEnabled);
    setRuleDrafts(data.fileNoRules);
    setVersionDrafts(data.contractVersions ?? []);
  }, [data]);

  function requestToggle(kind: "rag" | "excel", next: boolean) {
    if (!next) {
      setConfirming(kind);
      return;
    }
    if (kind === "rag") {
      void saveConfig({ ragEnabled: true });
    }
    if (kind === "excel") {
      void saveConfig({ excelEnabled: true });
    }
  }

  function confirmDisable() {
    if (confirming === "rag") {
      void saveConfig({ ragEnabled: false });
    }
    if (confirming === "excel") {
      void saveConfig({ excelEnabled: false });
    }
    setConfirming(null);
  }

  function currentConfig(): ConfigState {
    return {
      ragEnabled: rag,
      excelEnabled: excel,
      backupEnabled: backup,
      lockCheckEnabled: lock,
      fileNoRules: ruleDrafts,
      contractVersions: versionDrafts
    };
  }

  function applyConfig(config: ConfigState) {
    setRag(config.ragEnabled);
    setExcel(config.excelEnabled);
    setBackup(config.backupEnabled);
    setLock(config.lockCheckEnabled);
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
      toast.error(`保存失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  }

  function updateRulePrefix(category: string, prefix: string) {
    setRuleError("");
    setRuleDrafts((current) => current.map((rule) => rule.category === category ? { ...rule, prefix, example: `${prefix.trim()}2026001` } : rule));
  }

  async function saveFileNoRules() {
    if (hasDuplicatePrefix(ruleDrafts)) {
      setRuleError("前缀不能重复");
      return;
    }
    setSavingRules(true);
    try {
      const savedRules = await updateFileNoRules(ruleDrafts);
      setRuleDrafts(savedRules);
      queryClient.setQueryData<ConfigState>(["config"], (current) => ({ ...(current ?? data), fileNoRules: savedRules }) as ConfigState);
      toast.success("已保存存档编号规则");
    } catch (error) {
      setRuleDrafts(data?.fileNoRules ?? []);
      toast.error(`保存失败：${error instanceof Error ? error.message : "未知错误"}`);
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
      toast.success("已保存合同版本");
    } catch (error) {
      setVersionDrafts(data?.contractVersions ?? []);
      toast.error(`保存失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setSavingVersions(false);
    }
  }

  const duplicatedPrefixes = getDuplicatedPrefixes(ruleDrafts);

  if (isLoading && !data) {
    return (
      <>
        <PageHeader title="设置" subtitle="运行模式、台账存储与模型配置" />
        <div className="content-pad settings-page">
          <div className="settings-skeleton" role="status" aria-label="正在加载设置">
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
      <PageHeader title="设置" subtitle="运行模式、台账存储与模型配置" />
      <div className="content-pad settings-page">
        <section className="settings-section">
          <h2>运行模式</h2>
          <div className="settings-grid">
            <SettingToggle icon={<DatabaseZap />} title="RAG 检索模块" badge={rag ? "开启中" : "已关闭"} checked={rag} onChange={(next) => requestToggle("rag", next)} description="关闭后为「纯录入模式」：只抽取审批页字段、整份 PDF 存档、写入台账。不解析正文、不分块、不向量化，最快最省。" />
            <SettingToggle icon={<FileCog />} title="Excel 同步" badge={excel ? "开启中" : "已关闭"} checked={excel} onChange={(next) => requestToggle("excel", next)} description="把数据库的合同数据单向同步进 Excel 台账。关闭后系统仅写入数据库，不再同步到 Excel。" note="同步是独立下游：关闭不影响合同入库与检索；「入库与同步」页该列会整列变灰「已禁用 ⊘」。" />
          </div>
        </section>
        <div className="settings-grid">
          <Card className="settings-card">
            <h3><FolderArchive size={18} />台账存储</h3>
            <ReadOnlyRow label="后端模式" value="SQLite 真源 + Excel 同步下游" />
            <ReadOnlyRow label="台账文件" value="./storage/合同台账.xlsx" action="更改" />
            <ToggleRow label="写前自动备份" checked={backup} onChange={(next) => void saveConfig({ backupEnabled: next })} />
            <ToggleRow label="打开占用检测" checked={lock} onChange={(next) => void saveConfig({ lockCheckEnabled: next })} />
          </Card>
          <Card className="settings-card">
            <h3><Settings2 size={18} />AI 模型</h3>
            <ReadOnlyRow label="审批页 OCR" value="gemini-3-flash-preview" />
            <ReadOnlyRow label="字段抽取" value="强制 JSON Schema 输出" />
            <ReadOnlyRow label="正文 RAG" value="RAG 关闭时不运行" />
          </Card>
        </div>
        <Card className="settings-card">
          <div className="settings-card-header">
            <div>
              <h3>存档编号规则</h3>
              <p>按分类设置编号前缀，系统按年份与分类自动生成连续号。</p>
            </div>
            <Button variant="primary" icon={<Save size={15} />} loading={savingRules} onClick={saveFileNoRules}>保存编号规则</Button>
          </div>
          <table className="data-table compact-table">
            <thead><tr><th>分类</th><th>前缀</th><th>示例</th></tr></thead>
            <tbody>
              {ruleDrafts.map((rule) => {
                const isDuplicated = duplicatedPrefixes.has(rule.prefix.trim());
                return (
                  <tr key={rule.category}>
                    <td className="mono">{rule.category}</td>
                    <td>
                      <label className="file-rule-prefix">
                        <span>{rule.category} 前缀</span>
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
              <h3>合同版本</h3>
              <p>管理合同版本类型列表，用于台账「合同版本」字段的可选项。</p>
            </div>
            <Button variant="primary" icon={<Save size={15} />} loading={savingVersions} onClick={saveContractVersions}>保存合同版本</Button>
          </div>
          <ul className="version-list">
            {versionDrafts.map((v) => (
              <li key={v} className="version-list-item">
                <span>{v}</span>
                <button
                  className="version-remove"
                  aria-label={`删除 ${v}`}
                  onClick={() => setVersionDrafts(versionDrafts.filter((item) => item !== v))}
                >×</button>
              </li>
            ))}
          </ul>
          <div className="version-add-row">
            <label className="file-rule-prefix">
              <span>新增合同版本</span>
              <input
                className="input"
                aria-label="新增合同版本"
                value={versionInput}
                onChange={(event) => setVersionInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") addVersion(); }}
                placeholder="输入版本名称"
              />
            </label>
            <Button onClick={addVersion}>添加版本</Button>
          </div>
        </Card>
      </div>
      {confirming ? (
        <div className="modal-layer">
          <div className="modal-scrim" onClick={() => setConfirming(null)} />
          <section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="settings-confirm-title">
            <h2 id="settings-confirm-title">{confirming === "excel" ? "关闭 Excel 同步？" : "关闭 RAG 检索模块？"}</h2>
            <p>
              {confirming === "excel"
                ? "关闭后系统仅写入数据库，不再同步到 Excel；「入库与同步」页该列将整列变灰「已禁用 ⊘」。是否关闭？"
                : "关闭后为纯录入模式，仅抽取审批页字段并存档，不解析正文、不向量化。已入库数据不受影响。是否关闭？"}
            </p>
            <footer>
              <Button onClick={() => setConfirming(null)}>取消</Button>
              <Button variant="danger" onClick={confirmDisable}>确认关闭</Button>
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

function SettingToggle({ icon, title, badge, description, note, checked, onChange }: { icon: React.ReactNode; title: string; badge: string; description: string; note?: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <Card className="setting-toggle">
      <div className="setting-main">
        <div className="setting-icon">{icon}</div>
        <div><h3>{title} <span className={`badge ${checked ? "badge-on" : "badge-off"}`}>{badge}</span></h3><p>{description}</p></div>
        <button className={`switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)} aria-label={title}><span /></button>
      </div>
      {note ? <p className="setting-note"><Info size={14} />{note}</p> : null}
    </Card>
  );
}

function ReadOnlyRow({ label, value, action }: { label: string; value: string; action?: string }) {
  return <div className="settings-row"><span>{label}</span><strong>{value}</strong>{action ? <button>{action}</button> : null}</div>;
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <div className="settings-row"><span>{label}</span><button className={`switch mini ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}><span /></button></div>;
}
