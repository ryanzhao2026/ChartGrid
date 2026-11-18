/* ChartGrid — Finviz 风格期货图表网格 + Two-Pole Moving Average
 *
 * 均线定义（核心）
 * ---------------
 * 「两极（two-pole）」= 二阶递推低通：滤波器里有两个储能极点，等效于
 * 把同一个一阶平滑做两次级联。两条常用实现都提供，可在页面切换：
 *
 *   1) cascade  — 级联 EMA（默认）
 *        a = 2/(N+1)
 *        p1[i] = p1[i-1] + a*(x[i]  - p1[i-1])
 *        p2[i] = p2[i-1] + a*(p1[i] - p2[i-1])      <- 输出 p2
 *
 *   2) smasma   — SMA 的 SMA（双平滑）
 *        p1 = SMA(x, N)，p2 = SMA(p1, N)            <- 输出 p2
 *
 * 两者都是 DC 增益 = 1 的低通，对价格绝对水平无缩放，只改变相位滞后
 * 与平滑强度。二阶的等效滞后约为一阶的 2 倍，因此比同周期单 EMA 更平、
 * 拐点更晚，这也是很多人偏好它的原因。
 */

'use strict';

/* ============================ 均线实现 ============================ */

/** 级联 EMA：两级一阶级联 = 二阶 IIR 低通。DC 增益为 1。 */
function cascadeEMA(arr, n) {
  const len = arr.length;
  const out = new Float64Array(len);
  if (!len) return out;
  const N = Math.max(1, Math.floor(n));
  const a = 2 / (N + 1);
  let s1 = arr[0];
  let s2 = arr[0];
  out[0] = s2;
  for (let i = 1; i < len; i++) {
    s1 += a * (arr[i] - s1);
    s2 += a * (s1 - s2);
    out[i] = s2;
  }
  return out;
}

/** 单次滑动平均，前 N-1 个位置填 NaN。 */
function pulse(src, N, dst) {
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i];
    if (i >= N) sum -= src[i - N];
    dst[i] = i >= N - 1 ? sum / N : NaN;
  }
}

/** SMA 的 SMA：两次滑动平均级联，同样构成两极低通。 */
function smaOfSma(arr, n) {
  const len = arr.length;
  const N = Math.max(1, Math.floor(n));
  const p1 = new Float64Array(len);
  pulse(arr, N, p1);
  const out = new Float64Array(len);
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < len; i++) {
    const v = p1[i];
    if (!Number.isNaN(v)) { sum += v; cnt++; }
    if (cnt > N) { sum -= p1[i - N]; cnt--; }
    out[i] = cnt > 0 ? sum / cnt : NaN;
  }
  return out;
}

/** 统一入口：按方法名计算两极均线。 */
function twoPoleMA(values, period, method) {
  if (method === 'smasma') return smaOfSma(values, period);
  return cascadeEMA(values, period);
}

/* ============================ 配置 ============================ */

const state = {
  manifest: null,
  cache: new Map(),
  groups: [],
  activeGroup: 'All',
  period: 20,
  method: 'cascade',
  bars: 130,
};

const PALETTE = {
  up: '#26a69a',
  down: '#ef5350',
  ma: '#f0b90b',
  grid: 'rgba(255,255,255,0.055)',
  axis: 'rgba(255,255,255,0.42)',
  bg: '#131722',
  dim: '#8a93a6',
};

/* ============================ 工具 ============================ */

const nf = (v, d) => (v == null || Number.isNaN(v) ? '-' : Number(v).toFixed(d));

/** 价格小数位：按量级自适应 */
function decimalsFor(price) {
  const p = Math.abs(price);
  if (p >= 10000) return 0;
  if (p >= 1000) return 1;
  if (p >= 100) return 2;
  if (p >= 1) return 2;
  return 4;
}

/* ============================ 渲染 ============================ */

function drawCard(card) {
  const data = card._data;
  const canvas = card.querySelector('canvas');
  if (!canvas) return;
  if (!data || !data.dates || !data.dates.length) {
    drawEmpty(canvas, '无数据');
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (canvas.width !== Math.round(cssW * dpr) ||
      canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, cssW, cssH);

  const total = data.dates.length;
  const n = Math.min(state.bars, total);
  const s = total - n;

  const o = data.o.slice(s), h = data.h.slice(s);
  const l = data.l.slice(s), c = data.c.slice(s);

  const maFull = twoPoleMA(data.c, state.period, state.method);
  const ma = Array.from(maFull.slice(s));

  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    if (l[i] < lo) lo = l[i];
    if (h[i] > hi) hi = h[i];
    const m = ma[i];
    if (!Number.isNaN(m)) { if (m < lo) lo = m; if (m > hi) hi = m; }
  }
  if (!isFinite(lo) || !isFinite(hi)) { drawEmpty(canvas, '数据异常'); return; }
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.06;
  lo -= pad; hi += pad;

  const PAD_R = 46;
  const PAD_L = 4, PAD_T = 6, PAD_B = 14;
  const plotW = cssW - PAD_L - PAD_R;
  const plotH = cssH - PAD_T - PAD_B;
  const x = (i) => PAD_L + (plotW * (i + 0.5)) / n;
  const y = (p) => PAD_T + plotH * (1 - (p - lo) / (hi - lo));

  const dec = decimalsFor(c[0]);
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';
  const rows = 4;
  for (let i = 0; i <= rows; i++) {
    const p = lo + ((hi - lo) * i) / rows;
    const yy = y(p);
    ctx.strokeStyle = PALETTE.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD_L, yy);
    ctx.lineTo(PAD_L + plotW, yy);
    ctx.stroke();
    ctx.fillStyle = PALETTE.axis;
    ctx.textAlign = 'left';
    ctx.fillText(nf(p, dec), PAD_L + plotW + 6, yy);
  }

  const cw = Math.max(1.5, (plotW / n) * 0.62);
  for (let i = 0; i < n; i++) {
    const up = c[i] >= o[i];
    ctx.strokeStyle = up ? PALETTE.up : PALETTE.down;
    ctx.fillStyle = up ? PALETTE.up : PALETTE.down;
    const cx = x(i);
    ctx.lineWidth = Math.max(1, cw * 0.16);
    ctx.beginPath();
    ctx.moveTo(cx, y(h[i]));
    ctx.lineTo(cx, y(l[i]));
    ctx.stroke();
    const y1 = y(o[i]), y2 = y(c[i]);
    const top = Math.min(y1, y2);
    const hgt = Math.max(1, Math.abs(y2 - y1));
    ctx.fillRect(cx - cw / 2, top, cw, hgt);
  }

  ctx.strokeStyle = PALETTE.ma;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < n; i++) {
    const m = ma[i];
    if (Number.isNaN(m)) { started = false; continue; }
    const px = x(i), py = y(m);
    if (!started) { ctx.moveTo(px, py); started = true; }
    else ctx.lineTo(px, py);
  }
  ctx.stroke();

  const yLast = y(c[n - 1]);
  ctx.save();
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = 'rgba(255,255,255,0.20)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD_L, yLast);
  ctx.lineTo(PAD_L + plotW, yLast);
  ctx.stroke();
  ctx.restore();

  card._view = { n, s, dec, ma };
}

function drawEmpty(canvas, msg) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 324, hh = canvas.clientHeight || 200;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(hh * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, w, hh);
  ctx.fillStyle = PALETTE.dim;
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(msg, w / 2, hh / 2);
}

/* ============================ 卡片 ============================ */

function makeCard(inst) {
  const el = document.createElement('div');
  el.className = 'card';
  el._inst = inst;

  const last = inst.last;
  const dec = last != null ? decimalsFor(last) : 2;

  el.innerHTML =
    '<div class="card-head">' +
      '<div class="ttl">' +
        '<span class="name">' + inst.name + '</span>' +
        '<span class="sym">' + inst.key + '</span>' +
      '</div>' +
      '<div class="px">' +
        '<span class="last">' + (last != null ? nf(last, dec) : '-') + '</span>' +
        '<span class="chg" data-chg></span>' +
      '</div>' +
    '</div>' +
    '<div class="cv-wrap"><canvas></canvas></div>' +
    '<div class="tip" hidden></div>';

  const canvas = el.querySelector('canvas');
  canvas.addEventListener('mousemove', (ev) => onHover(el, ev));
  canvas.addEventListener('mouseleave', () => {
    const tip = el.querySelector('.tip');
    if (tip) tip.hidden = true;
  });

  return el;
}

function onHover(card, ev) {
  const v = card._view;
  const data = card._data;
  if (!v || !data) return;
  const canvas = card.querySelector('canvas');
  const rect = canvas.getBoundingClientRect();
  const PAD_R = 46, PAD_L = 4;
  const plotW = rect.width - PAD_L - PAD_R;
  const rel = (ev.clientX - rect.left - PAD_L) / plotW;
  if (rel < 0 || rel > 1) return;
  const i = Math.min(v.n - 1, Math.max(0, Math.floor(rel * v.n)));
  const gi = v.s + i;

  const tip = card.querySelector('.tip');
  const dec = v.dec;
  const m = v.ma[i];
  tip.innerHTML =
    '<b>' + data.dates[gi] + '</b>' +
    '<span>O ' + nf(data.o[gi], dec) + '</span>' +
    '<span>H ' + nf(data.h[gi], dec) + '</span>' +
    '<span>L ' + nf(data.l[gi], dec) + '</span>' +
    '<span>C ' + nf(data.c[gi], dec) + '</span>' +
    '<span class="ma">MA ' + (Number.isNaN(m) ? '-' : nf(m, dec)) + '</span>';
  tip.hidden = false;
}

/* ============================ 数据加载 ============================ */

async function loadJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
  return r.json();
}

async function loadAll() {
  const grid = document.getElementById('grid');
  const manifest = await loadJSON('data/manifest.json');
  state.manifest = manifest;

  const list = (manifest.instruments || []).filter((i) => i.status === 'ok');
  if (!list.length) {
    grid.innerHTML = '<div class="empty">manifest 里没有可用品种，请先运行 fetch_data.py</div>';
    return;
  }

  const groups = ['All'].concat(Array.from(new Set(list.map((i) => i.group))));
  state.groups = groups;
  renderTabs();

  const cards = list.map((inst) => {
    const el = makeCard(inst);
    grid.appendChild(el);
    return { el, inst };
  });
  applyFilter();

  const queue = cards.slice();
  const WORKERS = 6;
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (queue.length) {
      const job = queue.shift();
      if (!job) break;
      const el = job.el, inst = job.inst;
      try {
        const d = await loadJSON('data/' + inst.file);
        el._data = d;
        const n = d.c.length;
        if (n >= 2) {
          const prev = d.c[n - 2];
          const pc = ((d.c[n - 1] - prev) / prev) * 100;
          const chg = el.querySelector('[data-chg]');
          chg.textContent = (pc >= 0 ? '+' : '') + pc.toFixed(2) + '%';
          chg.classList.add(pc >= 0 ? 'up' : 'down');
        }
        drawCard(el);
      } catch (e) {
        el._data = null;
        drawEmpty(el.querySelector('canvas'), '加载失败');
      }
    }
  }));

  updateFooter();
}

/* ============================ 交互 ============================ */

function renderTabs() {
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = '';
  state.groups.forEach((g) => {
    const b = document.createElement('button');
    b.className = 'tab' + (g === state.activeGroup ? ' on' : '');
    b.textContent = g;
    b.onclick = () => {
      state.activeGroup = g;
      renderTabs();
      applyFilter();
    };
    tabs.appendChild(b);
  });
}

function applyFilter() {
  const grid = document.getElementById('grid');
  let shown = 0;
  for (const el of grid.children) {
    if (!el._inst) continue;
    const ok = state.activeGroup === 'All' || el._inst.group === state.activeGroup;
    el.style.display = ok ? '' : 'none';
    if (ok) shown++;
  }
  updateFooter(shown);
}

function redrawAll() {
  const grid = document.getElementById('grid');
  for (const el of grid.children) {
    if (el._inst && el._data) drawCard(el);
  }
}

function updateFooter(shown) {
  const f = document.getElementById('foot-info');
  if (!f) return;
  const m = state.manifest || {};
  const total = (m.instruments || []).filter((i) => i.status === 'ok').length;
  const n = shown == null ? total : shown;
  f.textContent =
    n + ' / ' + total + ' 个品种 · 均线 ' + state.period +
    (state.method === 'cascade' ? ' 级联EMA' : ' SMA2') +
    ' · 显示 ' + state.bars + ' 根 · 数据 ' + (m.generated_at || '-');
}

function debounce(fn, ms) {
  let t = 0;
  return function () {
    const a = arguments;
    clearTimeout(t);
    t = setTimeout(() => fn.apply(null, a), ms);
  };
}

function wireControls() {
  const period = document.getElementById('period');
  const method = document.getElementById('method');
  const bars = document.getElementById('bars');

  period.value = state.period;
  method.value = state.method;
  bars.value = state.bars;

  const apply = () => {
    const p = parseInt(period.value, 10);
    const b = parseInt(bars.value, 10);
    state.period = Number.isFinite(p) ? Math.min(400, Math.max(2, p)) : 20;
    state.bars = Number.isFinite(b) ? Math.min(500, Math.max(30, b)) : 130;
    state.method = method.value;
    period.value = state.period;
    bars.value = state.bars;
    redrawAll();
    updateFooter();
  };

  document.getElementById('apply').onclick = apply;
  [period, bars].forEach((el) => el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') apply();
  }));
  method.addEventListener('change', apply);

  window.addEventListener('resize', debounce(redrawAll, 180));
}

/* ============================ 启动 ============================ */

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    wireControls();
    loadAll().catch((e) => {
      document.getElementById('grid').innerHTML =
        '<div class="empty">加载 manifest 失败：' + e.message + '</div>';
    });
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { cascadeEMA, smaOfSma, twoPoleMA, decimalsFor };
}
