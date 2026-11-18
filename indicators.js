/**
 * ChartGrid — 指标与周期聚合（纯函数模块，不依赖 DOM）
 * ==================================================
 *
 * 这个文件只做数学：输入价格数组，输出数值数组。
 * 不引用 document / window，不读写全局状态，不产生副作用。
 * 因此浏览器（app.js）与 Node（CI 算信号）可以共用同一份实现，
 * 避免「Web 一套、脚本一套」的口径漂移。
 *
 * 约定
 * ----
 * · 输出数组长度与输入等长，索引一一对应。
 * · 无效区间一律填 NaN（不是 0、不是首个有效值）。
 * · 均线默认口径 twoPoleMA() 的 cascade = 级联 EMA（两极滤波）。
 *
 * 均线口径
 * --------
 * 两极（two-pole）= 二阶递推低通：两级一阶级联。
 *   a = 2/(N+1)
 *   p1[i] = p1[i-1] + a*(x[i]  - p1[i-1])
 *   p2[i] = p2[i-1] + a*(p1[i] - p2[i-1])      <- 输出 p2
 * 另一口径 SMA 的 SMA：p1 = SMA(x,N)，p2 = SMA(p1,N)
 * 两者 DC 增益均为 1，只改变滞后与平滑度。
 * 其余可选：SMA/EMA/WMA/HMA/DEMA/TEMA/ZLEMA/KAMA/JMA。
 *
 * 周期
 * ----
 * 数据层只存日线。周/月/季用 resample() 聚合：
 *   o=首, h=最高, l=最低, c=末, v=求和
 * 指标一律在「聚合后」的收盘价上计算，与看盘软件口径一致。
 *
 * 指标口径
 * --------
 * BOLL(n=20,k=2)  mid=SMA(c,n), sd=总体标准差, up/low=mid±k*sd
 * MACD(12,26,9)   line=EMA12-EMA26, signal=EMA(line,9), hist=line-signal
 * RSI(14)         Wilder 平滑：avgGain/avgLoss，RSI=100-100/(1+RS)
 * TD Setup 9      连续 9 根 close 高于/低于 close[4]（DeMark Magic 9）
 */

/* ============================ 基础指标 ============================ */

/** 单次 EMA，首个有效值起始平滑。 */
function ema(arr, n) {
  const out = new Float64Array(arr.length);
  if (!arr.length) return out;
  const N = Math.max(1, Math.floor(n));
  const a = 2 / (N + 1);
  let s = arr[0];
  out[0] = s;
  for (let i = 1; i < arr.length; i++) {
    s += a * (arr[i] - s);
    out[i] = s;
  }
  return out;
}

/** 简单滑动平均，前 N-1 位为 NaN。 */
function sma(arr, n) {
  const out = new Float64Array(arr.length);
  const N = Math.max(1, Math.floor(n));
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= N) sum -= arr[i - N];
    out[i] = i >= N - 1 ? sum / N : NaN;
  }
  return out;
}

/** 级联 EMA：两级一阶级联 = 二阶低通，DC 增益 1。 */
function cascadeEMA(arr, n) {
  const out = new Float64Array(arr.length);
  if (!arr.length) return out;
  const N = Math.max(1, Math.floor(n));
  const a = 2 / (N + 1);
  let s1 = arr[0];
  let s2 = arr[0];
  out[0] = s2;
  for (let i = 1; i < arr.length; i++) {
    s1 += a * (arr[i] - s1);
    s2 += a * (s1 - s2);
    out[i] = s2;
  }
  return out;
}

/** SMA 的 SMA：两次滑动平均级联，同样是两极低通。 */
function smaOfSma(arr, n) {
  const p1 = sma(arr, n);
  const N = Math.max(1, Math.floor(n));
  const out = new Float64Array(arr.length);
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = p1[i];
    if (!Number.isNaN(v)) { sum += v; cnt++; }
    if (cnt > N) { const old = p1[i - N]; if (!Number.isNaN(old)) { sum -= old; cnt--; } }
    out[i] = cnt > 0 ? sum / cnt : NaN;
  }
  return out;
}

/** 加权滑动平均：权重 N..1 线性递减，末端权重最大。 */
function wma(values, n) {
  const len = values.length;
  const N = Math.max(1, Math.floor(n));
  const out = new Float64Array(len);
  out.fill(NaN);
  const denom = (N * (N + 1)) / 2;
  for (let i = N - 1; i < len; i++) {
    let sum = 0;
    let ok = true;
    for (let j = 0; j < N; j++) {
      const v = values[i - j];
      if (Number.isNaN(v)) { ok = false; break; }
      sum += v * (N - j);
    }
    if (ok) out[i] = sum / denom;
  }
  return out;
}

/** Hull MA：WMA(2*WMA(N/2) - WMA(N), sqrt(N))，滞后小但转弯处会略过冲。 */
function hma(values, n) {
  const len = values.length;
  const N = Math.max(2, Math.floor(n));
  const half = Math.max(1, Math.floor(N / 2));
  const sq = Math.max(1, Math.round(Math.sqrt(N)));
  const w1 = wma(values, half);
  const w2 = wma(values, N);
  const raw = new Float64Array(len);
  raw.fill(NaN);
  for (let i = 0; i < len; i++) {
    if (!Number.isNaN(w1[i]) && !Number.isNaN(w2[i])) raw[i] = 2 * w1[i] - w2[i];
  }
  return wma(raw, sq);
}

/** 双重 EMA：2*EMA - EMA(EMA)，比单 EMA 滞后更小。 */
function dema(values, n) {
  const e1 = ema(values, n);
  const e2 = ema(e1, n);
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = 2 * e1[i] - e2[i];
  return out;
}

/** 三重 EMA：3*EMA - 3*EMA(EMA) + EMA(EMA(EMA))。 */
function tema(values, n) {
  const e1 = ema(values, n);
  const e2 = ema(e1, n);
  const e3 = ema(e2, n);
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = 3 * e1[i] - 3 * e2[i] + e3[i];
  return out;
}

/** 零滞后 EMA：先做去滞后变换 2*x[i]-x[i-lag]，再做 EMA。lag=(N-1)/2。 */
function zlema(values, n) {
  const len = values.length;
  const N = Math.max(1, Math.floor(n));
  const lag = Math.max(1, Math.floor((N - 1) / 2));
  const de = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    de[i] = i >= lag ? values[i] + (values[i] - values[i - lag]) : values[i];
  }
  return ema(de, N);
}

/**
 * Kaufman 自适应均线：用效率比率 ER 调节平滑系数。
 * ER 高（趋势干净）时贴近价格，ER 低（震荡）时重平滑。
 */
function kama(values, n, fast, slow) {
  const len = values.length;
  const N = Math.max(2, Math.floor(n));
  const fN = Math.max(1, Math.floor(fast || 2));
  const sN = Math.max(2, Math.floor(slow || 30));
  const fastSC = 2 / (fN + 1);
  const slowSC = 2 / (sN + 1);
  const out = new Float64Array(len);
  out.fill(NaN);
  if (len < N + 1) return out;
  let prev = values[N - 1];
  out[N - 1] = prev;
  for (let i = N; i < len; i++) {
    const change = Math.abs(values[i] - values[i - N]);
    let vol = 0;
    for (let j = i - N + 1; j <= i; j++) vol += Math.abs(values[j] - values[j - 1]);
    const er = vol === 0 ? 0 : change / vol;
    const sc = Math.pow(er * (fastSC - slowSC) + slowSC, 2);
    prev += sc * (values[i] - prev);
    out[i] = prev;
  }
  return out;
}

/**
 * Jurik MA（JMA）的公开近似实现。
 * 真正的 JMA 是 Jurik Research 的专有/专利算法，这里用的是社区通用的近似版：
 * 三级递归平滑 + 相位补偿。参数 phase=0、power=2 为常见默认。
 */
function jma(values, n, phase, power) {
  const len = values.length;
  const out = new Float64Array(len);
  if (!len) return out;
  const N = Math.max(2, Math.floor(n));
  const ph = Number.isFinite(phase) ? phase : 0;
  const pw = Math.max(1, Number.isFinite(power) ? power : 2);
  const phaseRatio = ph < -100 ? 0.5 : ph > 100 ? 2.5 : ph / 100 + 1.5;
  const beta = (0.45 * (N - 1)) / (0.45 * (N - 1) + 2);
  const alpha = Math.pow(beta, pw);
  const a1 = 1 - alpha;
  let e0 = values[0];
  let e1 = 0;
  let e2 = 0;
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < len; i++) {
    const src = values[i];
    e0 = a1 * src + alpha * e0;
    e1 = (src - e0) * (1 - beta) + beta * e1;
    e2 = (e0 + phaseRatio * e1 - prev) * a1 * a1 + alpha * alpha * e2;
    prev = e2 + prev;
    out[i] = prev;
  }
  return out;
}

/**
 * 均线口径分发。
 * 默认 cascade = 级联 EMA（两极），保持原有行为；
 * 其余口径按 method 名切换，均为同一份收盘价序列上的平滑。
 */
function twoPoleMA(values, period, method) {
  const N = Math.max(1, Math.floor(period));
  switch (method) {
    case 'smasma': return smaOfSma(values, N);
    case 'sma': return sma(values, N);
    case 'ema': return ema(values, N);
    case 'wma': return wma(values, N);
    case 'hma': return hma(values, N);
    case 'dema': return dema(values, N);
    case 'tema': return tema(values, N);
    case 'zlema': return zlema(values, N);
    case 'kama': return kama(values, N, 2, 30);
    case 'jma': return jma(values, N, 0, 2);
    default: return cascadeEMA(values, N);
  }
}

/** 布林带：中轨 SMA，上下轨 ±k 倍总体标准差。 */
function bollinger(closes, n, k) {
  const len = closes.length;
  const N = Math.max(1, Math.floor(n));
  const mid = sma(closes, N);
  const up = new Float64Array(len);
  const low = new Float64Array(len);
  for (let i = N - 1; i < len; i++) {
    let s = 0;
    for (let j = i - N + 1; j <= i; j++) s += closes[j];
    const mean = s / N;
    let sq = 0;
    for (let j = i - N + 1; j <= i; j++) {
      const d = closes[j] - mean;
      sq += d * d;
    }
    const sd = Math.sqrt(sq / N);
    up[i] = mean + k * sd;
    low[i] = mean - k * sd;
  }
  for (let i = 0; i < N - 1; i++) { up[i] = NaN; low[i] = NaN; }
  return { mid, up, low };
}

/** MACD：快慢 EMA 之差 + 信号线。 */
function macdCalc(closes, fast, slow, sig) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line = new Float64Array(closes.length);
  for (let i = 0; i < closes.length; i++) line[i] = ef[i] - es[i];
  const signal = ema(line, sig);
  const hist = new Float64Array(closes.length);
  for (let i = 0; i < closes.length; i++) hist[i] = line[i] - signal[i];
  return { line, signal, hist };
}

/** RSI：Wilder 平滑。 */
function rsiCalc(closes, n) {
  const len = closes.length;
  const N = Math.max(1, Math.floor(n));
  const out = new Float64Array(len);
  out.fill(NaN);
  if (len <= N) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= N; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let ag = gain / N;
  let al = loss / N;
  out[N] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = N + 1; i < len; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    ag = (ag * (N - 1) + g) / N;
    al = (al * (N - 1) + l) / N;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

/**
 * TD Setup 9（俗称 Magic 9）
 * -------------------------
 * DeMark Setup 的经典简化口径，只用收盘价：
 *   卖出结构 sell：close[i] > close[i-4] 连续计数
 *   买入结构 buy ：close[i] < close[i-4] 连续计数
 * 计数达到 9 为该结构的「完成」（setup completion），常作为趋势衰竭提示。
 *
 * 注意：严格版 DeMark 从第 9 根起要比较真实高/低点（perfected setup），
 * 本实现为「close vs close[4]」通用简化版，也是多数软件默认的 Magic 9。
 * 计数严格连续：条件不满足即归零，相等或反向都会打断。
 */
function tdSetup(closes) {
  const len = closes.length;
  const buy = new Int8Array(len);
  const sell = new Int8Array(len);
  let b = 0;
  let s2 = 0;
  for (let i = 0; i < len; i++) {
    if (i >= 4) {
      const prev = closes[i - 4];
      if (closes[i] < prev) { b += 1; s2 = 0; }
      else if (closes[i] > prev) { s2 += 1; b = 0; }
      else { b = 0; s2 = 0; }
    }
    buy[i] = b > 127 ? 127 : b;
    sell[i] = s2 > 127 ? 127 : s2;
  }
  return { buy, sell };
}

/* ============================ 周期聚合 ============================ */

/** 把日线按周/月/季聚合成 OHLCV，口径与看盘软件一致。 */
function resample(raw, tf) {
  if (!raw || tf === 'D' || !tf) return raw;
  const out = { dates: [], o: [], h: [], l: [], c: [], v: [] };
  let cur = null;
  const dates = raw.dates;
  for (let i = 0; i < dates.length; i++) {
    const iso = dates[i];
    let key;
    if (tf === 'W') {
      const d = new Date(iso + 'T00:00:00Z');
      const dow = (d.getUTCDay() + 6) % 7;
      d.setUTCDate(d.getUTCDate() - dow);
      key = d.toISOString().slice(0, 10);
    } else if (tf === 'M') {
      key = iso.slice(0, 7);
    } else if (tf === 'Q') {
      const m = parseInt(iso.slice(5, 7), 10);
      key = iso.slice(0, 4) + '-Q' + (Math.floor((m - 1) / 3) + 1);
    } else {
      key = iso;
    }
    if (key !== cur) {
      cur = key;
      out.dates.push(iso);
      out.o.push(raw.o[i]);
      out.h.push(raw.h[i]);
      out.l.push(raw.l[i]);
      out.c.push(raw.c[i]);
      out.v.push(raw.v ? raw.v[i] || 0 : 0);
    } else {
      const j = out.dates.length - 1;
      if (raw.h[i] > out.h[j]) out.h[j] = raw.h[i];
      if (raw.l[i] < out.l[j]) out.l[j] = raw.l[i];
      out.c[j] = raw.c[i];
      if (raw.v) out.v[j] += raw.v[i] || 0;
    }
  }
  return out;
}

/** 按价格量级选小数位：>=10000 取整，>=1000 一位，其余两位。 */
export function decimalsFor(price) {
  const p = Math.abs(price);
  if (p >= 10000) return 0;
  if (p >= 1000) return 1;
  return 2;
}

/* ============================ 整体技术评估 ============================ */

/**
 * 把多个指标压缩成一个 -100..100 的分数，用于「整体技术评估」。
 *
 * 这是若干常用指标的加权合成，用途是快速归纳当前状态，
 * 不是预测模型，也不代表任何胜率或收益预期。
 *
 * 权重构成
 * · 价格 vs 均线   1.0   趋势方向
 * · MACD 柱        1.0   动量方向
 * · RSI 偏离 50    1.0   连续强度（-1..1）
 * · TD9 完成       1.0   衰竭提示（买入9 +1 / 卖出9 -1）
 * · BOLL 带内位置  0.5   -1..1
 */
export function assess(bars, opts) {
  const o = opts || {};
  const period = Math.max(2, Math.floor(o.period || 50));
  const method = o.method || 'cascade';
  const c = bars && bars.c;
  if (!c || c.length < 2) return null;
  const i = c.length - 1;

  const ma = twoPoleMA(c, period, method);
  const bo = bollinger(c, 20, 2);
  const mc = macdCalc(c, 12, 26, 9);
  const rs = rsiCalc(c, 14);
  const td = tdSetup(c);

  const parts = {};
  let sum = 0;
  let wsum = 0;

  // 趋势：收盘在均线之上为正
  const mv = ma[i];
  if (!Number.isNaN(mv)) {
    parts.ma = c[i] >= mv ? 1 : -1;
    sum += parts.ma; wsum += 1;
  } else {
    parts.ma = 0;
  }

  // 动量：MACD 柱符号
  const hv = mc.hist[i];
  if (!Number.isNaN(hv)) {
    parts.macd = hv >= 0 ? 1 : -1;
    sum += parts.macd; wsum += 1;
  } else {
    parts.macd = 0;
  }

  // 强度：RSI 相对 50，±30 记满
  const rv = rs[i];
  if (!Number.isNaN(rv)) {
    parts.rsi = Math.max(-1, Math.min(1, (rv - 50) / 30));
    sum += parts.rsi; wsum += 1;
  } else {
    parts.rsi = 0;
  }

  // 衰竭：完成的 TD9
  const bv = td.buy[i];
  const sv = td.sell[i];
  parts.td = bv >= 9 ? 1 : sv >= 9 ? -1 : 0;
  sum += parts.td; wsum += 1;

  // 位置：BOLL 通道内相对位置，权重减半
  const up = bo.up[i];
  const lo = bo.low[i];
  if (!Number.isNaN(up) && !Number.isNaN(lo) && up > lo) {
    parts.boll = Math.max(-1, Math.min(1, (2 * (c[i] - lo)) / (up - lo) - 1));
    sum += parts.boll * 0.5; wsum += 0.5;
  } else {
    parts.boll = 0;
  }

  const score = wsum > 0 ? Math.round((sum / wsum) * 100) : 0;
  return { score, label: assessLabel(score), parts };
}

/** 分数到文字等级。分档只为展示，不含概率含义。 */
export function assessLabel(score) {
  if (score >= 50) return '强烈看多';
  if (score >= 20) return '偏多';
  if (score > -20) return '中性';
  if (score > -50) return '偏空';
  return '强烈看空';
}

/* ============================ 模块导出 ============================ */

export {
  ema, sma, cascadeEMA, smaOfSma, twoPoleMA,
  wma, hma, dema, tema, zlema, kama, jma,
  bollinger, macdCalc, rsiCalc, tdSetup,
  resample,
};
