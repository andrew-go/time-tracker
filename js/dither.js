// Loads the dither island (React + dithercn, built into vendor/dither/) once.
// It defines the <sky-dither> and <topo-background> elements. Until it loads,
// or if it can't (no network on first visit, no WebGL), the CSS fallbacks show.

let ditherLoad;

export function loadDither() {
  ditherLoad ??= (async () => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = new URL('../vendor/dither/dither.css', import.meta.url).href;
    document.head.append(css);
    await import('../vendor/dither/dither.js');
  })().catch((err) => {
    console.warn('Dithered visuals unavailable, using CSS fallbacks.', err);
  });
  return ditherLoad;
}
