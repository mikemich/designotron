// Starter files, built through the same AI tool layer Claude uses.

import { dispatchOrThrow, getDoc } from "./store";
import { buildSample } from "./sample";

export interface Template {
  id: string;
  name: string;
  description: string;
  /** Accent colours for the gallery card. */
  colors: [string, string];
  build: () => void;
}

function ai(tool: string, input: unknown): any {
  return dispatchOrThrow({ op: "ai", tool, input });
}

function setName(name: string) {
  dispatchOrThrow({ op: "setDocName", name });
}

export const TEMPLATES: Template[] = [
  {
    id: "mobile",
    name: "Mobile app",
    description: "Two linked screens, a button component and a prototype",
    colors: ["#1B1340", "#9B85FF"],
    build: () => {
      buildSample();
      setName("Mobile app");
    },
  },
  { id: "landing", name: "Landing page", description: "Hero, features, pricing and footer at 1440px", colors: ["#0F172A", "#38BDF8"], build: buildLanding },
  { id: "dashboard", name: "Dashboard", description: "Sidebar, KPI cards, chart area and a data table", colors: ["#F8FAFC", "#6366F1"], build: buildDashboard },
  { id: "system", name: "Design system", description: "Colour and text styles, buttons with variants, inputs, cards", colors: ["#FFF7ED", "#F97316"], build: buildDesignSystem },
];

function buildLanding() {
  setName("Landing page");
  const feature = (title: string, body: string, tint: string) => ({
    type: "frame",
    name: "Feature",
    width: "fill",
    fill: "#FFFFFF",
    cornerRadius: 20,
    stroke: "#E2E8F0",
    layout: { direction: "vertical", padding: 28, gap: 12 },
    children: [
      { type: "rectangle", name: "Icon", width: 44, height: 44, cornerRadius: 12, fill: tint },
      { type: "text", text: title, fontSize: 20, fontWeight: 700, color: "#0F172A" },
      { type: "text", text: body, fontSize: 16, lineHeight: 26, color: "#475569", width: "fill" },
    ],
  });
  const plan = (name: string, price: string, highlight: boolean) => ({
    type: "frame",
    name: `Plan ${name}`,
    width: "fill",
    fill: highlight ? "#0F172A" : "#FFFFFF",
    stroke: highlight ? "none" : "#E2E8F0",
    cornerRadius: 24,
    layout: { direction: "vertical", padding: 32, gap: 16 },
    children: [
      { type: "text", text: name, fontSize: 18, fontWeight: 600, color: highlight ? "#38BDF8" : "#0F172A" },
      { type: "text", text: price, fontSize: 44, fontWeight: 800, color: highlight ? "#FFFFFF" : "#0F172A" },
      { type: "text", text: "per month, billed yearly", fontSize: 14, color: highlight ? "#94A3B8" : "#64748B" },
      {
        type: "frame",
        name: "CTA",
        width: "fill",
        fill: highlight ? "#38BDF8" : "#0F172A",
        cornerRadius: 12,
        layout: { direction: "horizontal", padding: [14, 20], align: "center" },
        children: [{ type: "text", text: "Choose plan", fontSize: 16, fontWeight: 600, color: highlight ? "#0F172A" : "#FFFFFF" }],
      },
    ],
  });
  ai("create_nodes", {
    nodes: [
      {
        type: "frame",
        name: "Landing",
        x: 0,
        y: 0,
        width: 1440,
        fill: "#F8FAFC",
        layout: { direction: "vertical", gap: 0 },
        children: [
          {
            type: "frame",
            name: "Nav",
            width: "fill",
            layout: { direction: "horizontal", padding: [24, 80], align: "space-between", crossAlign: "center" },
            children: [
              { type: "text", text: "Northwind", fontSize: 22, fontWeight: 800, color: "#0F172A" },
              {
                type: "frame",
                name: "Links",
                layout: { direction: "horizontal", gap: 32, crossAlign: "center" },
                children: ["Product", "Pricing", "Docs", "Blog"].map((t) => ({ type: "text", text: t, fontSize: 16, color: "#334155" })),
              },
            ],
          },
          {
            type: "frame",
            name: "Hero",
            width: "fill",
            fill: "linear-gradient(180deg, #0F172A 0%, #1E293B 100%)",
            layout: { direction: "vertical", padding: [120, 80], gap: 24, crossAlign: "center" },
            children: [
              { type: "text", text: "Ship analytics your team actually reads", fontSize: 64, fontWeight: 800, color: "#FFFFFF", textAlign: "center", width: 900, lineHeight: 72 },
              { type: "text", text: "Northwind turns raw events into weekly stories. Set up in five minutes, no SQL required.", fontSize: 20, color: "#94A3B8", textAlign: "center", width: 640, lineHeight: 32 },
              {
                type: "frame",
                name: "Hero CTA",
                fill: "#38BDF8",
                cornerRadius: 14,
                layout: { direction: "horizontal", padding: [18, 32] },
                children: [{ type: "text", text: "Start free trial", fontSize: 18, fontWeight: 700, color: "#0F172A" }],
              },
            ],
          },
          {
            type: "frame",
            name: "Features",
            width: "fill",
            layout: { direction: "horizontal", padding: [96, 80], gap: 24 },
            children: [
              feature("Weekly digests", "Every Monday, a plain-language summary of what changed and why.", "#E0F2FE"),
              feature("Anomaly alerts", "Get pinged when a metric moves more than it usually does.", "#FCE7F3"),
              feature("Shareable reports", "Turn any chart into a link your whole company can open.", "#DCFCE7"),
            ],
          },
          {
            type: "frame",
            name: "Pricing",
            width: "fill",
            layout: { direction: "horizontal", padding: [0, 80, 96, 80], gap: 24 },
            children: [plan("Starter", "$0", false), plan("Team", "$49", true), plan("Business", "$199", false)],
          },
          {
            type: "frame",
            name: "Footer",
            width: "fill",
            fill: "#0F172A",
            layout: { direction: "horizontal", padding: [40, 80], align: "space-between" },
            children: [
              { type: "text", text: "© 2026 Northwind", fontSize: 14, color: "#94A3B8" },
              { type: "text", text: "Privacy · Terms · Contact", fontSize: 14, color: "#94A3B8" },
            ],
          },
        ],
      },
    ],
  });
}

function buildDashboard() {
  setName("Dashboard");
  const kpi = (label: string, value: string, delta: string, up: boolean) => ({
    type: "frame",
    name: `KPI ${label}`,
    width: "fill",
    fill: "#FFFFFF",
    cornerRadius: 16,
    stroke: "#E2E8F0",
    layout: { direction: "vertical", padding: 20, gap: 8 },
    children: [
      { type: "text", text: label, fontSize: 14, color: "#64748B" },
      { type: "text", text: value, fontSize: 30, fontWeight: 700, color: "#0F172A" },
      { type: "text", text: delta, fontSize: 13, fontWeight: 600, color: up ? "#15803D" : "#DC2626" },
    ],
  });
  const row = (cells: string[], header = false) => ({
    type: "frame",
    name: header ? "Header row" : "Row",
    width: "fill",
    fill: header ? "#F8FAFC" : "#FFFFFF",
    layout: { direction: "horizontal", padding: [14, 20] },
    children: cells.map((c) => ({ type: "text", text: c, width: "fill", fontSize: 14, fontWeight: header ? 600 : 400, color: header ? "#475569" : "#0F172A" })),
  });
  const bars = [40, 65, 52, 80, 72, 95, 60, 88, 76, 100, 84, 92];
  ai("create_nodes", {
    nodes: [
      {
        type: "frame",
        name: "Dashboard",
        x: 0,
        y: 0,
        width: 1440,
        height: 960,
        fill: "#F1F5F9",
        layout: { direction: "horizontal" },
        children: [
          {
            type: "frame",
            name: "Sidebar",
            width: 240,
            height: "fill",
            fill: "#0F172A",
            layout: { direction: "vertical", padding: 24, gap: 6 },
            children: [
              { type: "text", text: "Acme Ops", fontSize: 20, fontWeight: 800, color: "#FFFFFF" },
              { type: "rectangle", name: "Spacer", width: 10, height: 18, fill: "none" },
              ...["Overview", "Orders", "Customers", "Inventory", "Reports", "Settings"].map((t, i) => ({
                type: "frame",
                name: `Nav ${t}`,
                width: "fill",
                fill: i === 0 ? "#1E293B" : "none",
                cornerRadius: 10,
                layout: { direction: "horizontal", padding: [10, 12] },
                children: [{ type: "text", text: t, fontSize: 15, fontWeight: i === 0 ? 600 : 400, color: i === 0 ? "#FFFFFF" : "#94A3B8" }],
              })),
            ],
          },
          {
            type: "frame",
            name: "Main",
            width: "fill",
            height: "fill",
            layout: { direction: "vertical", padding: 32, gap: 24 },
            children: [
              {
                type: "frame",
                name: "Top bar",
                width: "fill",
                layout: { direction: "horizontal", align: "space-between", crossAlign: "center" },
                children: [
                  { type: "text", text: "Overview", fontSize: 28, fontWeight: 700, color: "#0F172A" },
                  {
                    type: "frame",
                    name: "Search",
                    width: 320,
                    fill: "#FFFFFF",
                    stroke: "#E2E8F0",
                    cornerRadius: 10,
                    layout: { direction: "horizontal", padding: [10, 14] },
                    children: [{ type: "text", text: "Search orders, customers…", fontSize: 14, color: "#64748B" }],
                  },
                ],
              },
              {
                type: "frame",
                name: "KPIs",
                width: "fill",
                layout: { direction: "horizontal", gap: 16 },
                children: [kpi("Revenue", "$128,420", "▲ 12.4% vs last month", true), kpi("Orders", "3,284", "▲ 4.1%", true), kpi("Refunds", "41", "▼ 2.3%", false), kpi("Avg. order", "$39.10", "▲ 0.8%", true)],
              },
              {
                type: "frame",
                name: "Chart card",
                width: "fill",
                fill: "#FFFFFF",
                cornerRadius: 16,
                stroke: "#E2E8F0",
                layout: { direction: "vertical", padding: 24, gap: 16 },
                children: [
                  { type: "text", text: "Revenue by month", fontSize: 16, fontWeight: 600, color: "#0F172A" },
                  {
                    type: "frame",
                    name: "Bars",
                    width: "fill",
                    height: 180,
                    layout: { direction: "horizontal", gap: 14, crossAlign: "end" },
                    children: bars.map((h, i) => ({ type: "rectangle", name: `Bar ${i + 1}`, width: "fill", height: h * 1.7, cornerRadius: [6, 6, 0, 0], fill: i === 9 ? "#6366F1" : "#C7D2FE" })),
                  },
                ],
              },
              {
                type: "frame",
                name: "Table",
                width: "fill",
                fill: "#FFFFFF",
                cornerRadius: 16,
                stroke: "#E2E8F0",
                clip: true,
                layout: { direction: "vertical" },
                children: [
                  row(["Order", "Customer", "Status", "Total"], true),
                  row(["#10482", "Lena Fischer", "Shipped", "$84.00"]),
                  row(["#10481", "Omar Haddad", "Processing", "$212.50"]),
                  row(["#10480", "Mei Tanaka", "Delivered", "$39.90"]),
                ],
              },
            ],
          },
        ],
      },
    ],
  });
}

function buildDesignSystem() {
  setName("Design system");
  ai("define_styles", {
    colors: [
      { name: "Brand/Primary", color: "#F97316" },
      { name: "Brand/Primary dark", color: "#C2410C" },
      { name: "Neutral/900", color: "#1C1917" },
      { name: "Neutral/500", color: "#78716C" },
      { name: "Neutral/100", color: "#F5F5F4" },
      { name: "Success", color: "#16A34A" },
      { name: "Danger", color: "#DC2626" },
    ],
    texts: [
      { name: "Display", fontFamily: "Inter", fontSize: 48, fontWeight: 800, lineHeight: 56, letterSpacing: 0 },
      { name: "Heading", fontFamily: "Inter", fontSize: 28, fontWeight: 700, lineHeight: 36, letterSpacing: 0 },
      { name: "Title", fontFamily: "Inter", fontSize: 18, fontWeight: 700, lineHeight: 26, letterSpacing: 0 },
      { name: "Body", fontFamily: "Inter", fontSize: 16, fontWeight: 400, lineHeight: 24, letterSpacing: 0 },
      { name: "Label", fontFamily: "Inter", fontSize: 15, fontWeight: 600, lineHeight: 20, letterSpacing: 0 },
      { name: "Caption", fontFamily: "Inter", fontSize: 13, fontWeight: 500, lineHeight: 18, letterSpacing: 0 },
    ],
  });
  const button = (state: string, fill: string, text: string, stroke?: string) => ({
    type: "frame",
    name: `State=${state}`,
    fill,
    stroke: stroke ?? "none",
    cornerRadius: 10,
    layout: { direction: "horizontal", padding: [12, 20], align: "center", crossAlign: "center" },
    children: [{ type: "text", text: "Button", fontSize: 15, fontWeight: 600, color: text }],
  });
  const created = ai("create_nodes", {
    nodes: [
      button("Default", "#C2410C", "#FFFFFF"),
      button("Hover", "#9A3412", "#FFFFFF"),
      button("Secondary", "#FFFFFF", "#1C1917", "#D6D3D1"),
      button("Disabled", "#F5F5F4", "#A8A29E"),
    ].map((b, i) => ({ ...b, x: 80 + i * 150, y: 420 })),
  }).created.map((c: any) => c.id);
  const comps = created.map((id: string) => ai("arrange", { action: "create_component", ids: [id] }).id);
  const set = ai("arrange", { action: "combine_variants", ids: comps }).id;
  ai("update_nodes", { updates: [{ id: set, name: "Button" }] });

  const swatch = (name: string, color: string) => ({
    type: "frame",
    name,
    layout: { direction: "vertical", gap: 8 },
    children: [
      { type: "rectangle", name: "Swatch", width: 120, height: 80, cornerRadius: 12, fill: color },
      { type: "text", text: name, fontSize: 13, fontWeight: 600, color: "#1C1917" },
      { type: "text", text: color, fontSize: 12, color: "#78716C" },
    ],
  });
  ai("create_nodes", {
    nodes: [
      {
        type: "frame",
        name: "Foundations",
        x: 0,
        y: -40,
        width: 980,
        fill: "#FFF7ED",
        cornerRadius: 24,
        layout: { direction: "vertical", padding: 40, gap: 28 },
        children: [
          { type: "text", text: "Foundations", fontSize: 36, fontWeight: 800, color: "#1C1917" },
          {
            type: "frame",
            name: "Colours",
            layout: { direction: "horizontal", gap: 16, wrap: true },
            width: "fill",
            children: [
              swatch("Primary", "#F97316"),
              swatch("Primary dark", "#C2410C"),
              swatch("Neutral 900", "#1C1917"),
              swatch("Neutral 500", "#78716C"),
              swatch("Neutral 100", "#F5F5F4"),
              swatch("Success", "#16A34A"),
            ],
          },
          {
            type: "frame",
            name: "Type scale",
            layout: { direction: "vertical", gap: 10 },
            children: [
              { type: "text", text: "Display 48 / 800", fontSize: 48, fontWeight: 800, color: "#1C1917" },
              { type: "text", text: "Heading 28 / 700", fontSize: 28, fontWeight: 700, color: "#1C1917" },
              { type: "text", text: "Body 16 / 400: the quick brown fox jumps over the lazy dog.", fontSize: 16, color: "#44403C" },
              { type: "text", text: "Caption 13 / 500", fontSize: 13, fontWeight: 500, color: "#78716C" },
            ],
          },
        ],
      },
      {
        type: "frame",
        name: "Input",
        x: 80,
        y: 560,
        width: 320,
        layout: { direction: "vertical", gap: 6 },
        children: [
          { type: "text", text: "Email", fontSize: 13, fontWeight: 600, color: "#1C1917" },
          {
            type: "frame",
            name: "Field",
            width: "fill",
            fill: "#FFFFFF",
            stroke: "#D6D3D1",
            cornerRadius: 10,
            layout: { direction: "horizontal", padding: [12, 14] },
            children: [{ type: "text", text: "you@example.com", fontSize: 15, color: "#78716C" }],
          },
        ],
      },
      {
        type: "frame",
        name: "Card",
        x: 460,
        y: 560,
        width: 340,
        fill: "#FFFFFF",
        cornerRadius: 18,
        shadow: { y: 6, blur: 24, color: "#1C191714" },
        layout: { direction: "vertical", padding: 24, gap: 10 },
        children: [
          { type: "text", text: "Card title", fontSize: 18, fontWeight: 700, color: "#1C1917" },
          { type: "text", text: "Cards group related content and actions.", fontSize: 15, color: "#57534E", width: "fill" },
        ],
      },
    ],
  });
  const ids = Object.values(getDoc().nodes)
    .filter((n) => (n.name === "Input" || n.name === "Card") && !n.parent)
    .map((n) => n.id);
  for (const id of ids) ai("arrange", { action: "create_component", ids: [id] });
  // Link every colour that matches a style, so editing a style updates the whole system.
  ai("fix_issues", { kinds: ["unlinkedStyle"] });
  // Same for type: text whose size and weight match a text style uses it.
  const doc = getDoc();
  for (const style of doc.styles.texts) {
    const ids = Object.values(doc.nodes)
      .filter((n) => n.type === "text" && !n.textStyle && n.text?.fontSize === style.fontSize && n.text?.fontWeight === style.fontWeight)
      .map((n) => n.id);
    if (ids.length) dispatchOrThrow({ op: "applyStyle", ids, styleId: style.id });
  }
  ai("select", { ids: [] });
}
