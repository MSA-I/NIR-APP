/**
 * Liquid-aurora backdrop for the login panel: domain-warped value-noise fBm rendered with raw
 * WebGL2, colored at runtime from the chart tokens in index.css. Deliberately framework-free —
 * Login mounts it from a useEffect and owns nothing but the returned cleanup, so React (and any
 * animation library) stays out of this path entirely.
 */

type Cleanup = () => void;

const noop: Cleanup = () => {};

/**
 * The same ramp chartTheme() hands recharts, but destined for GPU floats: index.css stays the
 * single source of color truth and this module never states an RGB value of its own. Roles by
 * index: [0] deep oceanic body, [1] mid teal fold, [2] light teal highlight, [3] onyx anchor
 * (darkest), [4] near-white sheen — [2] and [4] are amplitude-capped in the shader because white
 * copy sits over this panel.
 */
const TOKENS = [
  '--color-chart-1',
  '--color-chart-2',
  '--color-chart-3',
  '--color-chart-4',
  '--color-chart-5',
] as const;

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/**
 * Painting each token through a scratch 2D canvas lets the browser do oklch → sRGB — the only
 * dependency-free conversion guaranteed to match what CSS itself renders. The bytes leave here
 * in linear light because a deep-teal → light-teal blend mixed in gamma space sags gray through
 * the middle; mixing linear (and converting back at the end of the fragment shader) is the main
 * quality lever of the whole effect.
 */
function readPaletteLinear(): Float32Array | null {
  const probe = document.createElement('canvas').getContext('2d');
  if (probe === null) return null;
  const css = getComputedStyle(document.documentElement);
  const palette = new Float32Array(TOKENS.length * 3);
  for (let i = 0; i < TOKENS.length; i += 1) {
    const value = css.getPropertyValue(TOKENS[i]).trim();
    // A missing token means the stylesheet this module answers to is not present; inventing a
    // color here would put a second source of truth in the repo, so the effect stands down.
    if (value === '') return null;
    probe.fillStyle = value;
    probe.fillRect(0, 0, 1, 1);
    const data = probe.getImageData(0, 0, 1, 1).data;
    palette[i * 3] = srgbToLinear(data[0] / 255);
    palette[i * 3 + 1] = srgbToLinear(data[1] / 255);
    palette[i * 3 + 2] = srgbToLinear(data[2] / 255);
  }
  return palette;
}

const VERTEX_SRC = `#version 300 es
// Fullscreen triangle straight from gl_VertexID: no vertex buffer exists in this module, so
// there is no geometry state to allocate, upload, or tear down.
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

const FRAGMENT_SRC = `#version 300 es
// highp throughout instead of the usual mediump: GLSL ES 3.00 mandates fragment highp, u_time
// grows unbounded on an idle login screen, and once the noise-lattice coordinates pass mediump's
// ~10-bit mantissa the field visibly contours. One soft-gradient pass leaves no meaningful cost
// for lower precision to win back.
precision highp float;

uniform vec2 u_res;
uniform float u_time;
uniform vec3 u_colors[5];

out vec4 outColor;

// Hash-based value noise: at this scale and drift speed gradient noise buys nothing visible,
// and the same hash doubles as the output dither source.
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(cell);
  float b = hash21(cell + vec2(1.0, 0.0));
  float c = hash21(cell + vec2(0.0, 1.0));
  float d = hash21(cell + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Three octaves: two reads as flat drifting fog, four adds a fine shimmer this panel must not
// have. Non-integer lacunarity plus a per-octave offset keeps the lattices from ever aligning.
float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 3; i += 1) {
    sum += amp * vnoise(p);
    p = p * 2.03 + vec2(17.13, 9.57);
    amp *= 0.5;
  }
  return sum / 0.875;
}

// Exact inverse of the JS-side srgbToLinear: mixing happened in linear light, quantization to
// the 8-bit backbuffer happens in sRGB.
vec3 linearToSrgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float aspect = u_res.x / u_res.y;
  vec2 p = vec2(uv.x * aspect, uv.y) * 1.8;
  // ~0.03 field-units/sec is the "takes half a minute to feel different" pacing; faster reads
  // as weather, not as a control room at rest.
  float t = u_time * 0.032;

  // Two warp passes are what makes the field fold into itself: one pass only drifts, a third
  // reads as churn.
  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - vec2(t * 0.6, 0.0)));
  vec2 r = vec2(
    fbm(p + 1.7 * q + vec2(1.7, 9.2) + vec2(t * 0.35, t * 0.1)),
    fbm(p + 1.7 * q + vec2(8.3, 2.8) - vec2(0.0, t * 0.25))
  );
  float f = fbm(p + 1.9 * r);

  // Weighted ramp: the panel's mass stays between the onyx anchor and the deep/mid oceanic
  // tokens. The light tokens never get full membership — white copy sits over the top-start
  // corner and the bottom edge, and the canvas must hold contrast on its own even before the
  // CSS scrim above it is counted.
  vec3 col = mix(u_colors[3], u_colors[0], smoothstep(0.06, 0.46, f));
  col = mix(col, u_colors[1], smoothstep(0.28, 0.72, f));

  // The bright lobe orbits the center/end of the panel. dir="rtl" puts "start" at uv.x = 1, so
  // the orbit lives in low-x mid-y territory, a corner guard zeroes whatever gaussian tail still
  // reaches top-start, and a bottom fade protects the copy anchored there. The two orbit periods
  // are incommensurate on purpose — the cycle never visibly repeats.
  vec2 lobeCenter = vec2(0.36 + 0.20 * cos(u_time * 0.21), 0.46 + 0.16 * sin(u_time * 0.13));
  vec2 away = (uv - lobeCenter) * vec2(aspect, 1.0);
  float lobe = exp(-4.0 * dot(away, away));
  float guard = 1.0 - smoothstep(0.55, 0.90, uv.x) * smoothstep(0.55, 0.90, uv.y);
  guard *= smoothstep(0.03, 0.22, uv.y);
  float sheen = lobe * guard;
  // Amplitudes set by measurement, not by eye. Method: hide the copy, screenshot the panel eight
  // times over 12.6s, take the brightest pixel inside each text element's own box. Result here is
  // rgb(68,105,109) = 6.02:1 under white and 5.6:1 under shell-ink — AA with margin. The first
  // pass measured 11.7:1, which is not a win: against the reference it simply read as black.
  // chart-3 alone is 2.75:1 under white, which is why it can only ever arrive masked like this.
  col = mix(col, u_colors[2], 0.80 * sheen * smoothstep(0.42, 0.84, f));
  col = mix(col, u_colors[4], 0.34 * sheen * smoothstep(0.66, 0.94, f));

  vec3 srgb = linearToSrgb(clamp(col, 0.0, 1.0));
  // An 8-bit deep-teal ramp bands badly; half an LSB of hash dither breaks the contours while
  // staying invisible as noise.
  srgb += (hash21(gl_FragCoord.xy) - 0.5) / 255.0;
  outColor = vec4(srgb, 1.0);
}
`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (shader === null) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/**
 * Starts the aurora on the given canvas and returns its cleanup. Every failure path returns a
 * no-op instead of throwing: this is a decorative layer, and it is never allowed to take the
 * login screen down with it — the panel simply keeps its CSS background.
 */
export function startAurora(canvas: HTMLCanvasElement | null): Cleanup {
  if (canvas === null) return noop;
  // Capability-probe via typeof, never via getContext: jsdom has no WebGL and its getContext
  // stub logs a "Not implemented" error to the virtual console, which pollutes the vitest run.
  if (typeof WebGL2RenderingContext === 'undefined') return noop;
  try {
    return boot(canvas);
  } catch {
    // Whatever misbehaved (an exotic driver, a privacy extension stubbing canvas APIs), the
    // caller still gets a working cleanup.
    return noop;
  }
}

// Split from startAurora so the guards above narrow `canvas` once; strict TS does not carry a
// parameter's null-check into closures, and everything below lives in closures.
function boot(canvas: HTMLCanvasElement): Cleanup {
  const palette = readPaletteLinear();
  if (palette === null) return noop;

  const gl = canvas.getContext('webgl2', {
    antialias: false, // a full-screen gradient has no geometric edges to smooth
    alpha: false,
    powerPreference: 'low-power', // a login backdrop must never spin up a discrete GPU
  });
  if (gl === null) return noop;

  const vert = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
  const program = vert !== null && frag !== null ? gl.createProgram() : null;
  const vao = program !== null ? gl.createVertexArray() : null;
  let linked = false;
  if (vert !== null && frag !== null && program !== null && vao !== null) {
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    linked = gl.getProgramParameter(program, gl.LINK_STATUS) === true;
  }
  if (vert === null || frag === null || program === null || vao === null || !linked) {
    if (vao !== null) gl.deleteVertexArray(vao);
    if (program !== null) gl.deleteProgram(program);
    if (frag !== null) gl.deleteShader(frag);
    if (vert !== null) gl.deleteShader(vert);
    // `alpha: false` means an un-drawn buffer composites as opaque black, not as nothing — so a
    // canvas that will never be painted has to leave the stage entirely, or it hides the CSS
    // gradient underneath it and the panel reads as a black rectangle.
    canvas.hidden = true;
    return noop;
  }

  gl.useProgram(program);
  gl.bindVertexArray(vao);
  gl.uniform3fv(gl.getUniformLocation(program, 'u_colors'), palette);
  const resLoc = gl.getUniformLocation(program, 'u_res');
  const timeLoc = gl.getUniformLocation(program, 'u_time');

  let sized = false;
  let time = 0;
  let last: number | null = null;
  let raf = 0;
  let disposed = false;

  const resize = (): void => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
      sized = false;
      return;
    }
    // Fill cost grows with dpr²; past these caps the extra pixels are invisible in a soft
    // gradient but very visible in a phone's power budget.
    const dpr = Math.min(window.devicePixelRatio || 1, window.innerWidth < 1024 ? 1.5 : 2);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.uniform2f(resLoc, width, height);
    sized = true;
  };

  const renderFrame = (): void => {
    if (!sized || disposed) return;
    gl.uniform1f(timeLoc, time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const tick = (timestamp: number): void => {
    raf = 0;
    // Same reasoning as the dpr cap: below the tablet breakpoint, half the frames buy nothing a
    // slow soft field can show. The -1ms forgives scheduler jitter so a 60Hz display is not
    // accidentally halved.
    const interval = window.innerWidth < 1024 ? 1000 / 30 : 1000 / 60;
    if (last === null) last = timestamp - interval;
    const elapsed = timestamp - last;
    if (elapsed < interval - 1) {
      raf = requestAnimationFrame(tick);
      return;
    }
    last = timestamp - (elapsed % interval);
    // Own clock from clamped deltas: raw performance.now() would teleport the field after a
    // debugger pause or tab restore instead of letting it resume mid-fold.
    time += Math.min(elapsed, 100) / 1000;
    renderFrame();
    raf = requestAnimationFrame(tick);
  };

  const startLoop = (): void => {
    if (disposed || raf !== 0) return;
    last = null;
    raf = requestAnimationFrame(tick);
  };

  const stopLoop = (): void => {
    if (raf !== 0) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };

  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Doubles as the initializer. Reduced motion means exactly one still frame at t=0 — the
  // composition is safe standing still — and the OS toggle starts/stops the loop live.
  const onMotionChange = (): void => {
    if (motion.matches) {
      stopLoop();
      time = 0;
      renderFrame();
    } else if (!document.hidden) {
      startLoop();
    }
  };

  const onVisibility = (): void => {
    if (document.hidden) stopLoop();
    else if (!motion.matches) startLoop();
  };

  const observer = new ResizeObserver(() => {
    resize();
    // Resizing the drawing buffer clears it; repaint at once so the reduced-motion still frame
    // (and the first laid-out frame) never sit black waiting for a loop that may not be running.
    renderFrame();
  });

  // A driver-side loss is unrecoverable for this canvas, so hand the panel back to CSS rather
  // than leave an opaque-black `alpha: false` buffer sitting over the gradient.
  const onContextLost = (event: Event): void => {
    event.preventDefault();
    stopLoop();
    sized = false;
    canvas.hidden = true;
  };

  resize();
  observer.observe(canvas);
  canvas.addEventListener('webglcontextlost', onContextLost);
  motion.addEventListener('change', onMotionChange);
  document.addEventListener('visibilitychange', onVisibility);
  onMotionChange();

  return () => {
    if (disposed) return;
    disposed = true;
    stopLoop();
    observer.disconnect();
    canvas.removeEventListener('webglcontextlost', onContextLost);
    motion.removeEventListener('change', onMotionChange);
    document.removeEventListener('visibilitychange', onVisibility);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(program);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    // Deliberately NOT WEBGL_lose_context: a canvas element outlives this effect. React 19's
    // StrictMode mounts, unmounts and remounts every effect against the SAME DOM node, and a
    // lost context is lost for good — getContext('webgl2') on the second mount hands back the
    // dead one, which paints the panel white. Measured, not theorised: contextLost === true and
    // drawingBuffer 0×0 on a live dev page before this line came out. The GPU allocation is
    // released when the detached canvas is collected, which is what every other unmount relies
    // on anyway.
  };
}
