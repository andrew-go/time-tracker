"use client";

import { DitherShader } from "@/lib/dither";
import type { DitherShaderProps } from "@/lib/dither";

/*
 * The day ribbon as a dithered sky.
 *
 * x runs through one local day, 0 = midnight, 1 = the next midnight.
 * - `field` (where the dots go): dot density follows how far the sky's brightness
 *   is from the page. In light mode the dark night sky is dense and bright noon is
 *   sparse; in dark mode that flips, so day always reads as the brighter part.
 *   Slow clouds drift through it, and the current time breathes a little.
 * - `colorField` (what colour each dot is): walks the app's own sky colours
 *   night → dawn → sky → noon → sky → dawn → night, read from the palette so it
 *   follows light and dark.
 */
const SKY = `
// The sky below is drawn for a reference day (dawn 4:48–8:24, noon 12:43, dusk
// 16:36–21:06). skyHour() maps the real clock hour onto it so this date's
// light lands where it belongs: dawn from 1h12 before sunrise to 1h30 after,
// solar noon midway, dusk from 1h30 before sunset to 1h12 after (skyRise and
// skySet come from the app). Piecewise linear between those points.
float seg(float h, float a, float b, float ra, float rb) {
  return ra + (rb - ra) * clamp((h - a) / max(b - a, 0.01), 0.0, 1.0);
}
float skyHour(vec2 uv) {
  float h = uv.x * 24.0;
  float noon = 0.5 * (skyRise + skySet);
  float d0 = max(skyRise - 1.2, 0.5), d1 = skyRise + 1.5;
  float k0 = skySet - 1.5, k1 = min(skySet + 1.2, 23.5);
  if (h < d0) return seg(h, 0.0, d0, 0.0, 4.8);
  if (h < d1) return seg(h, d0, d1, 4.8, 8.4);
  if (h < noon) return seg(h, d1, noon, 8.4, 12.725);
  if (h < k0) return seg(h, noon, k0, 12.725, 16.6);
  if (h < k1) return seg(h, k0, k1, 16.6, 21.1);
  return seg(h, k1, 24.0, 21.1, 24.0);
}

// 0 at night, 1 at noon.
float skyLight(float h) {
  float day = smoothstep(4.8, 8.4, h) * (1.0 - smoothstep(16.6, 21.1, h));
  float noon = exp(-((h - 12.5) * (h - 12.5)) / 16.0);
  return clamp(0.08 + 0.62 * day + 0.3 * noon * day, 0.0, 1.0);
}

// Position on the palette ramp night (0) → dawn → sky → noon (1), matching the
// stops of the app's CSS gradient (20%, 27%, 35%, 52%, 69%, 79%, 88%).
float skyRamp(float h) {
  float up = smoothstep(4.8, 6.5, h) + smoothstep(6.5, 8.4, h) + smoothstep(8.4, 12.5, h);
  float down = smoothstep(12.5, 16.6, h) + smoothstep(16.6, 19.0, h) + smoothstep(19.0, 21.1, h);
  return clamp((up - down) / 3.0, 0.0, 1.0);
}
`;

const FIELD = `${SKY}
float field(vec2 uv, vec2 res, float t) {
  float aspect = res.x / res.y;
  float h = skyHour(uv);
  float light = skyLight(h);
  // Light mode: darkness sets density. Dark mode: brightness does. The floor
  // keeps the brightest part of the sky dotted, so the strip never empties.
  float tone = mix(mix(0.3, 0.16, skyDark), 0.9, mix(1.0 - light, light, skyDark));

  // Long, low clouds drifting slowly to the right.
  vec2 p = vec2(uv.x * aspect * 0.45, uv.y * 1.6);
  tone += (fbm(p + vec2(-t * 0.06, t * 0.01)) - 0.5) * 0.34;

  // The current time breathes: the sky there brightens a little, slowly.
  if (skyNow >= 0.0) {
    float dx = (uv.x - skyNow) * aspect;
    float glow = exp(-dx * dx * 0.08) * (0.65 + 0.35 * sin(t * 0.7));
    tone += mix(-0.12, 0.2, skyDark) * glow;
  }
  return clamp(tone, 0.0, 1.0);
}
`;

const COLOR_FIELD = `
vec3 colorField(vec2 uv, vec2 res, float t) {
  vec3 c = paletteColor(skyRamp(skyHour(uv))).rgb;
  // Light paper: deepen the pale day colours so their dots still read.
  return mix(c, c * 0.62, (1.0 - skyDark) * skyLight(skyHour(uv)));
}
`;

export type SkyRibbonProps = Omit<
  DitherShaderProps,
  "field" | "colorField" | "uniforms" | "palette"
> & {
  /** Current time as a fraction of the day (0 to 1), or -1 when the day isn't today. */
  now?: number;
  /** Sunrise and sunset, in clock hours, for the day shown. */
  rise?: number;
  set?: number;
  /** Whether the page is in dark mode (flips which part of the sky is dense). */
  dark?: boolean;
};

export const SkyRibbon = ({ now = -1, rise = 6.6, set = 18.85, dark = false, matrix = "bayer4", ...props }: SkyRibbonProps) => (
  <DitherShader
    {...props}
    field={FIELD}
    colorField={COLOR_FIELD}
    // Paper is the app's faint surface tint, so the strip keeps its shape even
    // where dots are sparse; the rest is the sky ramp paletteColor() reads,
    // from the app's own light-dark() variables.
    palette={["--surface-2", "--night", "--dawn", "--sky", "--noon"]}
    matrix={matrix}
    speed={1}
    fps={24}
    stillTime={4}
    uniforms={{ skyNow: now, skyRise: rise, skySet: set, skyDark: dark ? 1 : 0 }}
    // Until the first frame (or without WebGL) the ribbon's CSS gradient shows.
    fallback={null}
  />
);
