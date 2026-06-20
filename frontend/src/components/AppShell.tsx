import { NavLink } from "react-router-dom";
import { Database, FilePlus2, MessageSquare, Settings, SplitSquareHorizontal, ToggleLeft, ToggleRight } from "lucide-react";
import { useConfig } from "../api/hooks";

const navItems = [
  { to: "/ledger", label: "台账", icon: Database },
  { to: "/qa", label: "问答", icon: MessageSquare },
  { to: "/processing", label: "入库与同步", icon: SplitSquareHorizontal },
  { to: "/settings", label: "设置", icon: Settings }
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { data: config, isLoading } = useConfig();
  const ragEnabled = config?.ragEnabled ?? false;
  const StatusIcon = ragEnabled ? ToggleRight : ToggleLeft;
  const runtimeLabel = isLoading ? "读取配置中" : getRuntimeLabel(ragEnabled, config?.excelEnabled ?? true);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">CR</div>
          <div>
            <strong>合同登记系统</strong>
            <span>Contract Registry</span>
          </div>
        </div>
        <nav className="nav-list" aria-label="主导航">
          {navItems.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
              <item.icon size={18} />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <NavLink to="/upload" className="upload-shortcut">
          <FilePlus2 size={17} />
          上传合同
        </NavLink>
        <div className="sidebar-status">
          <StatusIcon size={18} />
          <div>
            <strong>运行模式</strong>
            <span>{runtimeLabel}</span>
          </div>
        </div>
      </aside>
      <main className="main-stage">{children}</main>
    </div>
  );
}

function getRuntimeLabel(ragEnabled: boolean, excelEnabled: boolean) {
  const ragLabel = ragEnabled ? "RAG 开启" : "纯录入";
  const excelLabel = excelEnabled ? "Excel 同步开" : "仅数据库";
  return `${ragLabel} · ${excelLabel}`;
}
