// WebGL2 page processor: perspective warp + scan filters on the GPU.
//
//   source ─warp─► page (full res) ─┬─blockmax→dilate→blur─► illumination (100px long edge)
//                                   ├─stats readback (200px) ─► paper colour, black/white points, blank test
//                                   ├─local mean / deviation (240px, Sauvola for B&W + Ink)
//                                   └─final filter ─► canvas ─► JPEG / 1-bit PNG
//
// One context for the whole app, one job at a time (see `job`).

import { homography, rotateQuad, quadSize, snapAspect } from './geometry.js';

const VS = `#version 300 es
in vec2 a_pos;
uniform float u_flip;
out vec2 v_uv;
void main() {
  vec2 uv = a_pos * 0.5 + 0.5;
  v_uv = vec2(uv.x, u_flip > 0.5 ? 1.0 - uv.y : uv.y);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
const vec3 LW = vec3(0.299, 0.587, 0.114);
float lum(vec3 c) { return dot(c, LW); }
`;

const FS_WARP = HEAD + `
uniform sampler2D u_src;
uniform mat3 u_H;
void main() {
  vec3 p = u_H * vec3(v_uv, 1.0);
  o = vec4(texture(u_src, p.xy / p.z).rgb, 1.0);
}`;

// Brightest sample per block = local paper colour (text can't pull it down).
const FS_BLOCKMAX = HEAD + `
uniform sampler2D u_tex;
uniform vec2 u_block;
void main() {
  vec2 base = v_uv - u_block * 0.5;
  vec3 best = vec3(0.0); float bl = -1.0;
  for (int j = 0; j < 5; j++) for (int i = 0; i < 5; i++) {
    vec3 c = texture(u_tex, base + u_block * (vec2(float(i), float(j)) + 0.5) / 5.0).rgb;
    float l = lum(c);
    if (l > bl) { bl = l; best = c; }
  }
  o = vec4(best, 1.0);
}`;

const FS_DILATE = HEAD + `
uniform sampler2D u_tex;
uniform vec2 u_px;
void main() {
  vec3 best = vec3(0.0); float bl = -1.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec3 c = texture(u_tex, v_uv + vec2(float(i), float(j)) * u_px).rgb;
    float l = lum(c);
    if (l > bl) { bl = l; best = c; }
  }
  o = vec4(best, 1.0);
}`;

const FS_BLUR = HEAD + `
uniform sampler2D u_tex;
uniform vec2 u_dir;
void main() {
  vec4 s = texture(u_tex, v_uv) * 0.2270270270;
  s += (texture(u_tex, v_uv + u_dir) + texture(u_tex, v_uv - u_dir)) * 0.1945945946;
  s += (texture(u_tex, v_uv + 2.0 * u_dir) + texture(u_tex, v_uv - 2.0 * u_dir)) * 0.1216216216;
  s += (texture(u_tex, v_uv + 3.0 * u_dir) + texture(u_tex, v_uv - 3.0 * u_dir)) * 0.0540540541;
  s += (texture(u_tex, v_uv + 4.0 * u_dir) + texture(u_tex, v_uv - 4.0 * u_dir)) * 0.0162162162;
  o = s;
}`;

const NORM = `
uniform sampler2D u_warp;
uniform sampler2D u_bg;
uniform vec3 u_paper;
uniform float u_shadow;
uniform float u_black;
uniform float u_white;
vec3 norm(vec2 uv) {
  vec3 c = texture(u_warp, uv).rgb;
  vec3 b = u_shadow > 0.5 ? max(texture(u_bg, uv).rgb, u_paper * 0.5) : u_paper;
  vec3 n = c / max(b, vec3(0.03));
  return clamp((n - u_black) / max(u_white - u_black, 0.05), 0.0, 1.0);
}
`;

const FS_MEAN = HEAD + NORM + `
uniform vec2 u_block;
void main() {
  vec2 base = v_uv - u_block * 0.5;
  float s = 0.0;
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) s += lum(norm(base + u_block * (vec2(float(i), float(j)) + 0.5) / 4.0));
  o = vec4(s / 16.0, 0.0, 0.0, 1.0);
}`;

const FS_DEV = HEAD + NORM + `
uniform vec2 u_block;
uniform sampler2D u_m;
void main() {
  vec2 base = v_uv - u_block * 0.5;
  float m = texture(u_m, v_uv).r;
  float s = 0.0;
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) s += abs(lum(norm(base + u_block * (vec2(float(i), float(j)) + 0.5) / 4.0)) - m);
  o = vec4(min(1.0, s / 16.0 * 4.0), 0.0, 0.0, 1.0);
}`;

// mode: 0 original, 1 enhance, 2 gray, 3 b&w, 4 ink, 5 normalized (stats)
const FS_FINAL = HEAD + NORM + `
uniform int u_mode;
uniform vec3 u_wb;
uniform float u_gamma;
uniform float u_sat;
uniform float u_k;
uniform float u_guard;
uniform sampler2D u_m;
uniform sampler2D u_d;
uniform vec2 u_px;
uniform float u_edge;
void main() {
  // Page-edge cleanup: the outermost pixels straddle the paper boundary and read as a dark line.
  if (u_mode >= 1 && u_mode <= 4 && min(min(v_uv.x, 1.0 - v_uv.x) / u_px.x, min(v_uv.y, 1.0 - v_uv.y) / u_px.y) < u_edge) { o = vec4(1.0); return; }
  if (u_mode == 0) { o = vec4(clamp(texture(u_warp, v_uv).rgb * u_wb, 0.0, 1.0), 1.0); return; }
  if (u_mode == 5) { o = vec4(norm(v_uv), 1.0); return; }
  if (u_mode <= 2) {
    vec3 n = clamp(norm(v_uv) * 1.03, 0.0, 1.0);
    // Paper to white: compress highlights only, leave ink and colour alone.
    n = n + (1.0 - n) * smoothstep(0.7, 0.93, lum(n));
    n = pow(n, vec3(u_gamma));
    float l = lum(n);
    if (u_mode == 1) o = vec4(clamp(mix(vec3(l), n, u_sat), 0.0, 1.0), 1.0);
    else o = vec4(vec3(l), 1.0);
    return;
  }
  float L = (2.0 * lum(norm(v_uv))
    + lum(norm(v_uv + vec2(u_px.x, 0.0))) + lum(norm(v_uv - vec2(u_px.x, 0.0)))
    + lum(norm(v_uv + vec2(0.0, u_px.y))) + lum(norm(v_uv - vec2(0.0, u_px.y)))) / 6.0;
  float M = texture(u_m, v_uv).r;
  float D = texture(u_d, v_uv).r * 0.25;
  float T = M * (1.0 + u_k * (D * 1.25 / 0.5 - 1.0));
  float b = L < 0.22 ? 0.0 : ((L > T || L > u_guard) ? 1.0 : 0.0);
  o = vec4(vec3(b), 1.0);
}`;

const FILTERS = {
  original: { mode: 0 },
  enhance: { mode: 1, gamma: 1.12, sat: 1.18 },
  gray: { mode: 2, gamma: 1.08, sat: 0 },
  bw: { mode: 3, k: 0.2, guard: 0.9 },
  ink: { mode: 4, k: 0.07, guard: 0.975 },
};
export const FILTER_KEYS = ['original', 'enhance', 'bw', 'gray', 'ink'];
export const isBitonal = (f) => f === 'bw' || f === 'ink';

class Processor {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = 1;
    const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    this.lost = false;
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const vs = this.shader(gl.VERTEX_SHADER, VS);
    this.p = {};
    for (const [k, src] of Object.entries({ warp: FS_WARP, blockmax: FS_BLOCKMAX, dilate: FS_DILATE, blur: FS_BLUR, mean: FS_MEAN, dev: FS_DEV, final: FS_FINAL })) {
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, this.shader(gl.FRAGMENT_SHADER, src));
      gl.bindAttribLocation(prog, 0, 'a_pos');
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      prog.loc = {};
      this.p[k] = prog;
    }
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    this.src = null; // { key, tex, w, h }
    this.warpCache = null; // { key, t }
  }

  shader(type, src) {
    const gl = this.gl;
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  target(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE7); // scratch unit: never sampled, so no feedback loops
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { tex, fb, w, h };
  }

  free(t) {
    if (!t) return;
    this.gl.deleteFramebuffer(t.fb);
    this.gl.deleteTexture(t.tex);
  }

  setSource(key, image, w, h) {
    const gl = this.gl;
    if (this.src && this.src.key === key) return this.src;
    if (this.src) gl.deleteTexture(this.src.tex);
    this.src = null;
    if (this.warpCache) { this.free(this.warpCache.t); this.warpCache = null; }
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.src = { key, tex, w, h };
    return this.src;
  }

  releaseWarp() {
    if (this.warpCache) { this.free(this.warpCache.t); this.warpCache = null; }
  }

  dropSource() {
    if (this.src) this.gl.deleteTexture(this.src.tex);
    this.src = null;
    if (this.warpCache) { this.free(this.warpCache.t); this.warpCache = null; }
  }

  use(name) {
    const gl = this.gl;
    const prog = this.p[name];
    // Clear every unit a program might sample so a stale binding can't alias the render target.
    for (let u = 0; u < 4; u++) { gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, null); }
    gl.useProgram(prog);
    this.cur = prog;
    this.unit = 0;
    return this;
  }

  loc(name) {
    const p = this.cur;
    if (!(name in p.loc)) p.loc[name] = this.gl.getUniformLocation(p, name);
    return p.loc[name];
  }

  f(name, ...v) {
    const l = this.loc(name);
    if (l === null) return this;
    const gl = this.gl;
    if (v.length === 1) gl.uniform1f(l, v[0]);
    else if (v.length === 2) gl.uniform2f(l, v[0], v[1]);
    else gl.uniform3f(l, v[0], v[1], v[2]);
    return this;
  }

  i(name, v) { const l = this.loc(name); if (l !== null) this.gl.uniform1i(l, v); return this; }

  tex(name, tex) {
    const l = this.loc(name);
    if (l === null) return this;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + this.unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(l, this.unit++);
    return this;
  }

  draw(target, flip = false) {
    const gl = this.gl;
    this.f('u_flip', flip ? 1 : 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, target ? target.w : this.canvas.width, target ? target.h : this.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  read(target) {
    const gl = this.gl;
    const out = new Uint8Array(target.w * target.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    gl.readPixels(0, 0, target.w, target.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }

  // Render a page. Leaves the result on this.canvas (w x h). Returns stats.
  render({ quad, rotation = 0, filter = 'enhance', shadow = true, aspectLock = false, maxEdge = 2400 }) {
    const gl = this.gl;
    const src = this.src;
    const q = rotateQuad(quad, rotation);
    let { w, h } = quadSize(q, src.w, src.h);
    if (aspectLock) ({ w, h } = snapAspect(w, h));
    const scale = Math.min(1, maxEdge / Math.max(w, h), this.maxTex / Math.max(w, h));
    const W = Math.max(8, Math.round(w * scale)), H = Math.max(8, Math.round(h * scale));
    const F = FILTERS[filter] || FILTERS.enhance;

    // Homography: output unit square -> normalized source coords.
    const Hm = homography([[0, 0], [1, 0], [1, 1], [0, 1]], q.map(([x, y]) => [x / src.w, y / src.h]));
    const Hcol = new Float32Array([Hm[0], Hm[3], Hm[6], Hm[1], Hm[4], Hm[7], Hm[2], Hm[5], Hm[8]]);

    const small = (long) => (W >= H ? [long, Math.max(2, Math.round((long * H) / W))] : [Math.max(2, Math.round((long * W) / H)), long]);

    // 1. warp (cached while scrubbing filters on the same geometry)
    const wkey = `${src.key}|${q.flat().map((v) => v.toFixed(2)).join(',')}|${W}x${H}`;
    let warp;
    if (this.warpCache && this.warpCache.key === wkey) warp = this.warpCache.t;
    else {
      if (this.warpCache) this.free(this.warpCache.t);
      warp = this.target(W, H);
      this.use('warp').tex('u_src', src.tex);
      gl.uniformMatrix3fv(this.loc('u_H'), false, Hcol);
      this.draw(warp);
      this.warpCache = { key: wkey, t: warp };
    }

    // 2. paper colour from a small warp (mip-averaged)
    const [sw, sh] = small(200);
    const st = this.target(sw, sh);
    this.use('warp').tex('u_src', src.tex);
    gl.uniformMatrix3fv(this.loc('u_H'), false, Hcol);
    this.draw(st);
    const px = this.read(st);
    const paper = percentileRGB(px, 0.95);
    const pl = 0.299 * paper[0] + 0.587 * paper[1] + 0.114 * paper[2];
    const wb = paper.map((c) => Math.min(1.4, Math.max(0.7, pl / Math.max(0.05, c))));

    // 3. illumination field
    const [bw, bh] = small(100);
    const bA = this.target(bw, bh), bB = this.target(bw, bh);
    this.use('blockmax').tex('u_tex', warp.tex).f('u_block', 1 / bw, 1 / bh); this.draw(bA);
    this.use('dilate').tex('u_tex', bA.tex).f('u_px', 1 / bw, 1 / bh); this.draw(bB);
    this.use('blur').tex('u_tex', bB.tex).f('u_dir', 1 / bw * 0.6, 0); this.draw(bA);
    this.use('blur').tex('u_tex', bA.tex).f('u_dir', 0, 1 / bh * 0.6); this.draw(bB);

    const normU = (p, black, white) => p.tex('u_warp', warp.tex).tex('u_bg', bB.tex).f('u_paper', ...paper).f('u_shadow', shadow ? 1 : 0).f('u_black', black).f('u_white', white);

    // 4. stats on the normalized page: black/white points, blank detection
    normU(this.use('final'), 0, 1).i('u_mode', 5).f('u_px', 1 / sw, 1 / sh).f('u_edge', 0);
    this.draw(st);
    const npx = this.read(st);
    const { black, white, ink } = lumaStats(npx, sw, sh);

    // 5. local statistics for bitonal filters
    let mB = null, dB = null, mA = null, dA = null;
    if (F.mode >= 3) {
      const [mw, mh] = small(240);
      mA = this.target(mw, mh); mB = this.target(mw, mh); dA = this.target(mw, mh); dB = this.target(mw, mh);
      normU(this.use('mean'), black, white).f('u_block', 1 / mw, 1 / mh); this.draw(mA);
      this.use('blur').tex('u_tex', mA.tex).f('u_dir', 1 / mw * 0.5, 0); this.draw(mB);
      this.use('blur').tex('u_tex', mB.tex).f('u_dir', 0, 1 / mh * 0.5); this.draw(mA);
      normU(this.use('dev'), black, white).f('u_block', 1 / mw, 1 / mh).tex('u_m', mA.tex); this.draw(dA);
      this.use('blur').tex('u_tex', dA.tex).f('u_dir', 1 / mw * 0.5, 0); this.draw(dB);
      this.use('blur').tex('u_tex', dB.tex).f('u_dir', 0, 1 / mh * 0.5); this.draw(dA);
    }

    // 6. final
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    normU(this.use('final'), black, white)
      .i('u_mode', F.mode).f('u_wb', ...wb).f('u_gamma', F.gamma || 1).f('u_sat', F.sat ?? 1)
      .f('u_k', F.k || 0.2).f('u_guard', F.guard || 0.9).f('u_px', 1 / W, 1 / H)
      .f('u_edge', Math.max(1.5, Math.min(W, H) * 0.004))
      .tex('u_m', (mA || bB).tex).tex('u_d', (dA || bB).tex);
    this.draw(null, true);

    for (const t of [st, bA, bB, mA, mB, dA, dB]) this.free(t);
    return { w: W, h: H, blank: ink < 0.001, bitonal: F.mode >= 3 };
  }

  // Pack the current canvas into 1-bit rows (1 = white), top row first.
  readBits() {
    const gl = this.gl;
    const W = this.canvas.width, H = this.canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const stride = (W + 7) >> 3;
    const bits = new Uint8Array(stride * H);
    for (let y = 0; y < H; y++) {
      const src = (H - 1 - y) * W * 4; // framebuffer rows are bottom-up
      const dst = y * stride;
      for (let x = 0; x < W; x++) if (px[src + x * 4] > 127) bits[dst + (x >> 3)] |= 0x80 >> (x & 7);
    }
    return { bits, stride, w: W, h: H };
  }
}

function percentileRGB(px, p) {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const n = px.length / 4;
  for (let i = 0; i < px.length; i += 4) { hist[0][px[i]]++; hist[1][px[i + 1]]++; hist[2][px[i + 2]]++; }
  return hist.map((h) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += h[v]; if (acc >= n * p) return Math.max(0.08, v / 255); }
    return 1;
  });
}

function lumaStats(px, w, h) {
  const hist = new Uint32Array(256);
  let n = 0, dark = 0, inner = 0;
  const mx = Math.round(w * 0.06), my = Math.round(h * 0.06);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const l = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
      hist[l]++; n++;
      if (x >= mx && x < w - mx && y >= my && y < h - my) { inner++; if (l < 150) dark++; }
    }
  }
  const pct = (p) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * p) return v / 255; } return 1; };
  const black = Math.min(0.35, pct(0.005));
  const white = Math.max(black + 0.3, Math.min(1, pct(0.985) + 0.01));
  return { black, white, ink: inner ? dark / inner : 0 };
}

let proc = null;
let chain = Promise.resolve();

function get() {
  if (proc && (proc.lost || proc.gl.isContextLost())) proc = null;
  if (!proc) proc = new Processor();
  return proc;
}

// Serialize all GPU work. fn receives the processor and may await inside.
export function job(fn) {
  const run = chain.then(() => fn(get()));
  chain = run.catch(() => {});
  return run;
}

export function supported() {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
}
