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
import { ditherMaskStyle } from "@/lib/dither";
import "./index.css";

// dithercn's tokens switch on a `.dark` class; this app follows the system
// setting, so mirror it. Changing the class also makes every shader re-read
// its palette (the sky colours are light-dark() pairs).
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const syncDarkClass = () => document.documentElement.classList.toggle("dark", darkQuery.matches);
syncDarkClass();
darkQuery.addEventListener("change", syncDarkClass);

class SkyDither extends HTMLElement {
  static observedAttributes = ["now", "cell", "rise", "set", "from", "to"];
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
    // Sunrise and sunset as fractions of the day (the app computes them per date).
    const rise = Number(this.getAttribute("rise") ?? "0.275");
    const set = Number(this.getAttribute("set") ?? "0.785");
    // The clock hours the strip shows (daylight ± ~1¼ h, wider if entries need it).
    let from = Number(this.getAttribute("from") ?? "0");
    let to = Number(this.getAttribute("to") ?? "24");
    if (!(Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to <= 24 && to - from >= 1)) { from = 0; to = 24; }
    const ok = Number.isFinite(rise) && Number.isFinite(set) && rise > 0.02 && set < 0.98 && set - rise > 0.1;
    this.#root.render(
      <SkyRibbon
        className="absolute inset-0"
        now={Number.isFinite(now) ? now : -1}
        cell={Number.isFinite(cell) && cell > 0 ? cell : 3}
        rise={ok ? rise * 24 : 6.6}
        set={ok ? set * 24 : 18.85}
        from={from}
        to={to}
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
 * Dithered entry blocks on the ribbon: project-colour dots drawn straight onto
 * the sky. Static CSS masks from the engine (no WebGL), injected once; until
 * then, and in forced-colours mode, the blocks stay solid. The plain-JS side
 * paints each block's ::before in its project colour; these rules add the mask.
 *   finished entries: 12 of every 16 cells
 *   the running entry: half the cells, so it reads as still in progress
 */
const cssText = (style: Record<string, unknown>) =>
  Object.entries(style)
    .map(([key, value]) => `${key.replace(/^Webkit/, "-webkit-").replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${String(value)};`)
    .join(" ");

const cell = "var(--blk-cell)";
const fills = document.createElement("style");
fills.id = "dither-fills";
fills.textContent = `@media not (forced-colors: active) {
  .ribbon .blk::before { ${cssText(ditherMaskStyle(0.75, { cell }) as Record<string, unknown>)} }
  .ribbon .blk.run::before { ${cssText(ditherMaskStyle(0.5, { cell }) as Record<string, unknown>)} }
}`;
document.head.append(fills);
