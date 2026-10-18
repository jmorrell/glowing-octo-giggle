// Browser component for the CAD plugin. A stand-in for a 3D viewer: it draws one box per
// part instead of geometry, but exercises the same boundary a real viewer would cross.
import type { ComponentHost, PluginSelector } from "../../contract";
import type { Part } from "./parts";

declare const magpie: ComponentHost;

let selected: string | null = null;
let annotated = new Set<string>();
let { parts } = (await magpie.getData()) as { parts: Part[] };
let style = document.createElement("style");
style.textContent = `
  body { font: 14px system-ui, sans-serif; margin: 12px; }
  .parts { display: flex; gap: 12px; flex-wrap: wrap; }
  button { border: 2px solid #567; border-radius: 6px; padding: 18px 14px; background: #eef3f7; min-width: 120px; cursor: pointer; }
  button.focused { border-color: #d60; background: #fff4e6; }
  button .marker { color: #d60; margin-left: 6px; }`;
document.head.append(style);
let root = document.createElement("div");
root.className = "parts";
document.body.append(root);

function selectorFor(part: Part): PluginSelector {
  return { type: "plugin", plugin: "example.cad", value: part.entity, label: `${part.name} (${part.entity})` };
}

function render() {
  root.replaceChildren(
    ...parts.map((part) => {
      let button = document.createElement("button");
      button.dataset.entity = part.entity;
      button.className = part.entity === selected ? "focused" : "";
      button.textContent = part.name;
      if (annotated.has(part.entity)) {
        let marker = document.createElement("span");
        marker.className = "marker";
        marker.textContent = "●";
        marker.setAttribute("aria-label", "has notes");
        button.append(marker);
      }
      button.addEventListener("click", () => {
        selected = part.entity;
        render();
        void magpie.proposeAnnotation(selectorFor(part));
      });
      return button;
    }),
  );
}

let setAnnotations = (list: { selector: PluginSelector }[]) => {
  annotated = new Set(list.map((a) => a.selector.value));
  render();
};
magpie.onEvent((event) => {
  if (event.type === "annotations") setAnnotations(event.annotations);
  if (event.type === "focus") {
    selected = event.selector.value;
    render();
  }
});
setAnnotations(await magpie.getAnnotations());
