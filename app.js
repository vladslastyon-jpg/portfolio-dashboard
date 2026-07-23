/* ==========================================================================
   Дашборд «Анализ портфеля» — основная логика.
   Архитектура: чтение Google Sheets API v4 через OAuth (Google Identity
   Services), без сервера. Поддерживает ДВА независимых портфеля на одном
   сайте (свой и Алены) через фабрику createProfile() — каждый инстанс
   держит свои raw/derived/чарты и читает свою Google Таблицу, но общие
   чистые хелперы (форматирование, парсинг дат и т.д.) и авторизация — одни
   на весь сайт.
   ========================================================================== */

const CFG = window.DASHBOARD_CONFIG;
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

let accessToken = null;
let tokenClient = null;
let currentCurrency = "USD";
let eurUsdRate = null; // сколько USD за 1 EUR

const PERIOD_DAYS_BACK = { "1d": 1, "1w": 7, "1m": 30, "1y": 365, "5y": 1825 };

/* -------------------------- общие чистые хелперы (не зависят от портфеля) -------------------------- */

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

function toISODateKey(v) {
  const d = parseSheetDate(v);
  return d ? d.toISOString().slice(0, 10) : null;
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

function formatDateLabel(v) {
  const d = parseSheetDate(v);
  if (!d) return String(v);
  return d.toLocaleDateString("ru-RU", { year: "2-digit", month: "short" });
}

function getGroupBaseColor(groupName) {
  const g = (groupName || "").toUpperCase();
  if (g.includes("ГЛОБАЛЬН")) return "#4A2E6D";   // тёмно-фиолетовый — S&P 500
  if (g.includes("АГРЕССИВН")) return "#1E5631";  // тёмно-зелёный — Сателлиты
  if (g.includes("ИНДИВИДУАЛ")) return "#1B3A6B"; // тёмно-синий — Индивидуальные акции
  if (g.includes("ЗАЩИТ")) return "#7A6417";      // тёмно-жёлтый — Защита/Ликвидность
  return "#5A5240";
}

function lightenHex(hex, amount) {
  const num = parseInt(hex.slice(1), 16);
  let r = (num >> 16) + Math.round(255 * amount);
  let g = ((num >> 8) & 0xff) + Math.round(255 * amount);
  let b = (num & 0xff) + Math.round(255 * amount);
  r = Math.min(255, r); g = Math.min(255, g); b = Math.min(255, b);
  return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");
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

function fmtMoneyNoDecimals(value) {
  if (value === null || value === undefined || isNaN(value)) return "—";
  const converted = convertCurrency(value, currentCurrency);
  const symbol = currentCurrency === "EUR" ? "€" : "$";
  const sign = converted < 0 ? "-" : "";
  return `${sign}${symbol}${Math.round(Math.abs(converted)).toLocaleString("en-US")}`;
}

function numOrNull(v) {
  if (v === "" || v === undefined || v === null || v === "-" || v === "−") return null;
  if (typeof v === "string" && !/[0-9]/.test(v)) return null;
  const n = parseNum(v);
  return isNaN(n) ? null : n;
}

/* -------------------------- Google Identity Services (общие на весь сайт) -------------------------- */

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

/**
 * После входа — загружаем данные ОБОИХ портфелей (твоего и Алены) сразу,
 * чтобы переключение между вкладками было мгновенным (без повторного
 * похода в Google Sheets API). Если у второй таблицы ещё не настроен
 * реальный Spreadsheet ID (плейсхолдер) — её fetchAll молча завершится
 * ошибкой в своей вкладке, но это не помешает основному портфелю.
 */
function onSignedIn() {
  document.getElementById("signInBtn").hidden = true;
  document.getElementById("userChip").hidden = false;
  document.getElementById("userEmail").textContent = "подключено";
  document.getElementById("signedOutHint").hidden = true;
  mainProfile.fetchAll();
  alenaProfile.fetchAll();
}

function createProfile(opts) {
  const { prefix, label, spreadsheetId, sheets, coreTickers, assetColors, hasGoalPanel, hasPlan, indexTickers, benchmarkTicker } = opts;

  function pid(base) {
    if (base === "app" || base === "refreshBtn") return base;
    if (!prefix) return base;
    return prefix + base.charAt(0).toUpperCase() + base.slice(1);
  }

  // Её портфель ведётся в EUR "от природы" (Транзакции/Asset_History уже в
  // евро) — в отличие от твоего (нативно в USD). Поэтому для профиля с
  // nativeCurrency === "EUR" переопределяем форматирование локально (внутри
  // этого замыкания): всегда показываем € и НИКОГДА не делим/умножаем на
  // eurUsdRate — общий переключатель USD/EUR в шапке сайта на её вкладку не
  // влияет, т.к. эти локальные версии функций затеняют глобальные (JS
  // разрешает вызовы вроде fmtMoney(...) внутри фабрики в первую очередь на
  // эти локальные, если они определены). Для твоего профиля (nativeCurrency
  // === "USD") ничего не переопределяем — там всё работает как раньше.
  let fmtMoney, fmtMoneyNoDecimals;
  if (opts.nativeCurrency === "EUR") {
    fmtMoney = function (value) {
      if (value === null || value === undefined || isNaN(value)) return "—";
      const sign = value < 0 ? "-" : "";
      return `${sign}€${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    };
    fmtMoneyNoDecimals = function (value) {
      if (value === null || value === undefined || isNaN(value)) return "—";
      const sign = value < 0 ? "-" : "";
      return `${sign}€${Math.round(Math.abs(value)).toLocaleString("en-US")}`;
    };
  } else {
    // Твой профиль (USD) — делегируем на исходную глобальную логику
    // (учитывает переключатель USD/EUR в шапке как раньше), поведение не
    // меняется.
    fmtMoney = window.fmtMoney;
    fmtMoneyNoDecimals = window.fmtMoneyNoDecimals;
  }

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
    kpi: null,
    periods: [],
    monthly: [],
    allocation: [],
    txRows: [],
    cashflowMonthly: [],
    goals: [],
  };

  let valueChart = null;
  let allocationChart = null;
  let assetsReturnChart = null;
  let pensionChart = null;

  const assetChartVisibility = { Портфель: true };
  coreTickers.forEach((t) => { assetChartVisibility[t] = false; });
  let selectedAssetPeriod = "all";
  let selectedValuePeriod = "all";

function buildRanges() {
  const s = sheets;
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
    const url = `${SHEETS_API}/${spreadsheetId}/values:batchGet?${params}&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`;
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
  computeMonthGrid();
  computeDailyPortfolioValue();
}

/* -------------------------- Pension calculator (раздел "Пенсия") -------------------------- */

function getPensionInputs() {
  const nominalReturn = (parseNum(document.getElementById(pid("pNominalReturn")).value) || 0) / 100;
  const inflation = (parseNum(document.getElementById(pid("pInflation")).value) || 0) / 100;
  const realReturn = (1 + nominalReturn) / (1 + inflation) - 1;
  const targetIncomeMonthly = parseNum(document.getElementById(pid("pTargetIncomeMonthly")).value) || 0;
  return {
    age: parseNum(document.getElementById(pid("pAge")).value) || 35,
    retireAge: parseNum(document.getElementById(pid("pRetireAge")).value) || 62,
    endAge: parseNum(document.getElementById(pid("pEndAge")).value) || 100,
    nominalReturn,
    inflation,
    returnRate: realReturn, // реальная доходность (уже без инфляции), используется во всех расчётах ниже
    withdrawRate: (parseNum(document.getElementById(pid("pWithdrawRate")).value) || 4) / 100,
    targetIncomeMonthly,
    targetIncome: targetIncomeMonthly * 12,
  };
}

/**
 * Год за годом наращивает капитал: текущий портфель (KPI "Рыночная стоимость")
 * растёт на реальную доходность (номинальная минус инфляция) в год —
 * фаза накопления (без новых довнесений, только рост существующего капитала).
 * После выхода на пенсию — фаза вывода: капитал продолжает расти на ту же
 * реальную доходность, но каждый год из него вычитается ровно целевой
 * пассивный доход (targetIncome, в сегодняшних деньгах) — то есть именно
 * та сумма, которую человек хочет получать, а не пересчитанная от капитала.
 * Считаем оба этапа вместе до endAge (по умолчанию 100 лет), чтобы видеть,
 * хватит ли денег на всю жизнь или они закончатся раньше.
 */
function computePensionProjection() {
  const inputs = getPensionInputs();
  const current = derived.kpi ? derived.kpi.marketValue : 0;
  const yearsToRetire = Math.max(0, inputs.retireAge - inputs.age);
  const totalYears = Math.max(0, inputs.endAge - inputs.age);
  const annualWithdrawal = inputs.targetIncome;

  const rows = [];
  let capital = current;
  let depletedAtAge = null;
  const startYear = new Date().getFullYear();

  for (let y = 1; y <= totalYears; y++) {
    const age = inputs.age + y;
    const isRetired = age > inputs.retireAge;

    if (!isRetired) {
      capital = capital * (1 + inputs.returnRate);
    } else {
      capital = capital * (1 + inputs.returnRate) - annualWithdrawal;
      if (capital < 0) capital = 0;
    }

    if (capital <= 0 && depletedAtAge === null && isRetired) depletedAtAge = age;

    rows.push({
      year: startYear + y,
      age,
      phase: isRetired ? "Пенсия" : "Накопление",
      contribution: 0,
      withdrawal: isRetired ? annualWithdrawal : 0,
      capital,
      monthlyIncome: isRetired ? annualWithdrawal / 12 : (capital * inputs.withdrawRate) / 12,
    });
  }

  const retirementRow = rows.find((r) => r.age === inputs.retireAge) || rows[rows.length - 1] || { capital: current };
  const projected = retirementRow.capital;
  const requiredCapital = inputs.withdrawRate > 0 ? inputs.targetIncome / inputs.withdrawRate : null;
  const projectedMonthlyIncome = (projected * inputs.withdrawRate) / 12;

  return {
    inputs, current, years: yearsToRetire, rows, projected, requiredCapital,
    projectedMonthlyIncome, depletedAtAge, endAge: inputs.endAge,
  };
}

function renderPension() {
  if (!derived.kpi) return;
  const p = computePensionProjection();

  document.getElementById(pid("pKpiCurrent")).textContent = fmtMoney(p.current);
  document.getElementById(pid("pKpiYears")).textContent = p.years;
  document.getElementById(pid("pKpiProjected")).textContent = fmtMoney(p.projected);
  document.getElementById(pid("pKpiRequired")).textContent = p.requiredCapital === null ? "—" : fmtMoney(p.requiredCapital);
  const incomeEl = document.getElementById(pid("pKpiIncome"));
  incomeEl.textContent = fmtMoney(p.projectedMonthlyIncome);
  incomeEl.className = "kpi-value " + signClass(p.requiredCapital !== null ? p.projected - p.requiredCapital : null);

  if (p.requiredCapital !== null && p.requiredCapital > 0) {
    const pct = Math.min(100, (p.projected / p.requiredCapital) * 100);
    document.getElementById(pid("pGoalTrackFill")).style.width = pct + "%";
    document.getElementById(pid("pGoalNote")).textContent = pct.toFixed(1) + "%";
    const gap = Math.max(0, p.requiredCapital - p.projected);
    document.getElementById(pid("pGoalGap")).textContent = gap > 0 ? fmtMoney(gap) : "цель достигнута";
    const incomeGap = p.projectedMonthlyIncome - p.inputs.targetIncome / 12;
    const incomeGapEl = document.getElementById(pid("pIncomeGap"));
    incomeGapEl.textContent = (incomeGap >= 0 ? "+" : "") + fmtMoney(incomeGap);
    incomeGapEl.className = "figure-value " + signClass(incomeGap);
  } else {
    document.getElementById(pid("pGoalTrackFill")).style.width = "0%";
    document.getElementById(pid("pGoalNote")).textContent = "—";
    document.getElementById(pid("pGoalGap")).textContent = "—";
    document.getElementById(pid("pIncomeGap")).textContent = "—";
  }

  const depletionEl = document.getElementById(pid("pDepletionNote"));
  if (depletionEl) {
    if (p.depletedAtAge !== null) {
      depletionEl.textContent = `⚠ При текущих параметрах капитал заканчивается в ${p.depletedAtAge} лет (до ${p.endAge} не хватает)`;
      depletionEl.className = "panel-note is-negative";
    } else {
      depletionEl.textContent = `Капитала хватает минимум до ${p.endAge} лет`;
      depletionEl.className = "panel-note is-positive";
    }
  }

  const tbody = document.getElementById(pid("pensionTableBody"));
  tbody.innerHTML = "";
  if (!p.rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-row">Проверь возраста в параметрах</td></tr>';
  } else {
    p.rows.forEach((r) => {
      const tr = document.createElement("tr");
      if (r.age === p.inputs.retireAge) tr.classList.add("ticker-total-row");
      tr.innerHTML = `<td class="num">${r.age}</td><td>${r.phase}</td>
        <td class="num">${r.withdrawal ? "-" + fmtMoney(r.withdrawal) : "—"}</td>
        <td class="num${r.capital <= 0 ? " is-negative" : ""}">${fmtMoney(r.capital)}</td>
        <td class="num">${fmtMoney(r.monthlyIncome)}</td>`;
      tbody.appendChild(tr);
    });
  }

  const ctx = document.getElementById(pid("pensionChart"));
  const labels = ["сейчас", ...p.rows.map((r) => String(r.age))];
  const dataPoints = [p.current, ...p.rows.map((r) => r.capital)];
  const retireIdx = 1 + p.rows.findIndex((r) => r.age === p.inputs.retireAge);
  // Разбиваем на два датасета (накопление / пенсия), чтобы легенда явно
  // показывала, где начинается фаза вывода — не только цветом линии.
  const accumData = dataPoints.map((v, i) => (i <= retireIdx ? v : null));
  const drawdownData = dataPoints.map((v, i) => (i >= retireIdx ? v : null));
  if (pensionChart) pensionChart.destroy();
  pensionChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Капитал — накопление",
          data: accumData.map((v) => (v === null ? null : convertCurrency(v, currentCurrency))),
          borderColor: "#C39A48",
          backgroundColor: "rgba(195,154,72,0.10)",
          borderWidth: 2.5,
          pointRadius: 0,
          fill: true,
          tension: 0.1,
          spanGaps: false,
        },
        {
          label: "Капитал — на пенсии (вывод)",
          data: drawdownData.map((v) => (v === null ? null : convertCurrency(v, currentCurrency))),
          borderColor: "#3E7B8C",
          backgroundColor: "rgba(62,123,140,0.12)",
          borderWidth: 2.5,
          pointRadius: 0,
          fill: true,
          tension: 0.1,
          spanGaps: false,
        },
        ...(p.requiredCapital !== null
          ? [{
              label: "Нужный капитал",
              data: dataPoints.map(() => convertCurrency(p.requiredCapital, currentCurrency)),
              borderColor: "#7C8798",
              backgroundColor: "transparent",
              borderWidth: 1.5,
              borderDash: [5, 4],
              pointRadius: 0,
            }]
          : []),
      ],
    },
    options: {
      ...chartBaseOptions(false),
      plugins: {
        legend: { display: true, position: "top", labels: { color: "#7C8798", font: { family: "IBM Plex Mono", size: 10 }, boxWidth: 10 } },
        tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${fmtMoney(convertCurrency(dataPoints[item.dataIndex], "USD"))}` } },
      },
    },
  });
}

function wirePensionInputs() {
  const ids = ["pAge", "pRetireAge", "pEndAge", "pNominalReturn", "pInflation", "pWithdrawRate", "pTargetIncomeMonthly"];
  ids.forEach((id) => {
    document.getElementById(pid(id)).addEventListener("input", () => {
      updateTargetIncomeYearlyDisplay();
      if (derived.kpi) renderPension();
      renderWhatIf();
    });
  });
  updateTargetIncomeYearlyDisplay();

  ["wCapitalNow", "wSpendMonthly"].forEach((id) => {
    document.getElementById(pid(id)).addEventListener("input", renderWhatIf);
  });
  renderWhatIf();
}

function updateTargetIncomeYearlyDisplay() {
  const monthly = parseNum(document.getElementById(pid("pTargetIncomeMonthly")).value) || 0;
  const yearlyEl = document.getElementById(pid("pTargetIncomeYearly"));
  if (yearlyEl) yearlyEl.textContent = `≈ ${fmtMoney(monthly * 12, "USD")}/год`;
}

/**
 * Два независимых калькулятора "что если", используют возраст/возраст выхода
 * и реальную доходность (номинальная минус инфляция) из общих параметров
 * расчёта пенсии, но со своим собственным капиталом/тратами — не привязаны
 * к текущему реальному портфелю и к целевому доходу выше.
 *
 * Прямой: если сейчас есть X — вырастет за yearsToRetire лет на реальную
 * доходность (без довнесений) → сколько можно тратить в месяц на пенсии
 * при заданной ставке вывода.
 *
 * Обратный: чтобы тратить X в месяц на пенсии (в сегодняшних деньгах) —
 * сколько нужно капитала на момент выхода (X×12/ставка вывода), и дисконтируем
 * эту сумму назад к сегодняшнему дню той же реальной доходностью, чтобы
 * узнать, сколько нужно иметь уже сейчас.
 */
function renderWhatIf() {
  const inputs = getPensionInputs();
  const years = Math.max(0, inputs.retireAge - inputs.age);
  const growthFactor = Math.pow(1 + inputs.returnRate, years);

  const capitalNow = parseNum(document.getElementById(pid("wCapitalNow")).value) || 0;
  const projectedAtRetire = capitalNow * growthFactor;
  const canSpendMonthly = (projectedAtRetire * inputs.withdrawRate) / 12;
  document.getElementById(pid("wProjectedAtRetireLabel")).textContent = `Вырастет к ${inputs.retireAge} годам (реальными деньгами)`;
  document.getElementById(pid("wProjectedAtRetire")).textContent = fmtMoney(projectedAtRetire);
  document.getElementById(pid("wCanSpendMonthly")).textContent = fmtMoney(canSpendMonthly) + "/мес";

  const spendMonthly = parseNum(document.getElementById(pid("wSpendMonthly")).value) || 0;
  const requiredAtRetire = inputs.withdrawRate > 0 ? (spendMonthly * 12) / inputs.withdrawRate : null;
  const requiredNow = requiredAtRetire !== null && growthFactor > 0 ? requiredAtRetire / growthFactor : null;
  document.getElementById(pid("wRequiredAtRetire")).textContent = requiredAtRetire === null ? "—" : fmtMoney(requiredAtRetire);
  document.getElementById(pid("wRequiredNow")).textContent = requiredNow === null ? "—" : fmtMoney(requiredNow);
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

function computeAssetGrowthSeries(period) {
  const rows = raw.assetHistory || [];
  if (rows.length < 2) return { labels: [], series: {}, portfolio: [], benchmark: [] };
  const header = rows[0];
  const dataRows = rows.slice(1);
  const filtered = filterByDaysPeriod(dataRows, period, (r) => r[0]);
  if (!filtered.length) return { labels: [], series: {}, portfolio: [], benchmark: [] };

  const labels = filtered.map((r) => formatDateLabel(r[0]));
  const series = {};
  coreTickers.forEach((ticker) => {
    const colIdx = header.indexOf(ticker);
    if (colIdx === -1) { series[ticker] = filtered.map(() => null); return; }
    const firstPrice = parseNum(filtered[0][colIdx]);
    series[ticker] = filtered.map((r) => {
      const p = parseNum(r[colIdx]);
      return firstPrice > 0 && p ? (p / firstPrice - 1) * 100 : null;
    });
  });

  const portfolio = computePortfolioReturnSeries(filtered.map((r) => parseSheetDate(r[0])));

  return { labels, series, portfolio, benchmark: series[benchmarkTicker] || [] };
}

/**
 * Строит "чистую" траекторию доходности портфеля (в %), без искажения от
 * довнесений — компаундим уже готовые помесячные Modified Dietz доходности
 * из Portfolio_Monthly (derived.monthly), а не сырое отношение стоимости
 * (которое росло бы и от новых покупок, а не только от роста цены).
 * Значение "протягивается" по дням до следующего месяца, аналогично тому,
 * как в самой таблице протягиваются цены между торговыми днями.
 */
/**
 * Ежедневная "чистая" доходность портфеля: для каждого дня берём изменение
 * стоимости и вычитаем ровно ту сумму, что в этот день была довнесена/выведена
 * (по Транзакции), — получаем прирост исключительно от движения цены.
 * Компаундим по всем дням — получаем гладкий ежедневный индекс роста, без
 * ступенек и без искажения от новых покупок (та же идея, что Modified Dietz
 * в самой таблице, только на дневном шаге вместо месячного).
 */
function computeDailyCashflowMap() {
  const tracked = derived.trackedTickers || null; // тикеры, реально отслеживаемые в Asset_History
  const map = {};
  derived.txRows.forEach((t) => {
    if (t.ticker === "Cash") return;
    // Сделки по тикерам, которых нет в Asset_History (старые отдельные акции,
    // распроданные до перехода на текущую ETF-стратегию), не должны искажать
    // дневной индекс доходности "основного" портфеля — у нас просто нет для
    // них исторических котировок, чтобы корректно посчитать их вклад.
    if (tracked && !tracked.has(t.ticker)) return;
    const key = toISODateKey(t.date);
    if (!key) return;
    map[key] = (map[key] || 0) + t.amount;
  });
  return map;
}

function computePortfolioGrowthIndexDaily() {
  const dv = derived.dailyValue || [];
  if (dv.length < 2) return [];
  const flows = computeDailyCashflowMap();
  // Минимальная "осмысленная" база для расчёта дневного %. Пока портфель
  // стоит меньше этого порога (например, только крошечные подарочные акции
  // до первой реальной покупки), деление на такую почти нулевую базу даёт
  // математически корректный, но бессмысленно огромный % (сотни процентов
  // за один день) — который потом навсегда "застревает" в накопительном
  // индексе и выглядит как обвал/скачок на графике. Пока vPrev меньше
  // порога, просто не начисляем % в этот день (ret=0) — по сути это ещё
  // "затравочная" фаза, а не реальная доходность.
  const MIN_MEANINGFUL_BASE = 100;
  let cum = 1;
  const points = [{ date: parseSheetDate(dv[0].date), cum }];
  for (let i = 1; i < dv.length; i++) {
    const vPrev = dv[i - 1].value;
    const vCur = dv[i].value;
    const flow = flows[toISODateKey(dv[i].date)] || 0;
    const ret = vPrev > MIN_MEANINGFUL_BASE ? (vCur - vPrev - flow) / vPrev : 0;
    cum *= (1 + ret);
    points.push({ date: parseSheetDate(dv[i].date), cum });
  }
  return points;
}

/**
 * ВРЕМЕННАЯ ОТЛАДКА (можно удалить после диагностики "обвала" на графике
 * "Доходность по активам"). Вызвать в консоли браузера на живом сайте:
 *   window.debugPortfolioReturns("2024-06-20", "2024-07-15")
 * Выведет таблицу по дням: стоимость портфеля (value), денежный поток (flow)
 * и посчитанную дневную доходность (ret, в %) — чтобы найти точный день и
 * точные цифры, которые ломают накопительный индекс.
 */
window["debugPortfolioReturns_" + label] = function (fromISO, toISO) {
  const dv = derived.dailyValue || [];
  const flows = computeDailyCashflowMap();
  const from = fromISO ? new Date(fromISO) : null;
  const to = toISO ? new Date(toISO) : null;
  const rows = [];
  for (let i = 1; i < dv.length; i++) {
    const d = parseSheetDate(dv[i].date);
    if (from && d < from) continue;
    if (to && d > to) continue;
    const vPrev = dv[i - 1].value;
    const vCur = dv[i].value;
    const key = toISODateKey(dv[i].date);
    const flow = flows[key] || 0;
    const ret = vPrev > 0 ? (vCur - vPrev - flow) / vPrev : 0;
    rows.push({
      date: key,
      vPrev: Math.round(vPrev),
      vCur: Math.round(vCur),
      flow: Math.round(flow),
      "ret,%": (ret * 100).toFixed(1),
    });
  }
  console.table(rows);
  return rows;
};

function computePortfolioReturnSeries(dates) {
  if (!dates.length) return [];
  const cumPoints = derived.portfolioGrowthIndex || (derived.portfolioGrowthIndex = computePortfolioGrowthIndexDaily());
  if (!cumPoints.length) return dates.map(() => null);

  function cumAt(targetDate) {
    let result = null;
    for (let i = cumPoints.length - 1; i >= 0; i--) {
      if (cumPoints[i].date && cumPoints[i].date <= targetDate) { result = cumPoints[i].cum; break; }
    }
    return result;
  }

  const baseline = cumAt(dates[0]) ?? cumPoints[0].cum;
  return dates.map((d) => {
    const c = cumAt(d);
    return c !== null && baseline ? (c / baseline - 1) * 100 : null;
  });
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

  coreTickers.forEach((ticker) => {
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

    const returnAbs = sharesStart * (priceEnd - priceStart);
    rows.push({ ticker, returnPct, returnAbs, qtyDelta });
  });

  const portfolioReturn = monthEntry.profitPct !== null && monthEntry.profitPct !== undefined
    ? monthEntry.profitPct
    : (totalStartValue > 0 ? weightedNumerator / totalStartValue : null);
  const portfolioReturnAbs = monthEntry.profitAbs !== null && monthEntry.profitAbs !== undefined ? monthEntry.profitAbs : null;

  rows.push({ ticker: "Портфель целиком", returnPct: portfolioReturn, returnAbs: portfolioReturnAbs, qtyDelta: null, isTotal: true });
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



function computeTickerDetailTable() {
  derived.actualPortfolio = parseActualPortfolioSheet();
}

/**
 * Читает лист «портфель 500к» НАПРЯМУЮ — план/факт по группам и тикерам,
 * плюс авторитетные цифры цели (текущий объём / цель / осталось добрать).
 * Структура: B2=текущий объём, D2=цель, G2=осталось добрать.
 * С 6-й строки: блоки — строка группы, затем строки тикеров, разделены пустой строкой.
 */
function findLabelValue(rows, labelSubstring, maxScanRows) {
  for (let r = 0; r < Math.min(maxScanRows, rows.length); r++) {
    const row = rows[r] || [];
    const idx = row.findIndex((c) => typeof c === "string" && c.toUpperCase().includes(labelSubstring.toUpperCase()));
    if (idx === -1) continue;
    // сначала ищем число в той же строке правее подписи
    for (let col = idx; col < idx + 4 && col < row.length; col++) {
      const n = numOrNull(row[col]);
      if (n !== null) return n;
    }
    // если не нашли — пробуем строку ниже, в том же диапазоне колонок
    const nextRow = rows[r + 1] || [];
    for (let col = Math.max(0, idx - 1); col < idx + 4 && col < nextRow.length; col++) {
      const n = numOrNull(nextRow[col]);
      if (n !== null) return n;
    }
  }
  return null;
}

function parsePortfolio500kSheet() {
  const rows = raw.portfolio500k || [];
  if (rows.length < 2) return { currentTotal: null, targetTotal: null, remaining: null, groups: [] };

  let totalRowIdx = rows.findIndex((r) => r && typeof r[0] === "string" && r[0].toUpperCase().includes("ПОРТФЕЛЬ"));
  if (totalRowIdx === -1) totalRowIdx = 5;
  const totalRow = rows[totalRowIdx] || [];

  // Основной источник — сама строка "ПОРТФЕЛЬ — ИТОГО" (та же структура колонок,
  // что и у групп/тикеров ниже, поэтому индексы гарантированно верные).
  // Поиск по подписям ("Текущий объём" и т.д.) — запасной вариант, если верхний
  // блок ячеек когда-нибудь появится в другом виде.
  const currentTotal = numOrNull(totalRow[1]) ?? findLabelValue(rows, "ТЕКУЩ", 4);
  const targetTotal = numOrNull(totalRow[3]) ?? findLabelValue(rows, "ЦЕЛЬ", 4);
  const remainingFromHeader = findLabelValue(rows, "ОСТАЛ", 4);
  const remaining = remainingFromHeader !== null
    ? remainingFromHeader
    : (currentTotal !== null && targetTotal !== null ? Math.max(0, targetTotal - currentTotal) : null);

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
  if (!hasPlan) { derived.planActual = null; return; }
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

/**
 * Без плана (hasPlan=false) строим "Структуру портфеля" напрямую из
 * «Актуальный Портфель» — двумя группами, без обращения к «портфель 500к»:
 * 1) indexTickers (у Алены — CSPX) → группа "I. Глобальное Ядро (S&P 500)"
 * 2) всё остальное (включая Cash) → "II. Индивидуальные Акции"
 * Названия групп специально совпадают по ключевым словам с
 * getGroupBaseColor(), чтобы получить те же фирменные цвета (фиолетовый/
 * синий), что и на вкладке с планом.
 */
function computeAllocationNoPlan() {
  const rows = derived.actualPortfolio?.rows || [];
  const totalValue = rows.reduce((s, r) => s + (r.value || 0), 0);
  const alloc = [];
  rows.forEach((r) => {
    if (!r.value) return;
    const group = indexTickers.includes(r.ticker) ? "I. Глобальное Ядро (S&P 500)" : "II. Индивидуальные Акции";
    alloc.push({
      ticker: r.ticker,
      group,
      value: r.value,
      weight: totalValue > 0 ? r.value / totalValue : 0,
    });
  });
  derived.allocation = alloc;
}

function computeAllocation() {
  if (!hasPlan) { computeAllocationNoPlan(); return; }
  const groups = derived.planActual?.groups || [];
  const totalValue = groups.reduce((s, g) => s + (g.factUSD || 0), 0);

  const alloc = [];
  groups.forEach((g) => {
    g.tickers.forEach((t) => {
      if (!t.factUSD) return;
      alloc.push({
        ticker: t.ticker,
        group: g.group,
        value: t.factUSD,
        weight: totalValue > 0 ? t.factUSD / totalValue : 0,
      });
    });
  });
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
  derived.portfolioGrowthIndex = null;
  const rows = raw.assetHistory || [];
  if (rows.length < 2) { derived.dailyValue = []; derived.trackedTickers = new Set(); return; }
  const header = rows[0];
  const tickerCols = header
    .map((name, col) => ({ ticker: name, col }))
    .filter((tc) => tc.col > 0 && tc.ticker);
  derived.trackedTickers = new Set(tickerCols.map((tc) => tc.ticker));

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
  const lastKnownPrice = {};
  tickerCols.forEach(({ ticker }) => { sharesState[ticker] = 0; txIndex[ticker] = 0; lastKnownPrice[ticker] = 0; });

  const out = [];
  const detail = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const date = parseSheetDate(row[0]);
    if (!date) continue;
    let total = 0;
    const byTicker = {};
    tickerCols.forEach(({ ticker, col }) => {
      const txs = txByTicker[ticker] || [];
      while (txIndex[ticker] < txs.length) {
        const txDate = parseSheetDate(txs[txIndex[ticker]].date);
        if (txDate && txDate <= date) {
          sharesState[ticker] += txs[txIndex[ticker]].qty;
          txIndex[ticker]++;
        } else break;
      }
      // Переносим последнюю известную цену вперёд, если на эту дату в
      // Asset_History разрыв/0 (защита от "пилы" в графике доходности —
      // без переноса момент отсутствующей котировки одного тикера обнулял
      // его вклад в стоимость портфеля на этот день и создавал провал/скачок).
      const cellPrice = parseNum(row[col]);
      if (cellPrice) lastKnownPrice[ticker] = cellPrice;
      const price = lastKnownPrice[ticker];
      const shares = sharesState[ticker];
      const value = Math.abs(shares) > 1e-9 && price ? shares * price : 0;
      byTicker[ticker] = { shares, price, value };
      total += value;
    });
    if (total > 0) out.push({ date: row[0], value: total });
  }
  derived.dailyValue = out;
}



/* -------------------------- Rendering -------------------------- */

function renderAll() {
  renderKPI();
  if (hasGoalPanel) renderGoal();
  renderValueChart();
  renderAllocation();
  renderTransactions();
  renderAssetCheckboxes();
  renderAssetsReturnChart();
  renderMonthGrid();
  renderTickerDetailTable();
  if (hasPlan) renderPlanActual();
  renderPension();
}

function renderAssetCheckboxes() {
  const container = document.getElementById(pid("assetCheckboxes"));
  if (container.dataset.built) return;
  container.dataset.built = "1";
  const names = ["Портфель", ...coreTickers];
  names.forEach((name) => {
    const label = document.createElement("label");
    label.className = "asset-chip" + (assetChartVisibility[name] ? " is-active" : "");
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = assetColors[name];
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

function renderAssetsReturnChart() {
  const data = computeAssetGrowthSeries(selectedAssetPeriod);
  if (!data.labels.length) return;
  const ctx = document.getElementById(pid("assetsReturnChart"));

  const datasets = [];
  if (assetChartVisibility["Портфель"]) {
    datasets.push({
      label: "Портфель",
      data: data.portfolio,
      borderColor: assetColors["Портфель"],
      backgroundColor: "transparent",
      borderWidth: 2.5,
      pointRadius: 0,
      spanGaps: true,
    });
  }
  coreTickers.forEach((ticker) => {
    if (!assetChartVisibility[ticker]) return;
    datasets.push({
      label: ticker,
      data: data.series[ticker],
      borderColor: assetColors[ticker],
      backgroundColor: "transparent",
      borderWidth: 1.75,
      pointRadius: 0,
      spanGaps: true,
    });
  });
  datasets.push({
    label: `S&P 500 (ориентир, по ${benchmarkTicker})`,
    data: data.benchmark,
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
    data: { labels: data.labels, datasets },
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
  const head = document.getElementById(pid("monthGridHead"));
  head.innerHTML = `<tr><th>Год</th>${monthNames.map((m) => `<th>${m}</th>`).join("")}</tr>`;

  const years = Object.keys(derived.monthGrid || {}).map(Number).sort();
  const body = document.getElementById(pid("monthGridBody"));
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
        const amt = entry.profitAbs !== null ? fmtMoney(entry.profitAbs) : "";
        html += `<td class="month-cell ${cls}" data-year="${y}" data-month="${m}">${amt} (${(entry.profitPct * 100).toFixed(1)}%)</td>`;
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

  document.getElementById(pid("monthDrilldownTitle")).textContent = `Активы за ${monthNames[monthIndex]} ${year}`;
  const tbody = document.getElementById(pid("monthDrilldownBody"));
  tbody.innerHTML = "";
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    if (r.isTotal) tr.style.fontWeight = "600";
    tr.innerHTML = `<td>${r.ticker}</td>
      <td class="num ${signClass(r.returnPct)}">${fmtPct(r.returnPct)}</td>
      <td class="num ${signClass(r.returnAbs)}">${r.returnAbs === null ? "—" : fmtMoney(r.returnAbs)}</td>`;
    tbody.appendChild(tr);
  });
  document.getElementById(pid("monthDrilldown")).hidden = false;
  document.getElementById(pid("monthDrilldown")).scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderTickerDetailTable() {
  const data = derived.actualPortfolio;
  const tbody = document.getElementById(pid("tickerDetailBody"));
  tbody.innerHTML = "";
  if (!data || !data.rows.length) {
    tbody.innerHTML = `<tr><td colspan="16" class="empty-row">Нет данных</td></tr>`;
    return;
  }

  const t = data.total;
  const totalTr = document.createElement("tr");
  totalTr.className = "ticker-total-row";
  totalTr.innerHTML = `<td>ПОРТФЕЛЬ</td><td class="num">—</td><td class="num">—</td><td class="num">—</td>
    <td class="num">${fmtMoney(t.value)}</td>
    ${PERIOD_LABELS.map((l) => `<td class="num ${signClass(t.periods[l])}">${fmtPct(t.periods[l])}</td>`).join("")}`;
  tbody.appendChild(totalTr);

  data.rows.forEach((r) => {
    const tr = document.createElement("tr");
    const underwater = r.price !== null && r.avgCost !== null && r.price < r.avgCost;
    tr.innerHTML = `<td>${r.ticker}</td>
      <td class="num">${r.shares}</td>
      <td class="num">${r.avgCost === null ? "—" : fmtMoney(r.avgCost)}</td>
      <td class="num${underwater ? " is-underwater" : ""}">${r.price === null ? "—" : fmtMoney(r.price)}</td>
      <td class="num">${fmtMoney(r.value)}</td>
      ${PERIOD_LABELS.map((l) => `<td class="num ${signClass(r.periods[l])}">${fmtPct(r.periods[l])}</td>`).join("")}`;
    tbody.appendChild(tr);
  });
}

function buildPlanBarHTML(factUSD, planUSD) {
  const hasPlan = planUSD && planUSD > 0;
  const maxVal = Math.max(planUSD || 0, factUSD, 1) * 1.2;
  const factPct = Math.min(100, (factUSD / maxVal) * 100);
  const planPct = hasPlan ? Math.min(100, (planUSD / maxVal) * 100) : null;

  let fillPct, gapHTML = "", overHTML = "";
  if (!hasPlan) {
    fillPct = factPct;
  } else if (factUSD <= planUSD) {
    fillPct = factPct;
    gapHTML = `<div class="plan-bar-gap" style="left:${factPct}%; width:${planPct - factPct}%;"></div>`;
  } else {
    fillPct = planPct;
    overHTML = `<div class="plan-bar-over" style="left:${planPct}%; width:${factPct - planPct}%;"></div>`;
  }
  const markerHTML = hasPlan ? `<div class="plan-bar-marker" style="left:${planPct}%;"></div>` : "";
  return { fillPct, gapHTML, overHTML, markerHTML };
}

function attachPlanTooltip(el, title, factUSD, planUSD, extra) {
  const tooltip = document.getElementById(pid("planActualTooltip"));
  el.addEventListener("mouseenter", () => {
    const hasPlan = planUSD && planUSD > 0;
    const delta = hasPlan ? factUSD - planUSD : null;
    tooltip.innerHTML = `<strong>${title}</strong><br>Факт: ${fmtMoney(factUSD)}<br>План: ${hasPlan ? fmtMoney(planUSD) : "нет плана"}` +
      (hasPlan ? `<br>Δ: <span class="${delta >= 0 ? "is-positive" : "is-negative"}">${delta >= 0 ? "+" : ""}${fmtMoney(delta)}</span>` : "") +
      (extra || "");
    tooltip.hidden = false;
  });
  el.addEventListener("mousemove", (e) => {
    const wrapRect = el.closest(".plan-actual-panel").getBoundingClientRect();
    tooltip.style.left = (e.clientX - wrapRect.left + 14) + "px";
    tooltip.style.top = (e.clientY - wrapRect.top + 10) + "px";
  });
  el.addEventListener("mouseleave", () => { tooltip.hidden = true; });
}

function deltaHTML(factUSD, planUSD) {
  const hasPlan = planUSD && planUSD > 0;
  if (!hasPlan) return `<span class="plan-row-delta">—</span>`;
  const delta = factUSD - planUSD;
  const cls = delta >= 0 ? "is-positive" : "is-negative";
  const sign = delta >= 0 ? "+" : "";
  return `<span class="plan-row-delta ${cls}">${sign}${fmtMoneyNoDecimals(delta)}</span>`;
}

function renderPlanActual() {
  const pa = derived.planActual;
  const container = document.getElementById(pid("planActualBody"));
  if (!pa || !pa.groups.length) { container.innerHTML = ""; return; }
  container.innerHTML = "";

  const totalBar = buildPlanBarHTML(pa.currentTotal || 0, pa.targetTotal || 0);
  const overallRow = document.createElement("div");
  overallRow.className = "plan-row plan-row--total";
  overallRow.innerHTML = `
    <div class="plan-row-header"><span>Портфель целиком</span></div>
    <div class="plan-row-main">
      <div class="plan-bar-track">
        <div class="plan-bar-fill" style="width:${totalBar.fillPct}%; background:var(--accent-brass);"></div>
        ${totalBar.gapHTML}${totalBar.overHTML}${totalBar.markerHTML}
      </div>
      ${deltaHTML(pa.currentTotal || 0, pa.targetTotal || 0)}
    </div>`;
  container.appendChild(overallRow);
  attachPlanTooltip(overallRow, "Портфель целиком", pa.currentTotal || 0, pa.targetTotal || 0);

  pa.groups.forEach((g, gi) => {
    const color = getGroupBaseColor(g.group);
    const bar = buildPlanBarHTML(g.factUSD || 0, g.planUSD || 0);

    const groupRow = document.createElement("div");
    groupRow.className = "plan-row plan-row--group";
    groupRow.innerHTML = `
      <div class="plan-row-header"><span><span class="swatch" style="background:${color}"></span>${g.group}</span></div>
      <div class="plan-row-main">
        <div class="plan-bar-track">
          <div class="plan-bar-fill" style="width:${bar.fillPct}%; background:${color};"></div>
          ${bar.gapHTML}${bar.overHTML}${bar.markerHTML}
        </div>
        ${deltaHTML(g.factUSD || 0, g.planUSD || 0)}
      </div>`;
    container.appendChild(groupRow);
    attachPlanTooltip(groupRow, g.group, g.factUSD || 0, g.planUSD || 0);

    g.tickers.forEach((t) => {
      if (!t.planUSD && !t.factUSD) return;
      const tBar = buildPlanBarHTML(t.factUSD || 0, t.planUSD || 0);
      const tRow = document.createElement("div");
      tRow.className = "plan-row plan-row--ticker";
      tRow.innerHTML = `
        <div class="plan-row-header"><span>${t.ticker}</span></div>
        <div class="plan-row-main">
          <div class="plan-bar-track plan-bar-track--sm">
            <div class="plan-bar-fill" style="width:${tBar.fillPct}%; background:${color};"></div>
            ${tBar.gapHTML}${tBar.overHTML}${tBar.markerHTML}
          </div>
          ${deltaHTML(t.factUSD || 0, t.planUSD || 0)}
        </div>`;
      container.appendChild(tRow);
      attachPlanTooltip(tRow, t.ticker, t.factUSD || 0, t.planUSD || 0);
    });
  });
}

function getCashValue() {
  const rows = derived.actualPortfolio?.rows || [];
  const cashRow = rows.find((r) => r.ticker === "Cash");
  if (cashRow) return cashRow.value || 0;
  const allocCash = derived.allocation.find((a) => a.ticker === "Cash");
  return allocCash ? allocCash.value : 0;
}

function renderKPI() {
  const k = derived.kpi;
  if (!k) return;
  document.getElementById(pid("kpiInvested")).textContent = fmtMoney(k.invested);
  document.getElementById(pid("kpiMarketValue")).textContent = fmtMoney(k.marketValue);
  const profitEl = document.getElementById(pid("kpiProfit"));
  profitEl.textContent = fmtMoney(k.profit);
  profitEl.className = "kpi-value " + signClass(k.profit);
  const pctEl = document.getElementById(pid("kpiProfitPct"));
  pctEl.textContent = fmtPct(k.profitPct);
  pctEl.className = "kpi-value " + signClass(k.profitPct);

  const cashValue = getCashValue();
  const cashTargetReserve = k.marketValue * 0.05;
  const cashDelta = cashValue - cashTargetReserve;
  const cashEl = document.getElementById(pid("kpiCashDelta"));
  cashEl.textContent = fmtMoney(cashDelta);
  cashEl.className = "kpi-value " + signClass(cashDelta);

  const railPct = k.invested > 0 ? Math.min(100, Math.max(0, (k.marketValue / k.invested) * 50)) : 0;
  document.getElementById(pid("kpiRailFill")).style.width = railPct + "%";
}

function renderGoal() {
  const pa = derived.planActual;
  if (!pa || pa.currentTotal === null) return;
  const current = pa.currentTotal;
  const target = pa.targetTotal || 500000;
  const pct = Math.min(100, (current / target) * 100);
  document.getElementById(pid("goalTrackFill")).style.width = pct + "%";
  document.getElementById(pid("goalCurrent")).textContent = fmtMoney(current);
  document.getElementById(pid("goalRemaining")).textContent = fmtMoney(pa.remaining !== null ? pa.remaining : Math.max(0, target - current));
  document.getElementById(pid("goalNote")).textContent = `${pct.toFixed(1)}%`;
}





function renderValueChart() {
  const ctx = document.getElementById(pid("valueChart"));
  const source = derived.dailyValue && derived.dailyValue.length ? derived.dailyValue : derived.monthly;
  const filtered = filterByDaysPeriod(source, selectedValuePeriod, (m) => m.date);
  const labels = filtered.map((m) => formatDateLabel(m.date));
  const valueData = filtered.map((m) => convertCurrency(m.value, currentCurrency));

  const cashflowByDate = {};
  (derived.cashflowDaily || []).forEach((c) => { cashflowByDate[c.date] = c.amount; });
  const cashflowData = filtered.map((m) => {
    const key = toISODateKey(m.date);
    const amt = key && cashflowByDate[key] ? cashflowByDate[key] : 0;
    return amt ? convertCurrency(amt, currentCurrency) : 0;
  });

  if (valueChart) valueChart.destroy();
  valueChart = new Chart(ctx, {
    data: {
      labels,
      datasets: [
        {
          type: "bar",
          label: "Денежный поток",
          data: cashflowData,
          backgroundColor: cashflowData.map((v) => (v > 0 ? "#55A776" : v < 0 ? "#C25C50" : "transparent")),
          borderRadius: 1,
          yAxisID: "yCashflow",
          order: 2,
          barPercentage: 0.95,
          categoryPercentage: 1.0,
          minBarLength: 3,
        },
        {
          type: "line",
          label: "Стоимость портфеля",
          data: valueData,
          borderColor: "#C39A48",
          backgroundColor: "rgba(195,154,72,0.08)",
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.15,
          yAxisID: "yValue",
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => item.dataset.label + ": " + fmtMoney(item.parsed.y),
          },
        },
      },
      scales: {
        x: {
          ticks: { color: "#7C8798", font: { family: "IBM Plex Mono", size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
          grid: { color: "#1E2530" },
        },
        yValue: {
          position: "left",
          ticks: { color: "#7C8798", font: { family: "IBM Plex Mono", size: 10 } },
          grid: { color: "#1E2530" },
        },
        yCashflow: {
          position: "right",
          ticks: { color: "#7C8798", font: { family: "IBM Plex Mono", size: 9 } },
          grid: {
            color: (ctx) => (ctx.tick.value === 0 ? "#7C8798" : "transparent"),
            lineWidth: (ctx) => (ctx.tick.value === 0 ? 1.5 : 0),
          },
        },
      },
    },
  });
}







function renderAllocation() {
  const legend = document.getElementById(pid("allocationBody"));
  legend.innerHTML = "";

  const groupTotals = {};
  const groupOrder = [];
  derived.allocation.forEach((a) => {
    if (!(a.group in groupTotals)) { groupTotals[a.group] = 0; groupOrder.push(a.group); }
    groupTotals[a.group] += a.value;
  });
  const grandTotal = groupOrder.reduce((s, g) => s + groupTotals[g], 0);

  if (!derived.allocation.length) {
    legend.innerHTML = '<div class="empty-row">Нет данных</div>';
  } else {
    groupOrder.forEach((g) => {
      const groupColor = getGroupBaseColor(g);
      const groupWrap = document.createElement("div");
      groupWrap.className = "alloc-legend-group";
      const groupWeight = grandTotal > 0 ? (groupTotals[g] / grandTotal) * 100 : 0;
      groupWrap.innerHTML = `
        <div class="alloc-legend-group-row">
          <span class="alloc-name"><span class="swatch" style="background:${groupColor}"></span><span class="label-text">${g}</span></span>
          <span class="alloc-figures">${Math.round(groupWeight)}% · ${fmtMoneyNoDecimals(groupTotals[g])}</span>
        </div>`;
      let shadeIdx = 0;
      derived.allocation.filter((a) => a.group === g).forEach((a) => {
        shadeIdx++;
        const tickerColor = lightenHex(groupColor, shadeIdx * 0.14);
        const row = document.createElement("div");
        row.className = "alloc-legend-ticker-row";
        row.innerHTML = `
          <span class="alloc-name"><span class="swatch" style="background:${tickerColor}"></span><span class="label-text">${a.ticker}</span></span>
          <span class="alloc-figures">${Math.round(a.weight * 100)}% · ${fmtMoneyNoDecimals(a.value)}</span>`;
        groupWrap.appendChild(row);
      });
      legend.appendChild(groupWrap);
    });
  }

  const shadeCounters = {};
  const tickerColors = derived.allocation.map((a) => {
    const base = getGroupBaseColor(a.group);
    const n = (shadeCounters[a.group] || 0) + 1;
    shadeCounters[a.group] = n;
    return lightenHex(base, n * 0.14);
  });

  const ctx = document.getElementById(pid("allocationChart"));
  if (allocationChart) allocationChart.destroy();
  allocationChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      // порядок датасетов = порядок колец от центра наружу:
      // группы — внутреннее кольцо, тикеры — внешнее
      labels: derived.allocation.map((a) => a.ticker),
      datasets: [
        {
          label: "Группы",
          data: groupOrder.map((g) => groupTotals[g]),
          backgroundColor: groupOrder.map((g) => getGroupBaseColor(g)),
          borderColor: "#141A24",
          borderWidth: 2,
        },
        {
          label: "Активы",
          data: derived.allocation.map((a) => a.value),
          backgroundColor: tickerColors,
          borderColor: "#141A24",
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => {
              if (item.datasetIndex === 1) {
                const a = derived.allocation[item.dataIndex];
                return `${a.ticker}: ${fmtMoneyNoDecimals(a.value)} (${Math.round(a.weight * 100)}%)`;
              }
              const g = groupOrder[item.dataIndex];
              return `${g}: ${fmtMoneyNoDecimals(groupTotals[g])}`;
            },
          },
        },
      },
      cutout: "35%",
    },
  });
}





/* -------------------------- Transactions table + filters -------------------------- */

function populateTickerFilter() {
  const select = document.getElementById(pid("tickerFilter"));
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
  const tickerVal = document.getElementById(pid("tickerFilter")).value;
  const fromVal = document.getElementById(pid("dateFilterFrom")).value.trim();
  const toVal = document.getElementById(pid("dateFilterTo")).value.trim();
  const from = fromVal ? new Date(fromVal) : null;
  const to = toVal ? new Date(toVal) : null;

  let rows = derived.txRows.slice().sort((a, b) => {
    const da = parseSheetDate(a.date), db = parseSheetDate(b.date);
    return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
  });

  if (tickerVal) rows = rows.filter((r) => r.ticker === tickerVal);
  if (from) rows = rows.filter((r) => { const d = parseSheetDate(r.date); return d && d >= from; });
  if (to) rows = rows.filter((r) => { const d = parseSheetDate(r.date); return d && d <= to; });

  const tbody = document.getElementById(pid("txBody"));
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


function wireInteractions() {
  const tickerFilterEl = document.getElementById(pid("tickerFilter"));
  if (tickerFilterEl) tickerFilterEl.addEventListener("change", applyTransactionFilters);
  const dateFromEl = document.getElementById(pid("dateFilterFrom"));
  if (dateFromEl) dateFromEl.addEventListener("change", applyTransactionFilters);
  const dateToEl = document.getElementById(pid("dateFilterTo"));
  if (dateToEl) dateToEl.addEventListener("change", applyTransactionFilters);
  const closeDrilldownEl = document.getElementById(pid("closeDrilldown"));
  if (closeDrilldownEl) {
    closeDrilldownEl.addEventListener("click", () => {
      document.getElementById(pid("monthDrilldown")).hidden = true;
    });
  }

  const valueBtnsSel = "#" + pid("valuePeriodButtons") + " button";
  document.querySelectorAll(valueBtnsSel).forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedValuePeriod = btn.dataset.period;
      document.querySelectorAll(valueBtnsSel).forEach((b) => b.classList.toggle("is-active", b === btn));
      renderValueChart();
    });
  });

  const assetBtnsSel = "#" + pid("assetPeriodButtons") + " button";
  document.querySelectorAll(assetBtnsSel).forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedAssetPeriod = btn.dataset.period;
      document.querySelectorAll(assetBtnsSel).forEach((b) => b.classList.toggle("is-active", b === btn));
      renderAssetsReturnChart();
    });
  });

  wirePensionInputs();
}

return {
  label,
  fetchAll,
  renderAll,
  renderPension,
  wireInteractions,
  hasData: () => !!derived.kpi,
};
}

/* -------------------------- Инстансы двух портфелей -------------------------- */

const mainProfile = createProfile({
  prefix: "",
  label: "main",
  spreadsheetId: CFG.SPREADSHEET_ID,
  sheets: CFG.SHEETS,
  coreTickers: CFG.CORE_TICKERS,
  assetColors: CFG.ASSET_COLORS,
  hasGoalPanel: true,
  hasPlan: true,
  indexTickers: [],
  benchmarkTicker: "VOO",
  nativeCurrency: "USD",
});

const alenaProfile = createProfile({
  prefix: "b",
  label: "alena",
  spreadsheetId: CFG.SPREADSHEET_ID_ALENA,
  sheets: CFG.SHEETS_ALENA || CFG.SHEETS,
  coreTickers: CFG.CORE_TICKERS_ALENA,
  assetColors: CFG.ASSET_COLORS_ALENA,
  hasGoalPanel: false,
  hasPlan: false,
  indexTickers: ["CSPX"],
  benchmarkTicker: "CSPX",
  nativeCurrency: "EUR",
});

const PROFILES = [mainProfile, alenaProfile];

/* -------------------------- Валюта (общая на весь сайт) -------------------------- */

function setCurrency(ccy) {
  currentCurrency = ccy;
  document.querySelectorAll(".ccy-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.ccy === ccy));
  PROFILES.forEach((p) => { if (p.hasData()) p.renderAll(); });
}

/* -------------------------- Wire up UI (общее + по вкладкам) -------------------------- */

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("signInBtn").addEventListener("click", signIn);
  document.getElementById("signOutBtn").addEventListener("click", signOut);
  document.getElementById("refreshBtn").addEventListener("click", () => {
    PROFILES.forEach((p) => p.fetchAll());
  });
  document.querySelectorAll(".ccy-btn").forEach((btn) => {
    btn.addEventListener("click", () => setCurrency(btn.dataset.ccy));
  });

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
      document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.hidden = panel.dataset.tab !== tab;
      });
      if (tab === "pension" && mainProfile.hasData()) mainProfile.renderPension();
      if (tab === "pensionAlena" && alenaProfile.hasData()) alenaProfile.renderPension();
    });
  });

  PROFILES.forEach((p) => p.wireInteractions());

  initGis();
});
