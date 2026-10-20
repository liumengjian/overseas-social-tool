import React, { useEffect, useState } from "react";
import Dashboard from "./pages/Dashboard";
import CompetitorAnalysis from "./pages/CompetitorAnalysis";
import VideoDatabase from "./pages/VideoDatabase";
import TrendTracking from "./pages/TrendTracking";
import ViralBreakdown from "./pages/ViralBreakdown";
import ConversionAnalysis from "./pages/ConversionAnalysis";
import OwnAccount from "./pages/OwnAccount";
import AiEditing from "./pages/AiEditing";
import AiImage from "./pages/AiImage";
import Settings from "./pages/Settings";
import VoiceoverCapture from "./pages/VoiceoverCapture";
import CustomerSop from "./pages/CustomerSop";
import WorkflowDock from "./components/WorkflowDock";
import { registerNavigate } from "./navStore";

type Tab =
  | "dashboard"
  | "competitor"
  | "videodb"
  | "trend"
  | "viral"
  | "voiceover"
  | "conversion"
  | "own"
  | "ai"
  | "image"
  | "sop"
  | "publish"
  | "settings";

const NAV: { key: Tab; label: string; no: string; disabled?: boolean }[] = [
  { key: "dashboard", label: "总览仪表盘", no: "·" },
  { key: "competitor", label: "竞对账号分析", no: "一" },
  { key: "videodb", label: "竞对视频数据库", no: "二" },
  { key: "trend", label: "热点与Tag追踪", no: "三" },
  { key: "viral", label: "爆款视频拆解", no: "四" },
  { key: "voiceover", label: "口播文案抓取", no: "五" },
  { key: "conversion", label: "高转化分析", no: "六" },
  { key: "own", label: "自身账号分析", no: "七" },
  { key: "ai", label: "AI批量视频剪辑", no: "八" },
  { key: "image", label: "AI生图", no: "九" },
  { key: "sop", label: "客服SOP语料库", no: "十" },
  { key: "publish", label: "作品发布", no: "十一", disabled: true },
  { key: "settings", label: "设置", no: "十二" },
];

// 页面切换时保留各页面的挂载状态（历史操作/数据不丢失）：
// 首次进入某页才挂载，之后仅用 CSS 隐藏，不再卸载。
export default function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [visited, setVisited] = useState<Set<Tab>>(new Set(["dashboard"]));

  function navigate(next: Tab) {
    // 置灰模块不可进入
    const item = NAV.find((n) => n.key === next);
    if (item?.disabled) return;
    setTab(next);
    setVisited((prev) => {
      if (prev.has(next)) return prev;
      const s = new Set(prev);
      s.add(next);
      return s;
    });
  }

  useEffect(() => {
    registerNavigate(navigate);
  }, []);

  const show = (t: Tab) => (tab === t ? {} : { display: "none" as const });

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">🌏</div>
          <div>
            <div className="brand-title">海外社媒</div>
            <div className="brand-sub">智能运营工具</div>
          </div>
        </div>
        <nav>
          {NAV.map((n) => (
            <button
              key={n.key}
              className={`nav-item ${tab === n.key ? "active" : ""} ${n.disabled ? "disabled" : ""}`}
              onClick={() => navigate(n.key)}
              disabled={n.disabled}
              title={n.disabled ? "模块暂未开发" : n.label}
            >
              <span className="nav-no">{n.no}</span>
              <span>{n.label}</span>
              {n.disabled && <span className="nav-tag">待开发</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot-container">
          <div className="sidebar-foot">数据来源：TiKhub API</div>
          <div className="sidebar-foot">开发者：Prina</div>
        </div>
      </aside>
      <main className={`content ${tab === "image" ? "content-image" : ""}`}>
        <div style={show("dashboard")}>
          <Dashboard onNavigate={navigate} />
        </div>
        {visited.has("competitor") && (
          <div style={show("competitor")}>
            <CompetitorAnalysis />
          </div>
        )}
        {visited.has("videodb") && (
          <div style={show("videodb")}>
            <VideoDatabase />
          </div>
        )}
        {visited.has("trend") && (
          <div style={show("trend")}>
            <TrendTracking />
          </div>
        )}
        {visited.has("viral") && (
          <div style={show("viral")}>
            <ViralBreakdown />
          </div>
        )}
        {visited.has("voiceover") && (
          <div style={show("voiceover")}>
            <VoiceoverCapture />
          </div>
        )}
        {visited.has("conversion") && (
          <div style={show("conversion")}>
            <ConversionAnalysis />
          </div>
        )}
        {visited.has("own") && (
          <div style={show("own")}>
            <OwnAccount />
          </div>
        )}
        {visited.has("ai") && (
          <div style={show("ai")}>
            <AiEditing />
          </div>
        )}
        {visited.has("image") && (
          <div style={show("image")}>
            <AiImage active={tab === "image"} />
          </div>
        )}
        {visited.has("sop") && (
          <div style={show("sop")}>
            <CustomerSop />
          </div>
        )}
        {visited.has("settings") && (
          <div style={show("settings")}>
            <Settings />
          </div>
        )}
      </main>
      <WorkflowDock />
    </div>
  );
}
