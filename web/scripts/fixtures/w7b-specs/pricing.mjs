const feature = (t) => ({ type: "frame", name: "Feature", width: "fill", height: "hug", layout: { direction: "horizontal", gap: 10, crossAlign: "center" },
  children: [
    { type: "vector", name: "Check", svgPath: "M20 6L9 17l-5-5", viewBox: [0, 0, 24, 24], width: 16, height: 16, stroke: "#16A34A", strokeWidth: 2, fill: "none" },
    { type: "text", name: "Feature text", text: t, fontSize: 15, color: "#334155", width: "fill" }
  ] });
const tier = (name, price, desc, feats, highlight) => ({
  type: "frame", name: `Tier ${name}`, width: "fill", height: "hug", fill: highlight ? "#111827" : "#FFFFFF", cornerRadius: 16,
  stroke: highlight ? "#111827" : "#E2E8F0", strokeWidth: 1, layout: { direction: "vertical", gap: 20, padding: 32 },
  children: [
    { type: "text", name: "Tier name", text: name, fontSize: 16, fontWeight: 600, color: highlight ? "#A5B4FC" : "#4F46E5" },
    { type: "frame", name: "Price", width: "fill", height: "hug", layout: { direction: "horizontal", crossAlign: "baseline", gap: 4 },
      children: [
        { type: "text", name: "Amount", text: price, fontSize: 48, fontWeight: 700, color: highlight ? "#FFFFFF" : "#0F172A" },
        { type: "text", name: "Period", text: "/mo", fontSize: 16, color: highlight ? "#CBD5E1" : "#64748B" }
      ] },
    { type: "text", name: "Description", text: desc, fontSize: 15, color: highlight ? "#CBD5E1" : "#64748B", width: "fill" },
    { type: "rectangle", name: "Divider", width: "fill", height: 1, fill: highlight ? "#334155" : "#E2E8F0" },
    { type: "frame", name: "Features", width: "fill", height: "hug", layout: { direction: "vertical", gap: 12 }, children: feats.map(feature) },
    { type: "frame", name: "CTA", width: "fill", height: 48, fill: highlight ? "#4F46E5" : "#F1F5F9", cornerRadius: 10,
      layout: { direction: "horizontal", align: "center", crossAlign: "center" },
      children: [{ type: "text", name: "CTA label", text: highlight ? "Start free trial" : "Choose " + name, fontSize: 16, fontWeight: 600, color: highlight ? "#FFFFFF" : "#0F172A" }] }
  ]
});
export const nodes = [{
  type: "frame", name: "Pricing", x: 0, y: 0, width: 1200, height: "hug", fill: "#F8FAFC",
  layout: { direction: "vertical", gap: 40, padding: [80, 48], crossAlign: "center" },
  children: [
    { type: "frame", name: "Pricing heading", width: "fill", height: "hug", layout: { direction: "vertical", gap: 12, crossAlign: "center" },
      children: [
        { type: "text", name: "Eyebrow", text: "PRICING", fontSize: 13, fontWeight: 600, color: "#4F46E5", letterSpacing: 1.5 },
        { type: "text", name: "Heading", text: "Simple plans that grow with you", fontSize: 40, fontWeight: 700, color: "#0F172A", textAlign: "center" }
      ] },
    { type: "frame", name: "Tiers", width: "fill", height: "hug", layout: { direction: "horizontal", gap: 24, crossAlign: "start" },
      children: [
        tier("Starter", "$0", "For individuals trying things out.", ["1 project", "Community support", "Basic components"], false),
        tier("Pro", "$29", "For growing teams that ship every week.", ["Unlimited projects", "Priority support", "Shared libraries", "Version history"], true),
        tier("Enterprise", "$99", "For organisations with security needs.", ["SSO and SAML", "Audit log", "Dedicated success manager"], false)
      ] }
  ]
}];
