/*
 * The dither island: a custom element, <sky-dither>, that the plain-JS app
 * drops into a day ribbon. React and the dithercn engine live only in here.
 *
 *   <sky-dither now="0.44" cell="3"></sky-dither>
 *
 * The element mounts a React root when it's attached and unmounts it when it's
 * removed, so re-rendered views never leak WebGL contexts.
 */
import { createRoot, type Root } from "react-dom/client";

import { SkyRibbon } from "@/components/sky-ribbon";
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
