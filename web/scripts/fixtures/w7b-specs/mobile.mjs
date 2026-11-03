const tx = (name, sub, amt, neg) => ({ type: "frame", name: `Tx ${name}`, width: "fill", height: "hug", fill: "#FFFFFF", cornerRadius: 16,
  layout: { direction: "horizontal", padding: 16, gap: 12, crossAlign: "center" },
  children: [
    { type: "ellipse", name: "Icon", width: 40, height: 40, fill: "#E0E7FF" },
    { type: "frame", name: "Labels", width: "fill", height: "hug", layout: { direction: "vertical", gap: 2 },
      children: [
        { type: "text", name: "Merchant", text: name, fontSize: 15, fontWeight: 600, color: "#111827" },
        { type: "text", name: "Category", text: sub, fontSize: 13, color: "#6B7280" }
      ] },
    { type: "text", name: "Amount", text: amt, fontSize: 15, fontWeight: 600, color: neg ? "#DC2626" : "#16A34A" }
  ] });
export const nodes = [{
  type: "frame", name: "Mobile home", x: 0, y: 0, width: 393, height: 852, fill: "#F9FAFB", clip: true,
  layout: { direction: "vertical", gap: 20, padding: [56, 20, 20, 20] },
  children: [
    { type: "frame", name: "Top bar", width: "fill", height: "hug", layout: { direction: "horizontal", align: "space-between", crossAlign: "center" },
      children: [
        { type: "frame", name: "Greeting", width: "hug", height: "hug", layout: { direction: "vertical", gap: 2 },
          children: [
            { type: "text", name: "Hello", text: "Good morning,", fontSize: 14, color: "#6B7280" },
            { type: "text", name: "Name", text: "Ada", fontSize: 22, fontWeight: 700, color: "#111827" }
          ] },
        { type: "ellipse", name: "Avatar", width: 40, height: 40, fill: "linear-gradient(135deg, #F472B6 0%, #7C3AED 100%)" }
      ] },
    { type: "frame", name: "Search", width: "fill", height: 44, fill: "#FFFFFF", cornerRadius: 22, layout: { direction: "horizontal", padding: [0, 16], gap: 8, crossAlign: "center" },
      children: [
        { type: "vector", name: "Search icon", svgPath: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35", viewBox: [0, 0, 24, 24], width: 18, height: 18, stroke: "#9CA3AF", strokeWidth: 2, fill: "none" },
        { type: "text", name: "Placeholder", text: "Search transactions", fontSize: 15, color: "#9CA3AF" }
      ] },
    { type: "frame", name: "Balance card", width: "fill", height: "hug", fill: "#4F46E5", cornerRadius: 20, layout: { direction: "vertical", gap: 8, padding: 20 },
      children: [
        { type: "text", name: "Balance label", text: "Total balance", fontSize: 13, color: "#C7D2FE" },
        { type: "text", name: "Balance", text: "$12,480.50", fontSize: 32, fontWeight: 700, color: "#FFFFFF" }
      ] },
    { type: "frame", name: "Recent header", width: "fill", height: "hug", layout: { direction: "horizontal", align: "space-between", crossAlign: "center" },
      children: [
        { type: "text", name: "Recent", text: "Recent", fontSize: 18, fontWeight: 700, color: "#111827" },
        { type: "text", name: "See all", text: "See all", fontSize: 14, fontWeight: 500, color: "#4F46E5" }
      ] },
    { type: "frame", name: "Transactions", width: "fill", height: "hug", layout: { direction: "vertical", gap: 12 },
      children: [tx("Netflix", "Subscriptions", "-$15.99", true), tx("Blue Bottle", "Coffee", "-$6.50", true), tx("Payroll", "Income", "+$4,200.00", false)] },
    { type: "frame", name: "Tab bar", absolute: true, x: 0, y: 772, width: 393, height: 80, fill: "#FFFFFF", layout: { direction: "horizontal", align: "space-between", crossAlign: "center", padding: [0, 32] },
      children: ["Home", "Cards", "Send", "Profile"].map((t) => ({ type: "text", name: `Tab ${t}`, text: t, fontSize: 12, fontWeight: 500, color: t === "Home" ? "#4F46E5" : "#9CA3AF" })) }
  ]
}];
