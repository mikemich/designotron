// Agent-style spec: product card grid, 1200 wide, 3 columns via wrap.
const card = (i, cat, title, desc, price) => ({
  type: "frame", name: `Card ${i}`, width: 352, height: "hug",
  fill: "#FFFFFF", cornerRadius: 16, clip: true, stroke: "#E2E8F0", strokeWidth: 1,
  layout: { direction: "vertical", gap: 0, padding: 0 },
  children: [
    { type: "rectangle", name: "Cover", width: "fill", height: 200, fill: "linear-gradient(135deg, #C7D2FE 0%, #818CF8 100%)" },
    { type: "frame", name: "Body", width: "fill", height: "hug",
      layout: { direction: "vertical", gap: 8, padding: 20 },
      children: [
        { type: "text", name: "Category", text: cat, fontSize: 12, fontWeight: 600, color: "#4F46E5", textCase: "upper", letterSpacing: 1, width: "fill" },
        { type: "text", name: "Title", text: title, fontSize: 18, fontWeight: 600, color: "#0F172A", width: "fill" },
        { type: "text", name: "Description", text: desc, fontSize: 14, lineHeight: 22, color: "#475569", width: "fill" },
        { type: "frame", name: "Footer", width: "fill", height: "hug", layout: { direction: "horizontal", align: "space-between", crossAlign: "center", padding: 0 },
          children: [
            { type: "text", name: "Price", text: price, fontSize: 20, fontWeight: 700, color: "#0F172A" },
            { type: "frame", name: "Add to cart", height: "hug", fill: "#0F172A", cornerRadius: 8, layout: { direction: "horizontal", padding: [8, 14], crossAlign: "center" },
              children: [{ type: "text", name: "Label", text: "Add to cart", fontSize: 14, fontWeight: 600, color: "#FFFFFF" }] }
          ] }
      ] }
  ]
});
export const nodes = [{
  type: "frame", name: "Products", x: 0, y: 0, width: 1200, height: "hug", fill: "#F8FAFC",
  layout: { direction: "vertical", gap: 32, padding: 40 },
  children: [
    { type: "frame", name: "Header", width: "fill", height: "hug", layout: { direction: "horizontal", align: "space-between", crossAlign: "center" },
      children: [
        { type: "text", name: "Title", text: "Products", fontSize: 28, fontWeight: 700, color: "#0F172A" },
        { type: "frame", name: "New product", height: "hug", fill: "#4F46E5", cornerRadius: 8, layout: { direction: "horizontal", padding: [10, 16], crossAlign: "center" },
          children: [{ type: "text", name: "Label", text: "New product", fontSize: 14, fontWeight: 600, color: "#FFFFFF" }] }
      ] },
    { type: "frame", name: "Grid", width: "fill", height: "hug", layout: { direction: "horizontal", wrap: true, gap: 24, padding: 0 },
      children: [
        card(1, "Audio", "Wireless headphones Pro", "Noise-cancelling over-ear headphones with a 40 hour battery and fast charging.", "$199"),
        card(2, "Wearables", "Smart watch Series 5", "Always-on display, heart-rate tracking and five days of battery life.", "$249"),
        card(3, "Home", "Desk lamp", "Dimmable LED lamp with a warm and cool light range.", "$59"),
        card(4, "Audio", "Portable speaker", "Waterproof speaker with 360 degree sound.", "$89"),
        card(5, "Accessories", "USB-C hub", "Seven ports, including HDMI 4K and 100 W pass-through power.", "$79"),
        card(6, "Office", "Ergonomic chair with a very long product name that should wrap onto two lines", "Lumbar support and breathable mesh.", "$449")
      ] }
  ]
}];
