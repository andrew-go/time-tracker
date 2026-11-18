/*
 * The dither island. React and the dithercn engine live only in here; the
 * plain-JS app uses two custom elements:
 *
 *   <sky-dither now="0.44" cell="3"></sky-dither>   the day ribbon's sky
 *   <topo-background></topo-background>             the app's background map
 *
 * Each element mounts a React root when it's attached and unmounts it when it's
 * removed, so re-rendered views never leak WebGL contexts.
 */
import { createRoot, type Root } from "react-dom/client";

import { Contours } from "@/components/dithercn/contours";
import { SkyRibbon } from "@/components/sky-ribbon";
import { ditherMaskStyle, fillStyle } from "@/lib/dither";
import "./index.css";

// dithercn's tokens switch on a `.dark` class; this app follows the system
// setting, so mirror it. Changing the class also makes every shader re-read
// its palette (the sky colours are light-dark() pairs).
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const syncDarkClass = () => document.documentElement.classList.toggle("dark", darkQuery.matches);
syncDarkClass();
darkQuery.addEventListener("change", syncDarkClass);

class SkyDither extends HTMLElement {
  static observedAttributes = ["now", "cell"];
  #root: Root | null = null;
  #onTheme = () => this.#render();

  connectedCallback() {
    this.#root ??= createRoot(this);
    darkQuery.addEventListener("change", this.#onTheme);
    this.#render();
  }

  disconnectedCallback() {
    darkQuery.removeEventListener("change", this.#onTheme);
    const root = this.#root;
    this.#root = null;
    // Unmount after the current DOM work finishes (React warns on sync unmount during render).
    queueMicrotask(() => root?.unmount());
  }

  attributeChangedCallback() {
    this.#render();
  }

  #render() {
    if (!this.#root) return;
    const now = Number(this.getAttribute("now") ?? "-1");
    const cell = Number(this.getAttribute("cell") ?? "3");
    this.#root.render(
      <SkyRibbon
        className="absolute inset-0"
        now={Number.isFinite(now) ? now : -1}
        cell={Number.isFinite(cell) && cell > 0 ? cell : 3}
        dark={darkQuery.matches}
      />,
    );
  }
}

if (!customElements.get("sky-dither")) customElements.define("sky-dither", SkyDither);

/*
 * The app's background: dithercn's Contours example, tuned to sit quietly
 * behind everything. Plain contour lines with every fifth drawn heavier, no
 * hillshade, slow drift, in the app's --topo-* colours (light-dark pairs,
 * faint enough that muted text over a line keeps 4.5:1).
 */
class TopoBackground extends HTMLElement {
  #root: Root | null = null;

  connectedCallback() {
    this.#root ??= createRoot(this);
    this.#root.render(
      <Contours
        className="absolute inset-0"
        lines={12}
        scale={0.9}
        index={5}
        relief={0}
        speed={0.4}
        palette={["transparent", "--topo-line", "--topo-index"]}
      />,
    );
  }

  disconnectedCallback() {
    const root = this.#root;
    this.#root = null;
    queueMicrotask(() => root?.unmount());
  }
}

if (!customElements.get("topo-background")) customElements.define("topo-background", TopoBackground);


/*
 * Dithered entry blocks on the ribbon. Static CSS masks from the engine
 * (no WebGL), injected once; until then, and in forced-colours mode, the
 * blocks stay solid. The plain-JS side draws each block's ::before in its
 * project colour; these rules only add the mask.
 *   finished entries: an even dither, 12 of every 16 cells
 *   the running entry: densest at the "now" edge, thinning back to its start
 */
const cssText = (style: Record<string, unknown>) =>
  Object.entries(style)
    .filter(([key]) => !key.startsWith("Webkit") || key === "WebkitMaskImage" || key.startsWith("WebkitMask"))
    .map(([key, value]) => `${key.replace(/^Webkit/, "-webkit-").replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${String(value)};`)
    .join(" ");

const cell = "var(--blk-cell)";
const done = ditherMaskStyle(0.75, { cell });
// Only the mask properties: the block's colour comes from the app's CSS.
const { backgroundColor: _unused, ...running } = fillStyle("gradient", {
  edge: "right",
  from: 1,
  to: 0.3125,
  length: 10,
  cell,
}) as Record<string, unknown>;

const fills = document.createElement("style");
fills.id = "dither-fills";
fills.textContent = `@media not (forced-colors: active) {
  .ribbon .blk::before { ${cssText(done as Record<string, unknown>)} }
  .ribbon .blk.run::before { ${cssText(running)} }
}`;
document.head.append(fills);
