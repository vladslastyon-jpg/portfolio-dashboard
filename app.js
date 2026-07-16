/* ==========================================================================
   Дашборд «Анализ портфеля» — основная логика.
   Архитектура: чтение Google Sheets API v4 через OAuth (Google Identity
   Services), без сервера. Все вычисления (Modified Dietz уже посчитан в
   таблице; здесь только агрегация для отображения) идут в браузере.
   ========================================================================== */

const CFG = window.DASHBOARD_CONFIG;
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

let accessToken = null;
let tokenClient = null;
let currentCurrency = "USD";
let eurUsdRate = null; // сколько USD за 1 EUR

// сырые данные из таблицы
const raw = {
  portfolioSummary: null,
  mdSummary: null,
  portfolioMonthly: null,
  transactions: null,
  assetHistory: null,
  goldHistory: null,
  dashboardInputs: null,
  actualPortfolio: null,
  portfolio500k: null,
};

// вычисленные данные
const derived = {
  kpi: null,          // {invested, marketValue, profit, profitPct}
  periods: [],        // [{label, value}]
  monthly: [],         // [{date, value, profitAbs, profitPct}]
  allocation: [],      // [{ticker, group, shares, price, value, weight}]
  txRows: [],          // [{date, ticker, qty, price, amount}]
  cashflowMonthly: [], // [{month, amount}]
  goals: [],           // [{name, amount, currency}]
};

let valueChart = null;
let allocationChart = null;
let cashflowChart = null;
let assetsReturnChart = null;

const CORE_TICKERS = ["VOO", "CSPX", "SOXX", "SMH", "GOOGL", "4GLD"];
const ASSET_COLORS = {
  VOO: "#55A776", CSPX: "#3E7B8C", SOXX: "#C25C50",
  SMH: "#9A6BA0", GOOGL: "#C39A48", "4GLD": "#B8934A",
  Портфель: "#E9E6DC",
};
let assetChartVisibility = { Портфель: true, VOO: false, CSPX: false, SOXX: false, SMH: false, GOOGL: false, "4GLD": false };
let selectedAssetPeriod = "all";
let selectedValuePeriod = "all";

const PERIOD_DAYS_BACK = { "1d": 1, "1w": 7, "1m": 30, "1y": 365, "5y": 1825 };
const PERIOD_YEARS_BACK = { "3y": 3, "5y": 5, "10y": 10 };

/* -------------------------- helpers -------------------------- */

function fmtMoney(value, ccy = currentCurrency) {
  if (value === null || value === undefined || isNaN(value)) return "—";
  const converted = convertCurrency(value, ccy);
  const symbol = ccy === "EUR" ? "€" : "$";
  const sign = converted < 0 ? "-" : "";
  return `${sign}${symbol}${Math.abs(converted).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(value) {
  if (value === null || value === undefined || isNaN(value)) return "—";
  const pct = value * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function convertCurrency(usdValue, targetCcy) {
  if (targetCcy === "USD" || !eurUsdRate) return usdValue;
  return usdValue / eurUsdRate; // EUR = USD / (USD за 1 EUR)
}

function signClass(v) {
  if (v === null || v === undefined || isNaN(v)) return "";
  return v >= 0 ? "is-positive" : "is-negative";
}

function parseNum(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^0-9.\-]/g, "");
    const n = parseFloat(cleaned);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

function setStatus(msg, isError = false) {
  const el = document.getElementById("statusBar");
  el.hidden = false;
  el.textContent = msg;
  el.classList.toggle("is-error", isError);
}

/* -------------------------- Google Identity Services -------------------------- */

function initGis() {
  if (!window.google || !window.google.accounts) {
    setTimeout(initGis, 200);
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CFG.CLIENT_ID,
    scope: CFG.SCOPES,
    callback: (resp) => {
      if (resp.error) {
        setStatus("Ошибка авторизации: " + resp.error, true);
        return;
      }
      accessToken = resp.access_token;
      onSignedIn();
    },
  });
}

function signIn() {
  if (!tokenClient) {
    setStatus("Google Identity Services ещё не загрузился, попробуй через пару секунд.", true);
    return;
  }
  tokenClient.requestAccessToken({ prompt: accessToken ? "" : "consent" });
}

function signOut() {
  if (accessToken) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  document.getElementById("app").hidden = true;
  document.getElementById("signedOutHint").hidden = false;
  document.getElementById("signInBtn").hidden = false;
  document.getElementById("userChip").hidden = true;
  setStatus("Вы вышли из аккаунта.");
}

function onSignedIn() {
  document.getElementById("signInBtn").hidden = true;
  document.getElementById("userChip").hidden = false;
  document.getElementById("userEmail").textContent = "подключено";
  document.getElementById("signedOutHint").hidden = true;
  fetchAll();
}

/* -------------------------- Data fetching -------------------------- */

function buildRanges() {
  const s = CFG.SHEETS;
  return [
    `${s.portfolioSummary}!A1:M10`,
    `${s.mdSummary}!A1:B14`,
    `${s.portfolioMonthly}!A1:D3000`,
    `${s.transactions}!A1:D3000`,
    `${s.assetHistory}!A1:ZZ3000`,
    `${s.goldHistory}!A9:D3500`,
    `${s.dashboardInputs}!A1:D50`,
    `${s.actualPortfolio}!B1:T20`,
    `${s.portfolio500k}!A1:G30`,
  ];
}

async function fetchAll() {
  if (!accessToken) return;
  setStatus("Загружаю данные из Google Таблицы…");
  document.getElementById("refreshBtn").classList.add("spinning");

  try {
    const ranges = buildRanges();
    const params = ranges.map((r) => "ranges=" + encodeURIComponent(r)).join("&");
    const url = `${SHEETS_API}/${CFG.SPREADSHEET_ID}/values:batchGet?${params}&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`;
    const res = await fetch(url, { headers: { Authorization: "Bearer " + accessToken } });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody?.error?.message || `HTTP ${res.status}`);
    }

    const json = await res.json();
    const vr = json.valueRanges;
    raw.portfolioSummary = vr[0].values || [];
    raw.mdSummary = vr[1].values || [];
    raw.portfolioMonthly = vr[2].values || [];
    raw.transactions = vr[3].values || [];
    raw.assetHistory = vr[4].values || [];
    raw.goldHistory = vr[5].values || [];
    raw.dashboardInputs = vr[6].values || [];
    raw.actualPortfolio = vr[7].values || [];
    raw.portfolio500k = vr[8].values || [];

    computeAll();
    renderAll();

    document.getElementById("app").hidden = false;
    const now = new Date();
    setStatus(`Обновлено: ${now.toLocaleString("ru-RU")}`);
  } catch (err) {
    console.error(err);
    setStatus("Ошибка загрузки данных: " + err.message + " — проверь SPREADSHEET_ID, названия листов и права доступа в config.js", true);
  } finally {
    document.getElementById("refreshBtn").classList.remove("spinning");
  }
}

/* -------------------------- Parsing / computation -------------------------- */

function computeAll() {
  computeEurUsd();
  computeKPI();
  computePeriods();
  computeMonthly();
  computeTransactions();
  computeTickerDetailTable();
  computePlanActual();
  computeAllocation();
  computeCashflowMonthly();
  computeCashflowDaily();
  computeGoals();
  computeAssetAnnualReturns();
  computeMonthGrid();
  computeDailyPortfolioValue();
}

/* ---- helpers used by drill-down and annual comparison ---- */

function priceOnOrBefore(ticker, date) {
  const rows = raw.assetHistory || [];
  if (!rows.length) return 0;
  const header = rows[0];
  const colIdx = header.indexOf(ticker);
  if (colIdx === -1) return 0;
  for (let i = rows.length - 1; i >= 1; i--) {
    const d = parseSheetDate(rows[i][0]);
    if (d && d <= date) {
      const v = parseNum(rows[i][colIdx]);
      if (v) return v;
    }
  }
  return 0;
}

function priceOnOrAfter(ticker, date) {
  const rows = raw.assetHistory || [];
  if (!rows.length) return 0;
  const header = rows[0];
  const colIdx = header.indexOf(ticker);
  if (colIdx === -1) return 0;
  for (let i = 1; i < rows.length; i++) {
    const d = parseSheetDate(rows[i][0]);
    if (d && d >= date) {
      const v = parseNum(rows[i][colIdx]);
      if (v) return v;
    }
  }
  return 0;
}

function sharesAsOfDate(ticker, date) {
  let sum = 0;
  derived.txRows.forEach((t) => {
    if (t.ticker !== ticker) return;
    const d = parseSheetDate(t.date);
    if (d && d <= date) sum += t.qty;
  });
  return sum;
}

function computeAssetAnnualReturns() {
  const rows = raw.assetHistory || [];
  if (!rows.length) { derived.assetAnnualReturns = { years: [], series: {}, portfolio: {}, benchmark: {} }; return; }

  const allDates = rows.slice(1).map((r) => parseSheetDate(r[0])).filter(Boolean);
  if (!allDates.length) { derived.assetAnnualReturns = { years: [], series: {}, portfolio: {}, benchmark: {} }; return; }
  const minYear = Math.min(...allDates.map((d) => d.getFullYear()));
  const maxYear = Math.max(...allDates.map((d) => d.getFullYear()));
  const years = [];
  for (let y = minYear; y <= maxYear; y++) years.push(y);

  const series = {};
  CORE_TICKERS.forEach((ticker) => {
    series[ticker] = years.map((y) => {
      const start = priceOnOrAfter(ticker, new Date(y, 0, 1));
      const end = priceOnOrBefore(ticker, new Date(y, 11, 31));
      if (!start || !end) return null;
      return end / start - 1;
    });
  });

  const portfolio = years.map((y) => {
    const monthsInYear = derived.monthly.filter((m) => {
      const d = parseSheetDate(m.date);
      return d && d.getFullYear() === y && m.profitPct !== null;
    });
    if (!monthsInYear.length) return null;
    let compounded = 1;
    monthsInYear.forEach((m) => { compounded *= (1 + m.profitPct); });
    return compounded - 1;
  });

  derived.assetAnnualReturns = { years, series, portfolio, benchmark: series["VOO"] || [] };
}

function computeMonthGrid() {
  const byYear = {};
  derived.monthly.forEach((m) => {
    const d = parseSheetDate(m.date);
    if (!d) return;
    const y = d.getFullYear();
    if (!byYear[y]) byYear[y] = {};
    byYear[y][d.getMonth()] = m;
  });
  derived.monthGrid = byYear;
}

function computeMonthDrilldown(year, monthIndex, monthEntry) {
  const start = new Date(year, monthIndex, 1);
  const dayBeforeStart = new Date(start.getTime() - 86400000);
  const end = parseSheetDate(monthEntry.date) || new Date(year, monthIndex + 1, 0);

  const rows = [];
  let weightedNumerator = 0;
  let totalStartValue = 0;

  CORE_TICKERS.forEach((ticker) => {
    const sharesStart = sharesAsOfDate(ticker, dayBeforeStart);
    const sharesEnd = sharesAsOfDate(ticker, end);
    if (Math.abs(sharesStart) < 1e-9 && Math.abs(sharesEnd) < 1e-9) return;

    const priceStart = priceOnOrBefore(ticker, start);
    const priceEnd = priceOnOrBefore(ticker, end);
    const returnPct = priceStart > 0 ? priceEnd / priceStart - 1 : null;
    const qtyDelta = sharesEnd - sharesStart;

    const startValue = sharesStart * priceStart;
    totalStartValue += startValue;
    if (returnPct !== null) weightedNumerator += startValue * returnPct;

    rows.push({ ticker, priceStart, priceEnd, returnPct, qtyDelta });
  });

  const portfolioReturn = monthEntry.profitPct !== null && monthEntry.profitPct !== undefined
    ? monthEntry.profitPct
    : (totalStartValue > 0 ? weightedNumerator / totalStartValue : null);

  rows.push({ ticker: "Портфель целиком", priceStart: null, priceEnd: null, returnPct: portfolioReturn, qtyDelta: null, isTotal: true });
  return rows;
}

function computeEurUsd() {
  const rows = raw.goldHistory || [];
  // столбцы: Дата, GCUSD, EURUSD, 4GLD — берём последнюю непустую строку
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r && r[2] !== undefined && r[2] !== "" && !isNaN(parseNum(r[2]))) {
      eurUsdRate = parseNum(r[2]);
      return;
    }
  }
  eurUsdRate = null;
}

function computeKPI() {
  const rows = raw.portfolioSummary || [];
  // Согласно Apps Script: заголовки в I1:L1, значения в I2:L2 (индексы столбцов 8-11, с 0)
  const headerRow = rows[0] || [];
  const valueRow = rows[1] || [];
  const idx = { invested: 8, market: 9, profit: 10, pct: 11 };
  derived.kpi = {
    invested: parseNum(valueRow[idx.invested]),
    marketValue: parseNum(valueRow[idx.market]),
    profit: parseNum(valueRow[idx.profit]),
    profitPct: parseNum(valueRow[idx.pct]),
  };
}

function computePeriods() {
  const rows = raw.mdSummary || [];
  // Строки данных начинаются с 3-й строки листа (индекс 2), формат [Период, Доходность]
  const out = [];
  for (let i = 2; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    const val = r[1];
    out.push({ label: r[0], value: val === "" || val === undefined ? null : parseNum(val) });
  }
  derived.periods = out;
}

function computeMonthly() {
  const rows = raw.portfolioMonthly || [];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    out.push({
      date: r[0],
      value: parseNum(r[1]),
      profitAbs: r[2] === "" ? null : parseNum(r[2]),
      profitPct: r[3] === "" ? null : parseNum(r[3]),
    });
  }
  derived.monthly = out;
}

function computeTransactions() {
  const rows = raw.transactions || [];
  const out = [];
  // Лист «Транзакции»: данные с 5 строки в реальной таблице (A5:D...), но мы
  // запросили диапазон A1:D3000 целиком — пропускаем строки без даты/тикера.
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0] || !r[1]) continue;
    const qty = parseNum(r[2]);
    const price = parseNum(r[3]);
    out.push({ date: r[0], ticker: r[1], qty, price, amount: qty * price });
  }
  derived.txRows = out;
}

function parseGoals() {
  const rows = raw.dashboardInputs || [];
  let start = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i][0] === "BLOCK_A_GOALS") { start = i; break; }
  }
  if (start === -1) return [];
  const out = [];
  for (let i = start + 2; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) break;
    out.push({ name: r[0], amount: parseNum(r[1]), currency: r[2] || "USD" });
  }
  return out;
}

function computeGoals() {
  derived.goals = parseGoals();
}

/**
 * Читает лист «Актуальный Портфель» НАПРЯМУЮ — никаких пересчётов.
 * Структура (диапазон B1:T20): строка 1 = заголовки, строка 2 = ИТОГО (жёлтая),
 * строки 3+ = по одному тикеру. Колонки (0-based от B):
 * 0 Тикер, 1 Кол-во, 2 Ср.цена входа, 3 Текущая цена, 4 Сегодня$, 5 Доля,
 * 6 PL%, 7 PL$, 8..18 периоды (Today,7 days,30 days,90 days,YTD,1Y,2Y,3Y,4Y,5Y,Весь период)
 */
const PERIOD_LABELS = ["Today", "7 days", "30 days", "90 days", "YTD", "1Y", "2Y", "3Y", "4Y", "5Y", "Весь период"];

function parseActualPortfolioSheet() {
  const rows = raw.actualPortfolio || [];
  if (rows.length < 3) return { total: null, rows: [] };

  const totalRaw = rows[1] || [];
  const total = {
    value: parseNum(totalRaw[4]),
    weight: parseNum(totalRaw[5]),
    plPct: parseNum(totalRaw[6]),
    plAbs: parseNum(totalRaw[7]),
    periods: {},
  };
  PERIOD_LABELS.forEach((label, i) => { total.periods[label] = numOrNull(totalRaw[8 + i]); });

  const tickerRows = [];
  for (let i = 2; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    const row = {
      ticker: r[0],
      shares: parseNum(r[1]),
      avgCost: (r[2] === "" || r[2] === undefined || r[2] === null) ? null : parseNum(r[2]),
      price: (r[3] === "" || r[3] === undefined || r[3] === null) ? null : parseNum(r[3]),
      value: parseNum(r[4]),
      weight: parseNum(r[5]),
      plPct: numOrNull(r[6]),
      plAbs: numOrNull(r[7]),
      periods: {},
    };
    PERIOD_LABELS.forEach((label, idx) => { row.periods[label] = numOrNull(r[8 + idx]); });
    tickerRows.push(row);
  }

  return { total, rows: tickerRows };
}

function numOrNull(v) {
  if (v === "" || v === undefined || v === null || v === "-" || v === "−") return null;
  const n = parseNum(v);
  return isNaN(n) ? null : n;
}

function computeTickerDetailTable() {
  derived.actualPortfolio = parseActualPortfolioSheet();
}

/**
 * Читает лист «портфель 500к» НАПРЯМУЮ — план/факт по группам и тикерам,
 * плюс авторитетные цифры цели (текущий объём / цель / осталось добрать).
 * Структура: B2=текущий объём, D2=цель, G2=осталось добрать.
 * С 6-й строки: блоки — строка группы, затем строки тикеров, разделены пустой строкой.
 */
function parsePortfolio500kSheet() {
  const rows = raw.portfolio500k || [];
  if (rows.length < 2) return { currentTotal: null, targetTotal: null, remaining: null, groups: [] };

  const headerValueRow = rows[1] || [];
  const currentTotal = numOrNull(headerValueRow[1]);
  const targetTotal = numOrNull(headerValueRow[3]);
  const remaining = numOrNull(headerValueRow[6]);

  let totalRowIdx = rows.findIndex((r) => r && typeof r[0] === "string" && r[0].toUpperCase().includes("ПОРТФЕЛЬ"));
  if (totalRowIdx === -1) totalRowIdx = 5;

  const groups = [];
  let i = totalRowIdx + 1;
  while (i < rows.length) {
    const row = rows[i];
    if (!row || !row[0]) { i++; continue; }
    const groupName = row[0];
    const group = {
      group: groupName,
      factUSD: numOrNull(row[1]), factPct: numOrNull(row[2]),
      planUSD: numOrNull(row[3]), planPct: numOrNull(row[4]),
      tickers: [],
    };
    i++;
    while (i < rows.length && rows[i] && rows[i][0] && !/^[IVX]+\./.test(rows[i][0])) {
      const tr = rows[i];
      group.tickers.push({
        ticker: tr[0],
        factUSD: numOrNull(tr[1]), factPct: numOrNull(tr[2]),
        planUSD: numOrNull(tr[3]), planPct: numOrNull(tr[4]),
        deltaUSD: numOrNull(tr[5]), planFactPct: numOrNull(tr[6]),
      });
      i++;
    }
    groups.push(group);
  }
  return { currentTotal, targetTotal, remaining, groups };
}

function computePlanActual() {
  derived.planActual = parsePortfolio500kSheet();
}

function getTickerGroupMap() {
  const map = {};
  (derived.planActual?.groups || []).forEach((g) => {
    g.tickers.forEach((t) => { map[t.ticker] = g.group; });
  });
  return map;
}

function getCoreTickers() {
  return (derived.actualPortfolio?.rows || [])
    .map((r) => r.ticker)
    .filter((t) => t !== "Cash");
}

function computeAllocation() {
  const groups = getTickerGroupMap();
  const rows = (derived.actualPortfolio?.rows || []).filter((r) => r.ticker !== "Cash");
  const alloc = rows.map((r) => ({
    ticker: r.ticker,
    group: groups[r.ticker] || "Без группы",
    shares: r.shares,
    price: r.price,
    value: r.value,
    weight: r.weight,
  }));
  alloc.sort((a, b) => b.value - a.value);
  derived.allocation = alloc;
}

function computeCashflowMonthly() {
  const byMonth = {};
  derived.txRows.forEach((t) => {
    if (t.ticker === "Cash") return;
    const d = parseSheetDate(t.date);
    if (!d) return;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    byMonth[key] = (byMonth[key] || 0) + t.amount;
  });
  const keys = Object.keys(byMonth).sort();
  derived.cashflowMonthly = keys.map((k) => ({ month: k, amount: byMonth[k] }));
}

function computeCashflowDaily() {
  const byDay = {};
  derived.txRows.forEach((t) => {
    if (t.ticker === "Cash") return;
    const d = parseSheetDate(t.date);
    if (!d) return;
    const key = d.toISOString().slice(0, 10);
    byDay[key] = (byDay[key] || 0) + t.amount;
  });
  const keys = Object.keys(byDay).sort();
  derived.cashflowDaily = keys.map((k) => ({ date: k, amount: byDay[k] }));
}

/**
 * Строит дневной ряд стоимости портфеля из Asset_History (цены на каждый день)
 * умноженные на количество бумаг на эту дату (из Транзакции). Идём по датам
 * последовательно и просто продвигаем указатель по отсортированным сделкам —
 * O(n), без вложенного цикла по всем транзакциям на каждый день.
 */
function computeDailyPortfolioValue() {
  const rows = raw.assetHistory || [];
  if (rows.length < 2) { derived.dailyValue = []; return; }
  const header = rows[0];
  const tickerCols = header
    .map((name, col) => ({ ticker: name, col }))
    .filter((tc) => tc.col > 0 && tc.ticker);

  const txByTicker = {};
  derived.txRows.forEach((t) => {
    if (t.ticker === "Cash") return;
    if (!txByTicker[t.ticker]) txByTicker[t.ticker] = [];
    txByTicker[t.ticker].push(t);
  });
  Object.values(txByTicker).forEach((arr) => arr.sort((a, b) => {
    const da = parseSheetDate(a.date), db = parseSheetDate(b.date);
    return (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
  }));

  const sharesState = {};
  const txIndex = {};
  tickerCols.forEach(({ ticker }) => { sharesState[ticker] = 0; txIndex[ticker] = 0; });

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const date = parseSheetDate(row[0]);
    if (!date) continue;
    let total = 0;
    tickerCols.forEach(({ ticker, col }) => {
      const txs = txByTicker[ticker] || [];
      while (txIndex[ticker] < txs.length) {
        const txDate = parseSheetDate(txs[txIndex[ticker]].date);
        if (txDate && txDate <= date) {
          sharesState[ticker] += txs[txIndex[ticker]].qty;
          txIndex[ticker]++;
        } else break;
      }
      const price = parseNum(row[col]);
      if (Math.abs(sharesState[ticker]) > 1e-9 && price) total += sharesState[ticker] * price;
    });
    if (total > 0) out.push({ date: row[0], value: total });
  }
  derived.dailyValue = out;
}

function parseSheetDate(v) {
  if (v instanceof Date) return v;
  if (typeof v === "string") {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d;
  }
  // Google Sheets API иногда отдаёт serial-число для дат, если формат ячейки не строковый
  if (typeof v === "number") {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    return new Date(epoch.getTime() + v * 86400000);
  }
  return null;
}

/* -------------------------- Rendering -------------------------- */

function renderAll() {
  renderKPI();
  renderGoal();
  renderPeriods();
  renderValueChart();
  renderAllocation();
  renderCashflowChart();
  renderTransactions();
  renderAssetCheckboxes();
  renderAssetsReturnChart();
  renderMonthGrid();
  renderTickerDetailTable();
  renderPlanActual();
}

function renderAssetCheckboxes() {
  const container = document.getElementById("assetCheckboxes");
  if (container.dataset.built) return;
  container.dataset.built = "1";
  const names = ["Портфель", ...CORE_TICKERS];
  names.forEach((name) => {
    const label = document.createElement("label");
    label.className = "asset-chip" + (assetChartVisibility[name] ? " is-active" : "");
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = ASSET_COLORS[name];
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = assetChartVisibility[name];
    checkbox.addEventListener("change", () => {
      assetChartVisibility[name] = checkbox.checked;
      label.classList.toggle("is-active", checkbox.checked);
      renderAssetsReturnChart();
    });
    label.appendChild(checkbox);
    label.appendChild(swatch);
    label.appendChild(document.createTextNode(name));
    container.appendChild(label);
  });
}

function getAssetYearRange() {
  const full = derived.assetAnnualReturns;
  if (!full || !full.years.length) return [null, null];
  const maxY = full.years[full.years.length - 1];
  const yearsBack = PERIOD_YEARS_BACK[selectedAssetPeriod];
  if (!yearsBack) return [full.years[0], maxY];
  return [Math.max(maxY - (yearsBack - 1), full.years[0]), maxY];
}

function renderAssetsReturnChart() {
  const full = derived.assetAnnualReturns;
  if (!full || !full.years.length) return;
  const ctx = document.getElementById("assetsReturnChart");

  const [fromY, toY] = getAssetYearRange();
  if (fromY === null) return;
  const indices = full.years.map((y, i) => (y >= fromY && y <= toY ? i : -1)).filter((i) => i >= 0);
  const years = indices.map((i) => full.years[i]);
  const data = {
    years,
    portfolio: indices.map((i) => full.portfolio[i]),
    series: {},
    benchmark: indices.map((i) => (full.benchmark || [])[i]),
  };
  CORE_TICKERS.forEach((t) => { data.series[t] = indices.map((i) => full.series[t][i]); });

  const datasets = [];
  if (assetChartVisibility["Портфель"]) {
    datasets.push({
      label: "Портфель",
      data: data.portfolio.map((v) => (v === null ? null : v * 100)),
      borderColor: ASSET_COLORS["Портфель"],
      backgroundColor: "transparent",
      borderWidth: 2.5,
      pointRadius: 3,
      spanGaps: true,
    });
  }
  CORE_TICKERS.forEach((ticker) => {
    if (!assetChartVisibility[ticker]) return;
    datasets.push({
      label: ticker,
      data: data.series[ticker].map((v) => (v === null ? null : v * 100)),
      borderColor: ASSET_COLORS[ticker],
      backgroundColor: "transparent",
      borderWidth: 1.75,
      pointRadius: 2,
      spanGaps: true,
    });
  });
  datasets.push({
    label: "S&P 500 (ориентир, по VOO)",
    data: data.benchmark.map((v) => (v === null ? null : v * 100)),
    borderColor: "#7C8798",
    backgroundColor: "transparent",
    borderWidth: 1.5,
    borderDash: [5, 4],
    pointRadius: 0,
    spanGaps: true,
  });

  if (assetsReturnChart) assetsReturnChart.destroy();
  assetsReturnChart = new Chart(ctx, {
    type: "line",
    data: { labels: years, datasets },
    options: {
      ...chartBaseOptions(false),
      plugins: {
        legend: { display: true, position: "top", labels: { color: "#7C8798", font: { family: "IBM Plex Mono", size: 10 }, boxWidth: 10 } },
        tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${item.parsed.y === null ? "—" : item.parsed.y.toFixed(1) + "%"}` } },
      },
    },
  });
}

function renderMonthGrid() {
  const monthNames = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"];
  const head = document.getElementById("monthGridHead");
  head.innerHTML = `<tr><th>Год</th>${monthNames.map((m) => `<th>${m}</th>`).join("")}</tr>`;

  const years = Object.keys(derived.monthGrid || {}).map(Number).sort();
  const body = document.getElementById("monthGridBody");
  body.innerHTML = "";
  if (!years.length) {
    body.innerHTML = `<tr><td colspan="13" class="empty-row">Нет данных</td></tr>`;
    return;
  }
  years.forEach((y) => {
    const tr = document.createElement("tr");
    let html = `<td class="year-cell">${y}</td>`;
    for (let m = 0; m < 12; m++) {
      const entry = derived.monthGrid[y][m];
      if (entry && entry.profitPct !== null) {
        const cls = signClass(entry.profitPct);
        html += `<td class="month-cell ${cls}" data-year="${y}" data-month="${m}">${(entry.profitPct * 100).toFixed(1)}%</td>`;
      } else {
        html += `<td class="empty-cell">·</td>`;
      }
    }
    tr.innerHTML = html;
    body.appendChild(tr);
  });

  body.querySelectorAll("td.month-cell").forEach((td) => {
    td.addEventListener("click", () => {
      const y = parseInt(td.dataset.year, 10);
      const m = parseInt(td.dataset.month, 10);
      showMonthDrilldown(y, m);
    });
  });
}

function showMonthDrilldown(year, monthIndex) {
  const monthEntry = derived.monthGrid[year][monthIndex];
  const rows = computeMonthDrilldown(year, monthIndex, monthEntry);
  const monthNames = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

  document.getElementById("monthDrilldownTitle").textContent = `Активы за ${monthNames[monthIndex]} ${year}`;
  const tbody = document.getElementById("monthDrilldownBody");
  tbody.innerHTML = "";
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    if (r.isTotal) {
      tr.style.fontWeight = "600";
      tr.innerHTML = `<td>${r.ticker}</td>
        <td class="num">—</td>
        <td class="num">—</td>
        <td class="num ${signClass(r.returnPct)}">${fmtPct(r.returnPct)}</td>
        <td class="num">—</td>`;
    } else {
      const qtyNote = r.qtyDelta && Math.abs(r.qtyDelta) > 1e-9
        ? `<span class="${r.qtyDelta > 0 ? "is-positive" : "is-negative"}">${r.qtyDelta > 0 ? "+" : ""}${r.qtyDelta.toFixed(2)}</span>`
        : "—";
      tr.innerHTML = `<td>${r.ticker}</td>
        <td class="num">${fmtMoney(r.priceStart)}</td>
        <td class="num">${fmtMoney(r.priceEnd)}</td>
        <td class="num ${signClass(r.returnPct)}">${fmtPct(r.returnPct)}</td>
        <td class="num">${qtyNote}</td>`;
    }
    tbody.appendChild(tr);
  });
  document.getElementById("monthDrilldown").hidden = false;
  document.getElementById("monthDrilldown").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderTickerDetailTable() {
  const data = derived.actualPortfolio;
  const tbody = document.getElementById("tickerDetailBody");
  tbody.innerHTML = "";
  if (!data || !data.rows.length) {
    tbody.innerHTML = `<tr><td colspan="19" class="empty-row">Нет данных</td></tr>`;
    return;
  }

  const t = data.total;
  const totalTr = document.createElement("tr");
  totalTr.className = "ticker-total-row";
  totalTr.innerHTML = `<td>ПОРТФЕЛЬ</td><td class="num">—</td><td class="num">—</td><td class="num">—</td>
    <td class="num">${fmtMoney(t.value)}</td><td class="num">${(t.weight * 100).toFixed(1)}%</td>
    <td class="num ${signClass(t.plPct)}">${fmtPct(t.plPct)}</td><td class="num ${signClass(t.plAbs)}">${fmtMoney(t.plAbs)}</td>
    ${PERIOD_LABELS.map((l) => `<td class="num ${signClass(t.periods[l])}">${fmtPct(t.periods[l])}</td>`).join("")}`;
  tbody.appendChild(totalTr);

  data.rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${r.ticker}</td>
      <td class="num">${r.shares}</td>
      <td class="num">${r.avgCost === null ? "—" : fmtMoney(r.avgCost)}</td>
      <td class="num">${r.price === null ? "—" : fmtMoney(r.price)}</td>
      <td class="num">${fmtMoney(r.value)}</td>
      <td class="num">${(r.weight * 100).toFixed(1)}%</td>
      <td class="num ${signClass(r.plPct)}">${fmtPct(r.plPct)}</td>
      <td class="num ${signClass(r.plAbs)}">${fmtMoney(r.plAbs)}</td>
      ${PERIOD_LABELS.map((l) => `<td class="num ${signClass(r.periods[l])}">${fmtPct(r.periods[l])}</td>`).join("")}`;
    tbody.appendChild(tr);
  });
}

function renderPlanActual() {
  const pa = derived.planActual;
  const container = document.getElementById("planActualBody");
  if (!pa || !pa.groups.length) { container.innerHTML = ""; return; }
  container.innerHTML = "";

  const totalPct = pa.targetTotal > 0 ? Math.min(100, (pa.currentTotal / pa.targetTotal) * 100) : 0;
  const overallRow = document.createElement("div");
  overallRow.className = "plan-row plan-row--total";
  overallRow.innerHTML = `
    <div class="plan-row-header">
      <span>Портфель целиком</span>
      <span class="plan-row-figures">${fmtMoney(pa.currentTotal)} из ${fmtMoney(pa.targetTotal)} · ${totalPct.toFixed(0)}%</span>
    </div>
    <div class="plan-bar-track"><div class="plan-bar-fill" style="width:${totalPct}%; background:var(--accent-brass);"></div></div>`;
  container.appendChild(overallRow);

  const palette = ["#C39A48", "#55A776", "#C25C50", "#3E7B8C"];
  pa.groups.forEach((g, gi) => {
    const hasPlan = g.planUSD && g.planUSD > 0;
    const pct = hasPlan ? Math.min(150, (g.factUSD / g.planUSD) * 100) : (g.factUSD > 0 ? 150 : 0);
    const color = palette[gi % palette.length];
    const overWarn = hasPlan && g.factUSD > g.planUSD;

    const groupRow = document.createElement("div");
    groupRow.className = "plan-row plan-row--group";
    groupRow.innerHTML = `
      <div class="plan-row-header">
        <span><span class="swatch" style="background:${color}"></span>${g.group}</span>
        <span class="plan-row-figures">${fmtMoney(g.factUSD)} план ${hasPlan ? fmtMoney(g.planUSD) : "—"} · ${hasPlan ? pct.toFixed(0) + "%" : "нет плана"}</span>
      </div>
      <div class="plan-bar-track"><div class="plan-bar-fill ${overWarn ? "is-over" : ""}" style="width:${Math.min(100, pct)}%; background:${color};"></div></div>`;
    container.appendChild(groupRow);

    g.tickers.forEach((t) => {
      if (!t.planUSD && !t.factUSD) return;
      const tHasPlan = t.planUSD && t.planUSD > 0;
      const tPct = tHasPlan ? Math.min(150, (t.factUSD / t.planUSD) * 100) : (t.factUSD > 0 ? 150 : 0);
      const tRow = document.createElement("div");
      tRow.className = "plan-row plan-row--ticker";
      tRow.innerHTML = `
        <div class="plan-row-header">
          <span>${t.ticker}</span>
          <span class="plan-row-figures">${fmtMoney(t.factUSD)} план ${tHasPlan ? fmtMoney(t.planUSD) : "—"} · ${tHasPlan ? tPct.toFixed(0) + "%" : "—"}</span>
        </div>
        <div class="plan-bar-track plan-bar-track--sm"><div class="plan-bar-fill" style="width:${Math.min(100, tPct)}%; background:${color};"></div></div>`;
      container.appendChild(tRow);
    });
  });
}

function renderKPI() {
  const k = derived.kpi;
  if (!k) return;
  document.getElementById("kpiInvested").textContent = fmtMoney(k.invested);
  document.getElementById("kpiMarketValue").textContent = fmtMoney(k.marketValue);
  const profitEl = document.getElementById("kpiProfit");
  profitEl.textContent = fmtMoney(k.profit);
  profitEl.className = "kpi-value " + signClass(k.profit);
  const pctEl = document.getElementById("kpiProfitPct");
  pctEl.textContent = fmtPct(k.profitPct);
  pctEl.className = "kpi-value " + signClass(k.profitPct);

  const railPct = k.invested > 0 ? Math.min(100, Math.max(0, (k.marketValue / k.invested) * 50)) : 0;
  document.getElementById("kpiRailFill").style.width = railPct + "%";
}

function renderGoal() {
  const pa = derived.planActual;
  if (!pa || pa.currentTotal === null) return;
  const current = pa.currentTotal;
  const target = pa.targetTotal || 500000;
  const pct = Math.min(100, (current / target) * 100);
  document.getElementById("goalTrackFill").style.width = pct + "%";
  document.getElementById("goalCurrent").textContent = fmtMoney(current);
  document.getElementById("goalRemaining").textContent = fmtMoney(pa.remaining !== null ? pa.remaining : Math.max(0, target - current));
  document.getElementById("goalNote").textContent = `${pct.toFixed(1)}%`;
}

function renderPeriods() {
  const tbody = document.getElementById("periodsBody");
  tbody.innerHTML = "";
  if (!derived.periods.length) {
    tbody.innerHTML = '<tr><td colspan="2" class="empty-row">Нет данных</td></tr>';
    return;
  }
  derived.periods.forEach((p) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${p.label}</td><td class="num ${signClass(p.value)}">${fmtPct(p.value)}</td>`;
    tbody.appendChild(tr);
  });
}

function filterByDaysPeriod(list, period, dateGetter) {
  if (!period || period === "all") return list;
  const daysBack = PERIOD_DAYS_BACK[period];
  if (!daysBack || !list.length) return list;
  const lastDate = parseSheetDate(dateGetter(list[list.length - 1]));
  if (!lastDate) return list;
  const cutoff = new Date(lastDate.getTime() - daysBack * 86400000);
  return list.filter((item) => { const d = parseSheetDate(dateGetter(item)); return d && d >= cutoff; });
}

function renderValueChart() {
  const ctx = document.getElementById("valueChart");
  const source = derived.dailyValue && derived.dailyValue.length ? derived.dailyValue : derived.monthly;
  const filtered = filterByDaysPeriod(source, selectedValuePeriod, (m) => m.date);
  const labels = filtered.map((m) => formatDateLabel(m.date));
  const data = filtered.map((m) => convertCurrency(m.value, currentCurrency));

  if (valueChart) valueChart.destroy();
  valueChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        data,
        borderColor: "#C39A48",
        backgroundColor: "rgba(195,154,72,0.08)",
        borderWidth: 2,
        pointRadius: 0,
        fill: true,
        tension: 0.15,
      }],
    },
    options: chartBaseOptions(true),
  });
}

function renderAllocation() {
  const tbody = document.getElementById("allocationBody");
  tbody.innerHTML = "";
  if (!derived.allocation.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-row">Нет данных</td></tr>';
  } else {
    derived.allocation.forEach((a) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${a.ticker} <span style="color:var(--text-faint)">· ${a.group}</span></td>
        <td class="num">${(a.weight * 100).toFixed(1)}%</td>
        <td class="num">${fmtMoney(a.value)}</td>`;
      tbody.appendChild(tr);
    });
  }

  const ctx = document.getElementById("allocationChart");
  const palette = ["#C39A48", "#55A776", "#7C8798", "#C25C50", "#8A6F35", "#3E7B8C", "#9A6BA0"];
  if (allocationChart) allocationChart.destroy();
  allocationChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: derived.allocation.map((a) => a.ticker),
      datasets: [{
        data: derived.allocation.map((a) => a.value),
        backgroundColor: derived.allocation.map((_, i) => palette[i % palette.length]),
        borderColor: "#141A24",
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      cutout: "62%",
    },
  });
}

function renderCashflowChart() {
  const ctx = document.getElementById("cashflowChart");
  const source = derived.cashflowDaily && derived.cashflowDaily.length ? derived.cashflowDaily : derived.cashflowMonthly;
  const dateGetter = derived.cashflowDaily && derived.cashflowDaily.length ? (c) => c.date : (c) => c.month + "-01";
  const filtered = filterByDaysPeriod(source, selectedValuePeriod, dateGetter);
  const labels = filtered.map((c) => c.date || c.month);
  const data = filtered.map((c) => convertCurrency(c.amount, currentCurrency));

  if (cashflowChart) cashflowChart.destroy();
  cashflowChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: data.map((v) => (v >= 0 ? "rgba(85,167,118,0.7)" : "rgba(194,92,80,0.7)")),
        borderRadius: 2,
      }],
    },
    options: chartBaseOptions(false),
  });
}

function chartBaseOptions(showFill) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: {
        ticks: { color: "#7C8798", font: { family: "IBM Plex Mono", size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
        grid: { color: "#1E2530" },
      },
      y: {
        ticks: { color: "#7C8798", font: { family: "IBM Plex Mono", size: 10 } },
        grid: { color: "#1E2530" },
      },
    },
  };
}

function formatDateLabel(v) {
  const d = parseSheetDate(v);
  if (!d) return String(v);
  return d.toLocaleDateString("ru-RU", { year: "2-digit", month: "short" });
}

/* -------------------------- Transactions table + filters -------------------------- */

function populateTickerFilter() {
  const select = document.getElementById("tickerFilter");
  const existing = new Set(Array.from(select.options).map((o) => o.value));
  const tickers = Array.from(new Set(derived.txRows.map((t) => t.ticker))).sort();
  tickers.forEach((t) => {
    if (!existing.has(t)) {
      const opt = document.createElement("option");
      opt.value = t; opt.textContent = t;
      select.appendChild(opt);
    }
  });
}

function renderTransactions() {
  populateTickerFilter();
  applyTransactionFilters();
}

function applyTransactionFilters() {
  const tickerVal = document.getElementById("tickerFilter").value;
  const fromVal = document.getElementById("dateFilterFrom").value.trim();
  const toVal = document.getElementById("dateFilterTo").value.trim();
  const from = fromVal ? new Date(fromVal) : null;
  const to = toVal ? new Date(toVal) : null;

  let rows = derived.txRows.slice().sort((a, b) => {
    const da = parseSheetDate(a.date), db = parseSheetDate(b.date);
    return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
  });

  if (tickerVal) rows = rows.filter((r) => r.ticker === tickerVal);
  if (from) rows = rows.filter((r) => { const d = parseSheetDate(r.date); return d && d >= from; });
  if (to) rows = rows.filter((r) => { const d = parseSheetDate(r.date); return d && d <= to; });

  const tbody = document.getElementById("txBody");
  tbody.innerHTML = "";
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-row">Нет сделок по заданным фильтрам</td></tr>';
    return;
  }
  rows.slice(0, 500).forEach((r) => {
    const d = parseSheetDate(r.date);
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${d ? d.toLocaleDateString("ru-RU") : r.date}</td>
      <td>${r.ticker}</td>
      <td class="num">${r.qty}</td>
      <td class="num">${fmtMoney(r.price)}</td>
      <td class="num ${signClass(r.amount)}">${fmtMoney(r.amount)}</td>`;
    tbody.appendChild(tr);
  });
}

/* -------------------------- Currency toggle -------------------------- */

function setCurrency(ccy) {
  currentCurrency = ccy;
  document.querySelectorAll(".ccy-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.ccy === ccy));
  if (derived.kpi) renderAll();
}

/* -------------------------- Wire up UI -------------------------- */

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("signInBtn").addEventListener("click", signIn);
  document.getElementById("signOutBtn").addEventListener("click", signOut);
  document.getElementById("refreshBtn").addEventListener("click", fetchAll);
  document.querySelectorAll(".ccy-btn").forEach((btn) => {
    btn.addEventListener("click", () => setCurrency(btn.dataset.ccy));
  });
  document.getElementById("tickerFilter").addEventListener("change", applyTransactionFilters);
  document.getElementById("dateFilterFrom").addEventListener("change", applyTransactionFilters);
  document.getElementById("dateFilterTo").addEventListener("change", applyTransactionFilters);
  document.getElementById("closeDrilldown").addEventListener("click", () => {
    document.getElementById("monthDrilldown").hidden = true;
  });

  document.querySelectorAll("#valuePeriodButtons button").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedValuePeriod = btn.dataset.period;
      document.querySelectorAll("#valuePeriodButtons button").forEach((b) => b.classList.toggle("is-active", b === btn));
      renderValueChart();
      renderCashflowChart();
    });
  });

  document.querySelectorAll("#assetPeriodButtons button").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedAssetPeriod = btn.dataset.period;
      document.querySelectorAll("#assetPeriodButtons button").forEach((b) => b.classList.toggle("is-active", b === btn));
      renderAssetsReturnChart();
    });
  });

  initGis();
});
