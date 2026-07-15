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
    `${s.dashboardInputs}!A1:D40`,
  ];
}

async function fetchAll() {
  if (!accessToken) return;
  setStatus("Загружаю данные из Google Таблицы…");
  document.getElementById("refreshBtn").classList.add("spinning");

  try {
    const ranges = buildRanges();
    const params = ranges.map((r) => "ranges=" + encodeURIComponent(r)).join("&");
    const url = `${SHEETS_API}/${CFG.SPREADSHEET_ID}/values:batchGet?${params}`;
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
  computeAllocation();
  computeCashflowMonthly();
  computeGoals();
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

function parseTickerGroups() {
  const rows = raw.dashboardInputs || [];
  const map = {};
  // Блок C начинается с маркера "BLOCK_C_GROUPS" — ищем его строку, данные через 2 строки ниже
  let start = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i][0] === "BLOCK_C_GROUPS") { start = i; break; }
  }
  if (start === -1) return map;
  for (let i = start + 2; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) break;
    if (r[0] === "BLOCK_D_NETWORTH") break;
    map[r[0]] = r[1];
  }
  return map;
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

function computeAllocation() {
  const groups = parseTickerGroups();
  const assetRows = raw.assetHistory || [];
  if (assetRows.length === 0) { derived.allocation = []; return; }

  const header = assetRows[0];
  const lastDataRow = assetRows[assetRows.length - 1];

  // текущие суммарные позиции по тикеру
  const shares = {};
  derived.txRows.forEach((t) => {
    if (t.ticker === "Cash") return; // наличные не учитываются как ценные бумаги
    shares[t.ticker] = (shares[t.ticker] || 0) + t.qty;
  });

  const alloc = [];
  let totalValue = 0;
  Object.keys(shares).forEach((ticker) => {
    const qty = shares[ticker];
    if (Math.abs(qty) < 1e-9) return; // позиция закрыта
    const colIdx = header.indexOf(ticker);
    const price = colIdx >= 0 ? parseNum(lastDataRow[colIdx]) : 0;
    const value = qty * price;
    totalValue += value;
    alloc.push({ ticker, group: groups[ticker] || "Без группы", shares: qty, price, value });
  });

  alloc.forEach((a) => { a.weight = totalValue > 0 ? a.value / totalValue : 0; });
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
  const k = derived.kpi;
  const goals = derived.goals || [];
  if (!k) return;
  const goal1 = goals.find((g) => g.amount >= 400000 && g.amount < 700000) || { amount: 500000 };
  const goal2 = goals.find((g) => g.amount >= 900000) || { amount: 1000000 };

  const current = k.marketValue;
  const pctOfGoal1 = Math.min(100, (current / goal1.amount) * 100);
  document.getElementById("goalTrackFill").style.width = pctOfGoal1 + "%";
  document.getElementById("goalMarker1").style.left = "100%";
  document.getElementById("goalMarker2").style.left = Math.min(100, (goal1.amount / goal2.amount) * 100) + "%";

  document.getElementById("goalCurrent").textContent = fmtMoney(current);
  const remaining = Math.max(0, goal1.amount - current);
  document.getElementById("goalRemaining").textContent = fmtMoney(remaining);
  document.getElementById("goalNote").textContent = `${pctOfGoal1.toFixed(1)}% от $${(goal1.amount / 1000).toFixed(0)}K`;
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

function renderValueChart() {
  const ctx = document.getElementById("valueChart");
  const labels = derived.monthly.map((m) => formatDateLabel(m.date));
  const data = derived.monthly.map((m) => convertCurrency(m.value, currentCurrency));

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
      responsive: false,
      plugins: { legend: { display: false } },
      cutout: "62%",
    },
  });
}

function renderCashflowChart() {
  const ctx = document.getElementById("cashflowChart");
  const labels = derived.cashflowMonthly.map((c) => c.month);
  const data = derived.cashflowMonthly.map((c) => convertCurrency(c.amount, currentCurrency));

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

  initGis();
});
