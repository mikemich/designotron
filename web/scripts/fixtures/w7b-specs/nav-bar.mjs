export const nodes = [{
  type: "frame", name: "Navbar", x: 0, y: 0, width: 1440, height: 72, fill: "#FFFFFF",
  layout: { direction: "horizontal", align: "space-between", crossAlign: "center", padding: [0, 48] },
  children: [
    { type: "frame", name: "Logo", width: "hug", height: "hug", layout: { direction: "horizontal", gap: 8, crossAlign: "center" },
      children: [
        { type: "rectangle", name: "Mark", width: 28, height: 28, cornerRadius: 8, fill: "linear-gradient(135deg, #7C5CFF 0%, #4F46E5 100%)" },
        { type: "text", name: "Wordmark", text: "Acme", fontSize: 20, fontWeight: 700, color: "#0F172A" }
      ] },
    { type: "frame", name: "Links", width: "hug", height: "hug", layout: { direction: "horizontal", gap: 32, crossAlign: "center" },
      children: ["Products", "Pricing", "Docs", "Blog"].map((t) => ({ type: "text", name: `Link ${t}`, text: t, fontSize: 15, fontWeight: 500, color: "#334155" })) },
    { type: "frame", name: "Actions", width: "hug", height: "hug", layout: { direction: "horizontal", gap: 12, crossAlign: "center" },
      children: [
        { type: "text", name: "Log in", text: "Log in", fontSize: 15, fontWeight: 500, color: "#334155" },
        { type: "frame", name: "Get started", width: "hug", height: "hug", fill: "#111827", cornerRadius: 999, layout: { direction: "horizontal", padding: [10, 20], crossAlign: "center" },
          children: [{ type: "text", name: "Label", text: "Get started", fontSize: 15, fontWeight: 600, color: "#FFFFFF" }] }
      ] }
  ]
}];
