// Fixture for r10a-e2e: builds the device-frame iPhone app: a scrolling feed with a fixed tab bar, a detail screen,
// a bottom sheet overlay and prototype links. Runs in the page through __dt.tool.
export default async function setup(page) {
  const res = await page.evaluate(async () => {
    const T = (name, input) => window.__dt.tool(name, input);
    const card = (i) => ({
      type: "frame", name: `Card ${i}`, width: "fill", height: "hug", fill: "#FFFFFF", cornerRadius: 16,
      shadow: { y: 2, blur: 12, color: "#00000014" },
      layout: { direction: "horizontal", gap: 12, padding: 14, crossAlign: "center" },
      children: [
        { type: "rectangle", name: `Thumb ${i}`, width: 56, height: 56, fill: i % 2 ? "#D6F5FF" : "#FFD6E0", cornerRadius: 12 },
        { type: "frame", name: `Card ${i} text`, width: "fill", height: "hug", layout: { direction: "vertical", gap: 4 },
          children: [
            { type: "text", name: `Card ${i} title`, width: "fill", text: `Workout ${i}`, fontSize: 17, fontWeight: 600, color: "#111111" },
            { type: "text", name: `Card ${i} sub`, width: "fill", text: `${20 + i} min · Strength`, fontSize: 14, color: "#6B7280" },
          ] },
      ],
    });
    const tab = (name, label, col) => ({
      type: "frame", name: `Tab ${name}`, width: "fill", height: "hug", layout: { direction: "vertical", gap: 4, align: "center", crossAlign: "center" },
      children: [
        { type: "ellipse", name: `${name} icon`, width: 24, height: 24, fill: col },
        { type: "text", name: `${name} label`, text: label, fontSize: 11, fontWeight: 500, color: col },
      ],
    });
    const feed = {
      type: "frame", name: "Feed", x: 0, y: 0, device: "iphone-17-pro", fill: "#F3F4F8", overflow: "vertical",
      layout: { direction: "vertical", gap: 12, padding: { top: 12, right: 16, bottom: 12, left: 16 } },
      children: [
        { type: "frame", name: "Header", width: "fill", height: "hug", layout: { direction: "horizontal", align: "space-between", crossAlign: "center" },
          children: [
            { type: "text", name: "Title", text: "Today", fontFamily: "Poppins", fontSize: 34, fontWeight: 700, color: "#111111" },
            { type: "ellipse", name: "Filter button", width: 40, height: 40, fill: "#6D4AFF" },
          ] },
        ...Array.from({ length: 12 }, (_, i) => card(i + 1)),
        { type: "frame", name: "Tab bar", width: 402, height: 84, absolute: true, x: 0, y: 790, scrollBehavior: "fixed", fill: "#FFFFFF",
          layout: { direction: "horizontal", align: "space-between", crossAlign: "center", padding: { top: 10, right: 24, bottom: 24, left: 24 } },
          children: [tab("Home", "Home", "#6D4AFF"), tab("Search", "Search", "#9CA3AF"), tab("Saved", "Saved", "#9CA3AF"), tab("Profile", "Profile", "#9CA3AF")] },
      ],
    };
    const detail = {
      type: "frame", name: "Detail", x: 500, y: 0, device: "iphone-17-pro", fill: "#FFFFFF",
      layout: { direction: "vertical", gap: 16, padding: { top: 12, right: 20, bottom: 24, left: 20 } },
      children: [
        { type: "frame", name: "Nav", width: "fill", height: "hug", layout: { direction: "horizontal", crossAlign: "center", gap: 12 },
          children: [
            { type: "vector", name: "Back", width: 24, height: 24, svgPath: "M15 18l-6-6 6-6", viewBox: [0, 0, 24, 24], stroke: "#111111", strokeWidth: 2 },
            { type: "text", name: "Detail title", text: "Workout 1", fontSize: 20, fontWeight: 700, color: "#111111" },
          ] },
        { type: "rectangle", name: "Hero image", width: "fill", height: 220, cornerRadius: 20, fill: "#D6F5FF" },
        { type: "text", name: "Description", width: "fill", fontSize: 16, lineHeight: 24, color: "#374151",
          text: "A full-body session with squats, push-ups and rows. Pick a rest interval and follow along." },
      ],
    };
    const sheet = {
      type: "frame", name: "Filter sheet", x: 1000, y: 0, width: 402, height: 320, fill: "#FFFFFF", cornerRadius: { topLeft: 24, topRight: 24, bottomRight: 0, bottomLeft: 0 },
      layout: { direction: "vertical", gap: 16, padding: 24 },
      children: [
        { type: "text", name: "Sheet title", text: "Filter workouts", fontSize: 22, fontWeight: 700, color: "#111111" },
        { type: "text", name: "Sheet body", width: "fill", text: "Choose a level and duration.", fontSize: 15, color: "#6B7280" },
        { type: "frame", name: "Done", width: "fill", height: 52, fill: "#6D4AFF", cornerRadius: 14, layout: { direction: "horizontal", align: "center", crossAlign: "center" },
          children: [{ type: "text", name: "Done label", text: "Done", fontSize: 16, fontWeight: 600, color: "#FFFFFF" }] },
      ],
    };
    // A banner whose image is an inline data URL, as AI and import tools leave it.
    const bannerImg = (() => { const c = document.createElement("canvas"); c.width = 900; c.height = 300; const x = c.getContext("2d"); const g = x.createLinearGradient(0, 0, 900, 300); g.addColorStop(0, "#6D28D9"); g.addColorStop(1, "#0EA5E9"); x.fillStyle = g; x.fillRect(0, 0, 900, 300); for (let i = 0; i < 400; i++) { x.fillStyle = `rgba(${(i * 37) % 255},${(i * 91) % 255},${(i * 53) % 255},0.5)`; x.fillRect((i * 97) % 900, (i * 61) % 300, 9, 9); } return c.toDataURL("image/png"); })();
    const banner = { type: "frame", name: "Banner", x: 1500, y: 0, width: 402, height: 200, fill: "#FFFFFF",
      children: [{ type: "rectangle", name: "Banner image", x: 0, y: 0, width: 402, height: 200, imageUrl: bannerImg }] };
    const r = await T("create_nodes", { nodes: [feed, detail, sheet, banner] });
    if (r?.warnings?.length) console.log("warnings", JSON.stringify(r.warnings));
    window.__setupResult = r; if (!r?.ok) return { failed: JSON.stringify(r).slice(0, 1500) };
    const d = window.__dt.doc();
    const find = (name, root) => {
      const hit = Object.values(d.nodes).filter((n) => n.name === name);
      return hit.length === 1 ? hit[0].id : hit.find((n) => (root ? n.page && true : true))?.id;
    };
    const ids = Object.fromEntries(Object.values(d.nodes).map((n) => [n.name, n.id]));
    // Prototype: a card opens Detail with a slide, the Filter button opens the sheet, Done closes it, Back returns.
    const feedId = ids["Feed"], detailId = ids["Detail"], sheetId = ids["Filter sheet"];
    await T("set_prototype", { nodeId: ids["Card 1"], destinationId: detailId, action: "navigate", transition: "slide_left", trigger: "click" });
    await T("set_prototype", { nodeId: ids["Filter button"], destinationId: sheetId, action: "open_overlay", trigger: "click", overlay: { position: "bottom_center", background: "#000000", backgroundOpacity: 0.4 } });
    await T("set_prototype", { nodeId: ids["Done"], action: "close_overlay", trigger: "click" });
    await T("set_prototype", { nodeId: ids["Back"], action: "back", trigger: "click" });
    await T("set_prototype", { nodeId: feedId, destinationId: detailId, action: "navigate", trigger: "key", key: "ArrowRight" });
    window.__setupIds = ids;
    return { ok: true };
  });
  if (!res.ok) console.log('SETUP', JSON.stringify(res));
}
