'use strict';

/* ChartGrid — Finviz 风格期货图表网格
 *
 * 本文件只负责「渲染 + 交互」。
 * 所有指标数学与周期聚合都在 indicators.js（纯函数、无 DOM 依赖），
 * 浏览器与 CI 共用同一份实现，避免口径漂移。
 *
 * 每个分组 tab 上显示该组的「整体技术评估」= 组内各品种 assess() 分数的均值。
 */
/* ============================ 指标模块 ============================ */

import {
  ema, sma, cascadeEMA, smaOfSma, twoPoleMA,
  wma, hma, dema, tema, zlema, kama, jma,
  bollinger, macdCalc, rsiCalc, tdSetup,
  resample, decimalsFor,
  assess, assessLabel,
} from './indicators.js';
/* ============================ 配置 ============================ */

const state = {
  manifest: null,
  groups: [],
  activeGroup: 'All',
  period: 50,
  method: 'cascade',
  bars: 130,
  timeframe: 'D',
  ind: { ma: true, boll: true, macd: true, rsi: false, td: true },
  bollN: 20, bollK: 2,
  macdFast: 12, macdSlow: 26, macdSig: 9,
  rsiN: 14,
};

const PALETTE = {
  up: '#26a69a',
  down: '#ef5350',
  ma: '#f0b90b',
  bollMid: '#7f8fa6',
  bollBand: 'rgba(126,143,166,0.50)',
  bollFill: 'rgba(126,143,166,0.09)',
  macdLine: '#3d7eff',
  macdSig: '#f0b90b',
  rsi: '#b388ff',
  tdBuy: '#ffb74d',
  tdSell: '#64b5f6',
  grid: 'rgba(255,255,255,0.055)',
  axis: 'rgba(255,255,255,0.42)',
  bg: '#131722',
  dim: '#8a93a6',
};

const TF_LABEL = { D: '日线', W: '周线', M: '月线', Q: '季线' };

const MA_LABEL = {
  cascade: '级联EMA', smasma: 'SMA2', sma: 'SMA', ema: 'EMA',
  wma: 'WMA', hma: 'HMA', dema: 'DEMA', tema: 'TEMA',
  zlema: 'ZLEMA', kama: 'KAMA', jma: 'JMA',
};

/* ============================ 工具 ============================ */

const nf = (v, d) => (v == null || Number.isNaN(v) ? '-' : Number(v).toFixed(d));

/** 取切片，供渲染用。 */
function tail(arr, s, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = arr[s + i];
  return out;
}

/* ============================ 卡片绘制 ============================ */

function drawEmpty(canvas, msg) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 324;
  const h = canvas.clientHeight || 200;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = PALETTE.dim;
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(msg, w / 2, h / 2);
}

function drawCard(card) {
  const canvas = card.querySelector('canvas');
  if (!canvas) return;
  const raw = card._data;
  if (!raw || !raw.dates || !raw.dates.length) { drawEmpty(canvas, '无数据'); return; }

  let rs = card._rs;
  if (!rs || rs.tf !== state.timeframe) {
    rs = card._rs = { tf: state.timeframe, data: resample(raw, state.timeframe) };
  }
  const d = rs.data;
  const total = d.c.length;
  if (!total) { drawEmpty(canvas, '无数据'); return; }
  const n = Math.min(state.bars, total);
  const s = total - n;

  const o = tail(d.o, s, n), h = tail(d.h, s, n);
  const l = tail(d.l, s, n), c = tail(d.c, s, n);

  const ind = state.ind;
  const maFull = twoPoleMA(d.c, state.period, state.method);
  const ma = tail(maFull, s, n);

  let bo = null;
  if (ind.boll) {
    const b = bollinger(d.c, state.bollN, state.bollK);
    bo = { mid: tail(b.mid, s, n), up: tail(b.up, s, n), low: tail(b.low, s, n) };
  }
  let mc = null;
  if (ind.macd) {
    const m = macdCalc(d.c, state.macdFast, state.macdSlow, state.macdSig);
    mc = { line: tail(m.line, s, n), signal: tail(m.signal, s, n), hist: tail(m.hist, s, n) };
  }
  let rsi = null;
  if (ind.rsi) rsi = tail(rsiCalc(d.c, state.rsiN), s, n);

  let td = null;
  if (ind.td) {
    const t = tdSetup(d.c);
    td = { buy: tail(t.buy, s, n), sell: tail(t.sell, s, n) };
  }

  /* ---- 画布与布局 ---- */
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, cssW, cssH);

  const PAD_R = 46, PAD_L = 4, PAD_T = 6, PAD_B = 14, GAP = 12;
  const subs = [];
  if (mc) subs.push('macd');
  if (rsi) subs.push('rsi');

  const availH = cssH - PAD_T - PAD_B - GAP * subs.length;
  let priceH = availH;
  let subH = 0;
  if (subs.length === 1) { priceH = availH * 0.66; subH = availH - priceH; }
  else if (subs.length === 2) { priceH = availH * 0.50; subH = (availH - priceH) / 2; }

  const plotW = cssW - PAD_L - PAD_R;
  const x = (i) => PAD_L + (plotW * (i + 0.5)) / n;

  /* ---- 价格区范围 ---- */
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    if (l[i] < lo) lo = l[i];
    if (h[i] > hi) hi = h[i];
    const m = ma[i];
    if (!Number.isNaN(m)) { if (m < lo) lo = m; if (m > hi) hi = m; }
    if (bo) for (const b of [bo.up[i], bo.low[i]]) {
      if (!Number.isNaN(b)) { if (b < lo) lo = b; if (b > hi) hi = b; }
    }
  }
  if (!isFinite(lo) || !isFinite(hi)) { drawEmpty(canvas, '数据异常'); return; }
  if (hi === lo) { hi += 1; lo -= 1; }
  const padP = (hi - lo) * 0.06;
  lo -= padP; hi += padP;

  const priceTop = PAD_T;
  const priceBot = PAD_T + priceH;
  const yP = (p) => priceTop + priceH * (1 - (p - lo) / (hi - lo));

  const dec = decimalsFor(c[0]);
  ctx.font = '9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';

  /* ---- 价格网格与右侧轴 ---- */
  for (let i = 0; i <= 3; i++) {
    const p = lo + ((hi - lo) * i) / 3;
    const yy = yP(p);
    ctx.strokeStyle = PALETTE.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD_L, yy);
    ctx.lineTo(PAD_L + plotW, yy);
    ctx.stroke();
    ctx.fillStyle = PALETTE.axis;
    ctx.textAlign = 'left';
    ctx.fillText(nf(p, dec), PAD_L + plotW + 5, yy);
  }

  /* ---- BOLL 通道（先画，压在 K 线下层） ---- */
  if (bo) {
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const v = bo.up[i];
      if (Number.isNaN(v)) continue;
      if (!started) { ctx.moveTo(x(i), yP(v)); started = true; } else ctx.lineTo(x(i), yP(v));
    }
    for (let i = n - 1; i >= 0; i--) {
      const v = bo.low[i];
      if (Number.isNaN(v)) continue;
      ctx.lineTo(x(i), yP(v));
    }
    ctx.closePath();
    ctx.fillStyle = PALETTE.bollFill;
    ctx.fill();

    ctx.lineWidth = 1;
    for (const arr of [bo.up, bo.low]) {
      ctx.strokeStyle = PALETTE.bollBand;
      ctx.beginPath();
      let st = false;
      for (let i = 0; i < n; i++) {
        const v = arr[i];
        if (Number.isNaN(v)) { st = false; continue; }
        if (!st) { ctx.moveTo(x(i), yP(v)); st = true; } else ctx.lineTo(x(i), yP(v));
      }
      ctx.stroke();
    }
    ctx.strokeStyle = PALETTE.bollMid;
    ctx.beginPath();
    let st2 = false;
    for (let i = 0; i < n; i++) {
      const v = bo.mid[i];
      if (Number.isNaN(v)) { st2 = false; continue; }
      if (!st2) { ctx.moveTo(x(i), yP(v)); st2 = true; } else ctx.lineTo(x(i), yP(v));
    }
    ctx.stroke();
  }

  /* ---- K 线 ---- */
  const cw = Math.max(1.4, (plotW / n) * 0.62);
  for (let i = 0; i < n; i++) {
    const up = c[i] >= o[i];
    ctx.strokeStyle = up ? PALETTE.up : PALETTE.down;
    ctx.fillStyle = up ? PALETTE.up : PALETTE.down;
    const cx = x(i);
    ctx.lineWidth = Math.max(1, cw * 0.16);
    ctx.beginPath();
    ctx.moveTo(cx, yP(h[i]));
    ctx.lineTo(cx, yP(l[i]));
    ctx.stroke();
    const y1 = yP(o[i]), y2 = yP(c[i]);
    const top = Math.min(y1, y2);
    const hgt = Math.max(1, Math.abs(y2 - y1));
    ctx.fillRect(cx - cw / 2, top, cw, hgt);
  }

  /* ---- 两极均线 ---- */
  if (ind.ma) {
    ctx.strokeStyle = PALETTE.ma;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const v = ma[i];
      if (Number.isNaN(v)) { started = false; continue; }
      if (!started) { ctx.moveTo(x(i), yP(v)); started = true; } else ctx.lineTo(x(i), yP(v));
    }
    ctx.stroke();
  }

  /* ---- TD Setup 9 标记 ---- */
  if (td) {
    // 密度自适应：格子够宽才画 1-8 的过程计数，否则只画完成的 9
    const showAll = cw >= 6.5;
    ctx.textAlign = 'center';
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    for (let i = 0; i < n; i++) {
      const bv = td.buy[i];
      const sv = td.sell[i];
      if (!bv && !sv) continue;
      const isBuy = bv > 0;
      const cnt = isBuy ? bv : sv;
      if (!showAll && cnt < 9) continue;
      const cx = x(i);
      const yy = isBuy ? yP(l[i]) + 9 : yP(h[i]) - 9;
      if (cnt >= 9) {
        ctx.beginPath();
        ctx.arc(cx, yy, 6, 0, Math.PI * 2);
        ctx.fillStyle = isBuy ? 'rgba(255,183,77,0.18)' : 'rgba(100,181,246,0.18)';
        ctx.fill();
        ctx.strokeStyle = isBuy ? PALETTE.tdBuy : PALETTE.tdSell;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.fillStyle = isBuy ? PALETTE.tdBuy : PALETTE.tdSell;
      ctx.fillText(String(cnt), cx, yy);
    }
  }

  /* ---- 子图 ---- */
  let cursor = priceBot;
  let macdView = null;
  let rsiView = null;

  for (const kind of subs) {
    const top = cursor + GAP;
    const bot = top + subH;
    cursor = bot;

    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD_L, top);
    ctx.lineTo(PAD_L + plotW, top);
    ctx.stroke();

    if (kind === 'macd') {
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < n; i++) {
        for (const v of [mc.line[i], mc.signal[i], mc.hist[i]]) {
          if (Number.isNaN(v)) continue;
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
      }
      if (!isFinite(mn)) { mn = -1; mx = 1; }
      if (mx === mn) { mx += 1; mn -= 1; }
      const yM = (v) => top + subH * (1 - (v - mn) / (mx - mn));
      const zero = yM(0);
      ctx.strokeStyle = PALETTE.grid;
      ctx.beginPath();
      ctx.moveTo(PAD_L, zero);
      ctx.lineTo(PAD_L + plotW, zero);
      ctx.stroke();

      for (let i = 0; i < n; i++) {
        const v = mc.hist[i];
        if (Number.isNaN(v)) continue;
        const yy = yM(v);
        ctx.fillStyle = v >= 0 ? 'rgba(38,166,154,0.62)' : 'rgba(239,83,80,0.62)';
        const hh = Math.max(1, Math.abs(zero - yy));
        ctx.fillRect(x(i) - cw / 2, Math.min(zero, yy), cw, hh);
      }
      ctx.lineWidth = 1.2;
      for (const pair of [[mc.line, PALETTE.macdLine], [mc.signal, PALETTE.macdSig]]) {
        const arr = pair[0];
        ctx.strokeStyle = pair[1];
        ctx.beginPath();
        let st = false;
        for (let i = 0; i < n; i++) {
          const v = arr[i];
          if (Number.isNaN(v)) { st = false; continue; }
          if (!st) { ctx.moveTo(x(i), yM(v)); st = true; } else ctx.lineTo(x(i), yM(v));
        }
        ctx.stroke();
      }
      ctx.fillStyle = PALETTE.macdLine;
      ctx.textAlign = 'left';
      ctx.fillText('MACD', PAD_L + 2, top + 6);
      ctx.fillStyle = PALETTE.axis;
      ctx.fillText(nf(mx, 2), PAD_L + plotW + 5, top + 6);
      ctx.fillText(nf(mn, 2), PAD_L + plotW + 5, bot - 4);
      macdView = { y: yM, mn, mx };
    }

    if (kind === 'rsi') {
      const yR = (v) => top + subH * (1 - v / 100);
      for (const lv of [30, 50, 70]) {
        ctx.strokeStyle = lv === 50 ? PALETTE.grid : 'rgba(255,255,255,0.14)';
        ctx.setLineDash(lv === 50 ? [] : [3, 3]);
        ctx.beginPath();
        ctx.moveTo(PAD_L, yR(lv));
        ctx.lineTo(PAD_L + plotW, yR(lv));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = PALETTE.axis;
        ctx.textAlign = 'left';
        ctx.fillText(String(lv), PAD_L + plotW + 5, yR(lv));
      }
      ctx.strokeStyle = PALETTE.rsi;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let st = false;
      for (let i = 0; i < n; i++) {
        const v = rsi[i];
        if (Number.isNaN(v)) { st = false; continue; }
        if (!st) { ctx.moveTo(x(i), yR(v)); st = true; } else ctx.lineTo(x(i), yR(v));
      }
      ctx.stroke();
      ctx.fillStyle = PALETTE.rsi;
      ctx.textAlign = 'left';
      ctx.fillText('RSI(' + state.rsiN + ')', PAD_L + 2, top + 6);
      rsiView = { y: yR };
    }
  }

  // 整体技术评估：在「整段聚合后序列」上算，不受显示根数影响
  card._assess = assess(d, { period: state.period, method: state.method });

  card._view = { n, s, dec, o, h, l, c, ma, bo, mc, rsi, td, macdView, rsiView, dates: d.dates };
}

/* ============================ 卡片 DOM ============================ */

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
  if (!v) return;
  const canvas = card.querySelector('canvas');
  const rect = canvas.getBoundingClientRect();
  const PAD_L = 4, PAD_R = 46;
  const plotW = rect.width - PAD_L - PAD_R;
  const rel = (ev.clientX - rect.left - PAD_L) / plotW;
  if (rel < 0 || rel > 1) return;
  const i = Math.min(v.n - 1, Math.max(0, Math.floor(rel * v.n)));
  const gi = v.s + i;
  const dec = v.dec;

  const lines = ['<b>' + v.dates[gi] + '</b>'];
  lines.push(
    '<span>O ' + nf(v.o[i], dec) + '</span>' +
    '<span>H ' + nf(v.h[i], dec) + '</span>' +
    '<span>L ' + nf(v.l[i], dec) + '</span>' +
    '<span>C ' + nf(v.c[i], dec) + '</span>'
  );
  if (state.ind.ma) {
    lines.push('<span class="ma">MA ' + nf(v.ma[i], dec) + '</span>');
  }
  if (v.bo) {
    lines.push('<span class="boll">BOLL ' + nf(v.bo.mid[i], dec) +
      ' / ' + nf(v.bo.up[i], dec) + ' / ' + nf(v.bo.low[i], dec) + '</span>');
  }
  if (v.mc) {
    lines.push('<span>MACD ' + nf(v.mc.line[i], 2) +
      ' SIG ' + nf(v.mc.signal[i], 2) +
      ' H ' + nf(v.mc.hist[i], 2) + '</span>');
  }
  if (v.rsi) {
    lines.push('<span>RSI ' + nf(v.rsi[i], 1) + '</span>');
  }

  if (v.td) {
    const bv = v.td.buy[i];
    const sv = v.td.sell[i];
    if (bv || sv) {
      lines.push('<span class="td">TD9 ' + (bv ? 'Buy ' + bv : 'Sell ' + sv) + '</span>');
    }
  }

  const tip = card.querySelector('.tip');
  tip.innerHTML = lines.join('');
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

  renderTabs();
  updateFooter();
}

/* ============================ 交互 ============================ */

/**
 * 按分组汇总整体技术评估：组内各品种 assess() 分数取算术平均。
 * All 组同时统计，所以 All 的分数是全市场平均，不是各组再平均。
 */
function groupScores() {
  const grid = document.getElementById('grid');
  const acc = {};
  if (!grid) return {};
  for (const el of grid.children) {
    if (!el._inst) continue;
    const a = el._assess;
    if (!a) continue;
    const g = el._inst.group;
    const keys = ['All'];
    if (g && g !== 'All') keys.push(g);
    for (const k of keys) {
      const s = acc[k] || (acc[k] = { sum: 0, n: 0 });
      s.sum += a.score;
      s.n += 1;
    }
  }
  const out = {};
  for (const k in acc) out[k] = { score: Math.round(acc[k].sum / acc[k].n), n: acc[k].n };
  return out;
}

function toneOf(score) {
  if (score >= 20) return 'bull';
  if (score <= -20) return 'bear';
  return 'flat';
}

function renderTabs() {
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = '';
  const scores = groupScores();
  state.groups.forEach((g) => {
    const b = document.createElement('button');
    b.className = 'tab' + (g === state.activeGroup ? ' on' : '');
    const sc = scores[g];
    let badge;
    if (sc && sc.n > 0) {
      badge = '<span class="tab-ass" data-tone="' + toneOf(sc.score) + '"' +
        ' title="组内 ' + sc.n + ' 个品种的评估均值">' +
        (sc.score > 0 ? '+' : '') + sc.score + ' ' + assessLabel(sc.score) + '</span>';
    } else {
      badge = '<span class="tab-ass" data-tone="na">-</span>';
    }
    b.innerHTML = '<span class="tab-name">' + g + '</span>' + badge;
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
  renderTabs();
}

function updateFooter(shown) {
  const f = document.getElementById('foot-info');
  if (!f) return;
  const m = state.manifest || {};
  const total = (m.instruments || []).filter((i) => i.status === 'ok').length;
  const n = shown == null ? total : shown;
  const keys = ['ma', 'boll', 'macd', 'rsi', 'td'];
  const names = ['均线', 'BOLL', 'MACD', 'RSI', 'TD9'];
  const inds = names.filter((_, idx) => state.ind[keys[idx]]);
  f.textContent =
    n + ' / ' + total + ' 个品种 · ' + (TF_LABEL[state.timeframe] || '日线') +
    ' · 均线 ' + state.period + ' ' + (MA_LABEL[state.method] || '级联EMA') +
    ' · 指标 ' + (inds.length ? inds.join('+') : '无') +
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
  const tf = document.getElementById('tf');

  period.value = state.period;
  method.value = state.method;
  bars.value = state.bars;
  tf.value = state.timeframe;

  ['ma', 'boll', 'macd', 'rsi', 'td'].forEach((k) => {
    const cb = document.getElementById('ind-' + k);
    if (cb) cb.checked = !!state.ind[k];
  });

  const readForm = () => {
    const p = parseInt(period.value, 10);
    const b = parseInt(bars.value, 10);
    state.period = Number.isFinite(p) ? Math.min(400, Math.max(2, p)) : 20;
    state.bars = Number.isFinite(b) ? Math.min(500, Math.max(20, b)) : 130;
    state.method = method.value;
    state.timeframe = tf.value;
    ['ma', 'boll', 'macd', 'rsi', 'td'].forEach((k) => {
      const cb = document.getElementById('ind-' + k);
      if (cb) state.ind[k] = cb.checked;
    });
    period.value = state.period;
    bars.value = state.bars;
  };

  const apply = () => {
    readForm();
    resizeHeights();
    redrawAll();
    updateFooter();
  };

  document.getElementById('apply').onclick = apply;
  [period, bars].forEach((el) => el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') apply();
  }));
  tf.addEventListener('change', apply);
  method.addEventListener('change', apply);
  ['ma', 'boll', 'macd', 'rsi', 'td'].forEach((k) => {
    const cb = document.getElementById('ind-' + k);
    if (cb) cb.addEventListener('change', apply);
  });

  window.addEventListener('resize', debounce(() => { resizeHeights(); redrawAll(); }, 160));
}

/** 有子图时卡片更高，给 MACD/RSI 留出空间。 */
function resizeHeights() {
  const grid = document.getElementById('grid');
  if (!grid) return;
  const subs = (state.ind.macd ? 1 : 0) + (state.ind.rsi ? 1 : 0);
  const ratio = subs === 2 ? '324 / 300' : subs === 1 ? '324 / 250' : '324 / 200';
  for (const el of grid.children) {
    const w = el.querySelector('.cv-wrap');
    if (w) w.style.aspectRatio = ratio;
  }
}

/* ============================ 启动 ============================ */

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    wireControls();
    resizeHeights();
    loadAll().catch((e) => {
      document.getElementById('grid').innerHTML =
        '<div class="empty">加载 manifest 失败：' + e.message + '</div>';
    });
  });
}
