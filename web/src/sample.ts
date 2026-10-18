// A starter file that shows off frames, auto layout, components, variants
// and prototyping. Built through the same AI tool layer Claude uses.

import { dispatchOrThrow, getEngine } from "./store";

function ai(tool: string, input: unknown): any {
  return dispatchOrThrow({ op: "ai", tool, input });
}

export function buildSample() {
  dispatchOrThrow({ op: "setDocName", name: "Welcome to Designotron" });
  const button = ai("create_nodes", {
    nodes: [
      {
        type: "frame",
        name: "Button",
        x: -320,
        y: 0,
        fill: "#6D4AFF",
        cornerRadius: 14,
        layout: { direction: "horizontal", padding: [16, 24], align: "center", crossAlign: "center", gap: 8 },
        shadow: { y: 8, blur: 24, color: "#6D4AFF55" },
        children: [{ type: "text", text: "Get started", color: "#FFFFFF", fontSize: 16, fontWeight: 600 }],
      },
    ],
  }).created[0].id;
  const comp = ai("arrange", { action: "create_component", ids: [button] }).id as string;

  const screens = ai("create_nodes", {
    nodes: [
      {
        type: "frame",
        name: "Welcome",
        x: 0,
        y: 0,
        width: 393,
        height: 852,
        fill: "linear-gradient(180deg, #1B1340 0%, #0E0B1F 100%)",
        layout: { direction: "vertical", padding: [96, 28, 48, 28], gap: 20, align: "space-between" },
        children: [
          {
            type: "frame",
            name: "Hero",
            width: "fill",
            layout: { direction: "vertical", gap: 16 },
            children: [
              { type: "ellipse", name: "Logo", width: 64, height: 64, fill: "linear-gradient(135deg, #9B85FF 0%, #4F46E5 100%)" },
              { type: "text", text: "Design it.\nShip it.", fontSize: 44, fontWeight: 800, color: "#FFFFFF", lineHeight: 50, width: "fill" },
              { type: "text", text: "A free design tool where Claude helps you go from idea to working app.", fontSize: 17, color: "#B8B3D9", lineHeight: 26, width: "fill" },
            ],
          },
          {
            type: "frame",
            name: "Actions",
            width: "fill",
            layout: { direction: "vertical", gap: 12, crossAlign: "center" },
            children: [
              { type: "instance", componentId: comp, name: "Primary button" },
              { type: "text", text: "I already have an account", fontSize: 15, color: "#9B95C9" },
            ],
          },
        ],
      },
      {
        type: "frame",
        name: "Home",
        x: 473,
        y: 0,
        width: 393,
        height: 852,
        fill: "#F6F5FB",
        layout: { direction: "vertical", padding: [64, 20, 24, 20], gap: 16 },
        children: [
          {
            type: "frame",
            name: "Header",
            width: "fill",
            layout: { direction: "horizontal", align: "space-between", crossAlign: "center" },
            children: [
              { type: "text", text: "Your projects", fontSize: 28, fontWeight: 700, color: "#141225" },
              { type: "ellipse", name: "Avatar", width: 40, height: 40, fill: "#D9D4FF" },
            ],
          },
          ...["Marketing site", "iOS app", "Design system"].map((t, i) => ({
            type: "frame",
            name: "Card",
            width: "fill",
            fill: "#FFFFFF",
            cornerRadius: 18,
            layout: { direction: "horizontal", padding: 16, gap: 14, crossAlign: "center" },
            shadow: { y: 2, blur: 12, color: "#1412250F" },
            children: [
              { type: "rectangle", name: "Thumb", width: 56, height: 56, cornerRadius: 12, fill: ["#FFD6E0", "#D6F5FF", "#E3FFD6"][i] },
              {
                type: "frame",
                name: "Text",
                width: "fill",
                layout: { direction: "vertical", gap: 4 },
                children: [
                  { type: "text", text: t, fontSize: 17, fontWeight: 600, color: "#141225" },
                  { type: "text", text: `Edited ${i + 2}h ago`, fontSize: 14, color: "#77738F" },
                ],
              },
            ],
          })),
        ],
      },
    ],
  }).created;

  const welcome = screens[0].id as string;
  const home = screens[1].id as string;
  // Wire the button instance to the Home screen.
  const doc = JSON.parse(getEngine().save());
  const inst = Object.values<any>(doc.nodes).find((n) => n.type === "instance" && n.page && n.parent && doc.nodes[n.parent]?.name === "Actions");
  if (inst) ai("set_prototype", { nodeId: inst.id, destinationId: home, transition: "slide_left" });
  ai("select", { ids: [] });
  return { welcome, home };
}
