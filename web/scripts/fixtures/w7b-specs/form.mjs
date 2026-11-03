const field = (label, value, name) => ({
  type: "frame", name: `Field ${name}`, width: "fill", height: "hug", layout: { direction: "vertical", gap: 6 },
  children: [
    { type: "text", name: `${name} label`, text: label, fontSize: 14, fontWeight: 500, color: "#334155", width: "fill" },
    { type: "frame", name: `${name} input`, width: "fill", height: 44, fill: "#FFFFFF", stroke: "#CBD5E1", strokeWidth: 1, cornerRadius: 8,
      layout: { direction: "horizontal", padding: [0, 12], crossAlign: "center" },
      children: [{ type: "text", name: `${name} value`, text: value, fontSize: 15, color: "#0F172A" }] }
  ]
});
export const nodes = [{
  type: "frame", name: "Sign up", x: 0, y: 0, width: 480, height: "hug", fill: "#FFFFFF", cornerRadius: 20,
  layout: { direction: "vertical", gap: 24, padding: 40 },
  children: [
    { type: "frame", name: "Heading", width: "fill", height: "hug", layout: { direction: "vertical", gap: 8 },
      children: [
        { type: "text", name: "Title", text: "Create your account", fontSize: 28, fontWeight: 700, color: "#0F172A", width: "fill" },
        { type: "text", name: "Subtitle", text: "Start your 14-day free trial. No credit card needed.", fontSize: 15, color: "#64748B", width: "fill" }
      ] },
    { type: "frame", name: "Fields", width: "fill", height: "hug", layout: { direction: "vertical", gap: 16 },
      children: [field("Full name", "Ada Lovelace", "Name"), field("Work email", "ada@example.com", "Email"), field("Password", "••••••••", "Password")] },
    { type: "frame", name: "Terms", width: "fill", height: "hug", layout: { direction: "horizontal", gap: 8, crossAlign: "center" },
      children: [
        { type: "rectangle", name: "Checkbox", width: 18, height: 18, cornerRadius: 4, stroke: "#94A3B8", strokeWidth: 1.5, fill: "#FFFFFF" },
        { type: "text", name: "Terms text", text: "I agree to the Terms of Service and Privacy Policy", fontSize: 14, color: "#334155", width: "fill" }
      ] },
    { type: "frame", name: "Submit", width: "fill", height: 48, fill: "#4F46E5", cornerRadius: 10,
      layout: { direction: "horizontal", align: "center", crossAlign: "center" },
      children: [{ type: "text", name: "Submit label", text: "Create account", fontSize: 16, fontWeight: 600, color: "#FFFFFF" }] },
    { type: "text", name: "Footer", text: "Already have an account? Log in", fontSize: 14, color: "#64748B", textAlign: "center", width: "fill",
      spans: undefined }
  ]
}];
// Footer as spans instead, so the text node above is replaced.
nodes[0].children[4] = { type: "text", name: "Footer", width: "fill", textAlign: "center", fontSize: 14, color: "#64748B",
  spans: [{ text: "Already have an account? " }, { text: "Log in", fontWeight: 600, color: "#4F46E5" }] };
