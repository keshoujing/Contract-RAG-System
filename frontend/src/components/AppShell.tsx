import { NavLink } from "react-router-dom";
import { Database, FilePlus2, MessageSquare, Settings, SplitSquareHorizontal, ToggleLeft, ToggleRight } from "lucide-react";
import { useConfig } from "../api/hooks";

const navItems = [
  { to: "/ledger", label: "Ledger", icon: Database },
  { to: "/qa", label: "Q&A", icon: MessageSquare },
  { to: "/processing", label: "Processing", icon: SplitSquareHorizontal },
  { to: "/settings", label: "Settings", icon: Settings }
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { data: config, isLoading } = useConfig();
  const ragEnabled = config?.ragEnabled ?? false;
  const StatusIcon = ragEnabled ? ToggleRight : ToggleLeft;
  const runtimeLabel = isLoading ? "Loading config" : getRuntimeLabel(ragEnabled);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">CR</div>
          <div>
            <strong>Contract Registry</strong>
            <span>Contract RAG</span>
          </div>
        </div>
        <nav className="nav-list" aria-label="Main navigation">
          {navItems.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
              <item.icon size={18} />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <NavLink to="/upload" className="upload-shortcut">
          <FilePlus2 size={17} />
          Upload contract
        </NavLink>
        <div className="sidebar-status">
          <StatusIcon size={18} />
          <div>
            <strong>Runtime mode</strong>
            <span>{runtimeLabel}</span>
          </div>
        </div>
      </aside>
      <main className="main-stage">{children}</main>
    </div>
  );
}

function getRuntimeLabel(ragEnabled: boolean) {
  return ragEnabled ? "RAG on" : "Entry only";
}
