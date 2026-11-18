# ChartGrid

Finviz `Futures Charts` 风格的期货图表网格，图上叠加**两极移动平均线（Two-Pole Moving Average）**。
纯静态站点：无框架、无依赖、单文件渲染器，数据由 GitHub Actions 每日抓取。

线上地址：`https://ryanzhao2026.github.io/ChartGrid/`

---

## 1. 两极均线到底是什么

「两极」指的是滤波器里有**两个储能极点**——把同一个一阶平滑级联两次，就得到二阶（two-pole）低通。
它不是把周期调大，而是改变滤波器的阶数：同样周期下，两极比单极更平、拐点更晚、假信号更少。

默认实现是**级联 EMA**（`a = 2/(N+1)`）：

```
p1[i] = p1[i-1] + a*( x[i] - p1[i-1] )      <- 第一极
p2[i] = p2[i-1] + a*( p1[i] - p2[i-1] )     <- 第二极，输出 p2
```

页面上也可切换为 **SMA 的 SMA**：

```
p1 = SMA(x, N)
p2 = SMA(p1, N)                             <- 输出 p2
```

两者都是 DC 增益 = 1 的低通，**不缩放价格绝对水平**，只影响相位滞后与平滑强度。

### 实测特性（node 自检）

| 检验项 | 一极（单 EMA） | 两极（级联） |
|---|---|---|
| 常数输入 42 的稳态输出 | 42.000000 | 42.000000（DC 增益 = 1） |
| 阶跃达到 90% 所需根数 | 24 | 39（滞后明显更大） |
| 价格平均二阶差分（抖动） | 原始 3.650 | 均线 0.036 |

也就是说：**平滑度约提升 100 倍，代价是滞后增加约 1.6 倍**。这正是两极均线的取舍点。

> 如果你的原始口径不同（例如 Ehlers 二阶超平滑、或两条不同周期均线相减），
> 只需替换 `app.js` 顶部的 `cascadeEMA` / `smaOfSma` 两个函数，其余代码无需改动。

---

## 2. 界面

| 区域 | 说明 |
|---|---|
| 顶部控件 | 均线周期（2-400）、均线口径（级联 EMA / SMA2）、显示根数（30-500） |
| 分组 Tab | All / Indices / Rates / Energy / Metals / Grains / Softs & Meats / Currencies / Crypto |
| 卡片 | 品种名 + 合约代码、末价与日涨跌幅、蜡烛图 + 黄色两极均线、右侧价格轴 |
| 悬停 | 十字位置显示该根 O/H/L/C 与均线值 |
| 页脚 | 当前品种数、均线参数、显示根数、数据生成时间 |

图表完全由 `canvas` 绘制（`app.js`），按 `devicePixelRatio` 缩放，缩放窗口自动重绘。

---

## 3. 目录结构

```
ChartGrid/
├── index.html              # 页面骨架
├── style.css               # 暗色主题
├── app.js                  # 两极均线 + canvas 渲染器 + 数据加载
├── fetch_data.py           # yfinance 抓取 -> data/*.json
├── requirements.txt
├── data/
│   ├── manifest.json       # 品种清单 / 状态 / 末值 / 生成时间
│   └── ES.json             # 每品种一份 OHLC
└── .github/workflows/deploy.yml
```

数据格式（每品种一个文件，页面并发按需加载）：

```json
{
  "key": "ES=F", "name": "S&P 500", "group": "Indices", "bars": 500,
  "last": 6123.5, "lastDate": "2026-11-17",
  "dates": ["2025-01-02", "..."],
  "o": [5900.0], "h": [], "l": [], "c": [], "v": []
}
```

---

## 4. 本地运行

```bash
pip install -r requirements.txt
python fetch_data.py --days 500          # 生成 data/*.json
python -m http.server 8000               # 必须走 HTTP，file:// 下 fetch 会被拦
# 打开 http://localhost:8000
```

只抓几个品种调试：`python fetch_data.py --only ES,GC,CL`

> **注意**：Yahoo 对数据中心 / 云服务器 IP 限流很严，沙箱、CI 之外的云主机常返回 429。
> 本项目的设计前提就是**取数放在 GitHub Actions 里跑**。
> 本地抓取失败属预期现象，不是代码问题。

---

## 5. 自动化

`.github/workflows/deploy.yml`：

- 触发：`push` 到 main、每周一至周五 22:10 UTC（美股收盘后）、手动 `workflow_dispatch`
- 步骤：安装依赖 → `fetch_data.py` → 若有变化则提交 `data/` → 上传并部署 Pages
- 单个品种抓取失败不会中断整体：`manifest.json` 里标记 `status: "failed"`，页面自动跳过该卡片
- 全部失败时脚本返回非零退出码，CI 会红，便于发现上游变更

首次部署需在仓库 **Settings -> Pages -> Source** 选择 **GitHub Actions**。

---

## 6. 已知限制

- 使用**连续合约**（`ES=F` 这类），换月处会有跳空，不适合做精确的绝对价回测
- yfinance 偶发字段变动；`fetch_data.py` 已做列名归一化与正数过滤，但上游大改仍需跟进
- `NKD=F`、`LB=F`、部分软商品在 Yahoo 上覆盖不稳，失败即跳过，不影响其余品种
- 图表为日线；分时数据不在本项目范围内

---

## 免责声明

本项目仅用于技术演示与图表研究，所有数据来自公开渠道，可能存在缺失、延迟或错误。
**不构成任何投资建议**，不推荐任何具体金融产品的买卖、持有或择时。使用者需自行独立判断并承担全部风险。
