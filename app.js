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
  const hasIncomeTarget = opts.hasIncomeTarget !== false; // по умолчанию true (текущее поведение, кроме профиля Алены)
  const hasStatePension = !!opts.hasStatePension;
  const hasWhatIfPanels = opts.hasWhatIfPanels !== false; // по умолчанию true, кроме профиля Алены (заменено вехами/комбинированным что-если)

  function pid(base) {
    if (base === "app" || base === "refreshBtn") return base;
    if (!prefix) return base;
    return prefix + base.charAt(0).toUpperCase() + base.slice(1);
  }

  // У каждого профиля — своя "родная" валюта данных (opts.nativeCurrency:
  // у тебя USD, у Алены EUR) и свой независимый переключатель отображения
  // (profileCurrency, стартует равным родной валюте). В отличие от
  // предыдущей версии, тут переключатель РЕАЛЬНО пересчитывает суммы в обе
  // стороны через eurUsdRate — просто у каждого профиля свой собственный
  // выбор валюты, не завязанный на переключатель другого профиля.
  let profileCurrency = opts.nativeCurrency;

  function convertCurrency(value, targetCcy = profileCurrency) {
    if (value === null || value === undefined || isNaN(value)) return value;
    if (targetCcy === opts.nativeCurrency || !eurUsdRate) return value;
    // opts.nativeCurrency -> targetCcy, единственные два случая: USD<->EUR
    if (opts.nativeCurrency === "USD" && targetCcy === "EUR") return value / eurUsdRate;
    if (opts.nativeCurrency === "EUR" && targetCcy === "USD") return value * eurUsdRate;
    return value;
  }

  function fmtMoney(value, ccy = profileCurrency) {
    if (value === null || value === undefined || isNaN(value)) return "—";
    const converted = convertCurrency(value, ccy);
    const symbol = ccy === "EUR" ? "€" : "$";
    const sign = converted < 0 ? "-" : "";
    return `${sign}${symbol}${Math.abs(converted).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function fmtMoneyNoDecimals(value, ccy = profileCurrency) {
    if (value === null || value === undefined || isNaN(value)) return "—";
    const converted = convertCurrency(value, ccy);
    const symbol = ccy === "EUR" ? "€" : "$";
    const sign = converted < 0 ? "-" : "";
    return `${sign}${symbol}${Math.round(Math.abs(converted)).toLocaleString("en-US")}`;
  }

  function setCurrency(ccy) {
    profileCurrency = ccy;
    if (derived.kpi) renderAll();
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
    if (typeof renderOverallTab === "function") renderOverallTab();

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
  const base = {
    age: parseNum(document.getElementById(pid("pAge")).value) || 35,
    retireAge: parseNum(document.getElementById(pid("pRetireAge")).value) || 62,
    endAge: parseNum(document.getElementById(pid("pEndAge")).value) || 100,
    nominalReturn,
    inflation,
    returnRate: realReturn, // реальная доходность (уже без инфляции), используется во всех расчётах ниже
    withdrawRate: (parseNum(document.getElementById(pid("pWithdrawRate")).value) || 4) / 100,
  };
  if (hasIncomeTarget) {
    const targetIncomeMonthly = parseNum(document.getElementById(pid("pTargetIncomeMonthly")).value) || 0;
    base.targetIncomeMonthly = targetIncomeMonthly;
    base.targetIncome = targetIncomeMonthly * 12;
    base.annualContribution = 0;
    base.contributionYears = 0;
  } else {
    base.targetIncomeMonthly = 0;
    base.targetIncome = null;
    base.annualContribution = parseNum(document.getElementById(pid("pAnnualContribution")).value) || 0;
    // Кол-во лет пополнений = лет до пенсии — очевидно из retireAge/age, отдельного поля не требует.
    base.contributionYears = Math.max(0, base.retireAge - base.age);
  }
  return base;
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
    let withdrawal = 0;
    let contribution = 0;

    if (!isRetired) {
      // Фаза накопления: без целевого дохода (профиль Алены) сюда добавляются
      // ежегодные пополнения — ровно inputs.contributionYears лет с текущего момента.
      if (!hasIncomeTarget && y <= inputs.contributionYears) contribution = inputs.annualContribution;
      capital = capital * (1 + inputs.returnRate) + contribution;
    } else if (hasIncomeTarget) {
      withdrawal = annualWithdrawal;
      capital = capital * (1 + inputs.returnRate) - withdrawal;
      if (capital < 0) capital = 0;
      if (capital <= 0 && depletedAtAge === null) depletedAtAge = age;
    } else {
      // Без целевого дохода: на пенсии выводим ровно ставку вывода от
      // текущего капитала каждый год — капитал никогда не обнуляется
      // математически, просто доход/мес меняется вместе с капиталом.
      capital = capital * (1 + inputs.returnRate);
      withdrawal = capital * inputs.withdrawRate;
      capital -= withdrawal;
    }

    rows.push({
      year: startYear + y,
      age,
      phase: isRetired ? "Пенсия" : "Накопление",
      contribution,
      withdrawal,
      capital,
      monthlyIncome: isRetired ? withdrawal / 12 : (capital * inputs.withdrawRate) / 12,
    });
  }

  const retirementRow = rows.find((r) => r.age === inputs.retireAge) || rows[rows.length - 1] || { capital: current };
  const projected = retirementRow.capital;
  const requiredCapital = hasIncomeTarget && inputs.withdrawRate > 0 ? inputs.targetIncome / inputs.withdrawRate : null;
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
  const incomeEl = document.getElementById(pid("pKpiIncome"));
  incomeEl.textContent = fmtMoney(p.projectedMonthlyIncome);

  if (hasIncomeTarget) {
    document.getElementById(pid("pKpiRequired")).textContent = p.requiredCapital === null ? "—" : fmtMoney(p.requiredCapital);
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
  } else {
    incomeEl.className = "kpi-value";
  }

  const depletionEl = document.getElementById(pid("pDepletionNote"));
  if (depletionEl) {
    if (hasIncomeTarget) {
      if (p.depletedAtAge !== null) {
        depletionEl.textContent = `⚠ При текущих параметрах капитал заканчивается в ${p.depletedAtAge} лет (до ${p.endAge} не хватает)`;
        depletionEl.className = "panel-note is-negative";
      } else {
        depletionEl.textContent = `Капитала хватает минимум до ${p.endAge} лет`;
        depletionEl.className = "panel-note is-positive";
      }
    } else {
      depletionEl.textContent = `На пенсии вывод — ${(p.inputs.withdrawRate * 100).toFixed(1)}%/год от остатка; капитал не обнуляется, доход/мес меняется вместе с ним`;
      depletionEl.className = "panel-note";
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
          data: accumData.map((v) => (v === null ? null : convertCurrency(v))),
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
          data: drawdownData.map((v) => (v === null ? null : convertCurrency(v))),
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
              data: dataPoints.map(() => convertCurrency(p.requiredCapital)),
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
        tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${fmtMoney(dataPoints[item.dataIndex])}` } },
      },
    },
  });
}

function wirePensionInputs() {
  // Восстановить сохранённые значения ДО первого рендера, чтобы расчёт сразу
  // шёл по восстановленным данным, а не по дефолтам из HTML.
  if (hasStatePension) loadPensionAlenaInputs();

  const ids = ["pAge", "pRetireAge", "pEndAge", "pNominalReturn", "pInflation", "pWithdrawRate"];
  if (hasIncomeTarget) ids.push("pTargetIncomeMonthly");
  else ids.push("pAnnualContribution");

  ids.forEach((id) => {
    document.getElementById(pid(id)).addEventListener("input", () => {
      if (hasIncomeTarget) updateTargetIncomeYearlyDisplay();
      if (derived.kpi) renderPension();
      if (hasWhatIfPanels) renderWhatIf();
      if (hasStatePension) renderAllExtraPensionSections();
    });
  });
  if (hasIncomeTarget) updateTargetIncomeYearlyDisplay();

  if (hasWhatIfPanels) {
    ["wCapitalNow", "wSpendMonthly"].forEach((id) => {
      document.getElementById(pid(id)).addEventListener("input", renderWhatIf);
    });
    renderWhatIf();
  }

  if (hasStatePension) {
    wireExtraPensionSections();
    wirePensionAlenaPersistence();
  }
}

function updateTargetIncomeYearlyDisplay() {
  const monthly = parseNum(document.getElementById(pid("pTargetIncomeMonthly")).value) || 0;
  const yearlyEl = document.getElementById(pid("pTargetIncomeYearly"));
  if (yearlyEl) yearlyEl.textContent = `≈ ${fmtMoney(monthly * 12, "USD")}/год`;
}

/**
 * Упрощённая оценка немецкой государственной пенсии (gesetzliche
 * Rentenversicherung) по системе пенсионных баллов (Entgeltpunkte): за
 * каждый год работы начисляется (ЗП_гросс / среднегодовая ЗП по стране)
 * баллов, с потолком по предельной базе взносов. Сумма баллов × актуальная
 * стоимость балла = месячная пенсия. Используются ориентировочные текущие
 * значения (2024/2025) без индексации на будущие годы — упрощение, реальные
 * цифры Deutsche Rentenversicherung уточняет ежегодно. Выплата возможна не
 * раньше 63 лет ни при каких условиях — по умолчанию считаем от 67
 * (стандартный пенсионный возраст, без вычетов за досрочный выход).
 */
const DE_PENSION_REF = {
  averageAnnualSalary: 45358, // Durchschnittsentgelt, ориентир 2024
  contributionCeiling: 90600, // Beitragsbemessungsgrenze (Запад), 2025
  pensionPointValue: 39.32,   // aktueller Rentenwert, €/мес за 1 балл (с июля 2024)
  payoutAge: 67,              // стандартный пенсионный возраст (Regelaltersgrenze)
};

function computeStatePension() {
  const grossSalary = parseNum(document.getElementById(pid("deSalaryGross")).value) || 0;
  const yearsWorked = parseNum(document.getElementById(pid("deYearsWorked")).value) || 0;
  const cappedSalary = Math.min(grossSalary, DE_PENSION_REF.contributionCeiling);
  const pointsPerYear = DE_PENSION_REF.averageAnnualSalary > 0 ? cappedSalary / DE_PENSION_REF.averageAnnualSalary : 0;
  const totalPoints = pointsPerYear * yearsWorked;
  const monthlyPension = totalPoints * DE_PENSION_REF.pensionPointValue;
  return { grossSalary, yearsWorked, pointsPerYear, totalPoints, monthlyPension, payoutAge: DE_PENSION_REF.payoutAge };
}

function renderStatePension() {
  const s = computeStatePension();
  document.getElementById(pid("dePointsPerYear")).textContent = s.pointsPerYear.toFixed(3);
  document.getElementById(pid("deTotalPoints")).textContent = s.totalPoints.toFixed(2);
  document.getElementById(pid("deMonthlyPension")).textContent = fmtMoney(s.monthlyPension);
  document.getElementById(pid("deYearlyPension")).textContent = fmtMoney(s.monthlyPension * 12);
  document.getElementById(pid("dePayoutAge")).textContent = s.payoutAge + " лет";
}

/**
 * Приватная пенсия (betriebliche Altersvorsorge): единый взнос
 * сотрудник+работодатель, растёт на инфляцию каждый год (описательно, на
 * итоговую выплату не влияет). Договор длится ровно до выхода на пенсию
 * (retireAge - age — то же самое "лет до пенсии", что и у инвестиций,
 * отдельного поля не требует). Выплата пропорциональна доле отработанных
 * лет от этого срока (общее поле "Кол-во лет работы" — то же самое, что
 * используется для гос. пенсии — сколько работает, столько и платит
 * взносов в оба источника).
 */
function computePrivatePension() {
  const contribNow = parseNum(document.getElementById(pid("ppContrib")).value) || 0;
  const fullPayout = parseNum(document.getElementById(pid("ppFullPayout")).value) || 0;
  const yearsWorked = parseNum(document.getElementById(pid("deYearsWorked")).value) || 0;
  const inputs = getPensionInputs();
  const contractYears = inputs.contributionYears; // лет до пенсии — общее с инвестициями

  const progressFraction = contractYears > 0 ? Math.min(1, yearsWorked / contractYears) : 0;
  const actualPayout = fullPayout * progressFraction;

  // Выплачивается с того же возраста, что и гос. пенсия (67 лет).
  return { contribNow, progressFraction, actualPayout, payoutAge: DE_PENSION_REF.payoutAge };
}

function renderPrivatePension() {
  const pp = computePrivatePension();
  document.getElementById(pid("ppContribNow")).textContent = fmtMoney(pp.contribNow) + "/мес";
  document.getElementById(pid("ppProgress")).textContent = (pp.progressFraction * 100).toFixed(0) + "%";
  document.getElementById(pid("ppActualPayout")).textContent = fmtMoney(pp.actualPayout) + "/мес";
  document.getElementById(pid("ppPayoutAge")).textContent = pp.payoutAge + " лет";
}

function renderMilestoneSummary() {
  const inputs = getPensionInputs();
  const yearsToRetire = Math.max(0, inputs.retireAge - inputs.age);
  document.getElementById(pid("msAgeNow")).textContent = inputs.age + " лет";
  document.getElementById(pid("msRetireAge")).textContent = inputs.retireAge + " лет";
  document.getElementById(pid("msYearsToRetire")).textContent = String(yearsToRetire);
  document.getElementById(pid("msWithdrawDate")).textContent = String(new Date().getFullYear() + yearsToRetire);
  const hintEl = document.getElementById(pid("yearsToRetireHint"));
  if (hintEl) hintEl.textContent = `(${yearsToRetire} лет до пенсии)`;
}

/**
 * Доход по вехам (возраст выхода на пенсию, 65, 67 — гос. пенсия добавляется
 * с 67): по каждому возрасту берём капитал/доход инвестиций из той же
 * траектории, что и основной расчёт (computePensionProjection), плюс
 * приват. пенсию (с возраста выхода на пенсию) и гос. пенсию (с 67).
 */
function computeMilestones() {
  const inputs = getPensionInputs();
  const proj = computePensionProjection();
  const pp = computePrivatePension();
  const sp = computeStatePension();

  const ages = [inputs.retireAge, 65, 67].filter((a) => a >= inputs.retireAge);
  const uniqueAges = [...new Set(ages)].sort((a, b) => a - b);

  return uniqueAges.map((age) => {
    const row = proj.rows.find((r) => r.age === age);
    const investMonthly = row ? row.monthlyIncome : null;
    const privateMonthly = age >= pp.payoutAge ? pp.actualPayout : 0;
    const stateMonthly = age >= sp.payoutAge ? sp.monthlyPension : 0;
    const total = (investMonthly || 0) + privateMonthly + stateMonthly;
    return { age, investMonthly, privateMonthly, stateMonthly, total };
  });
}

function renderMilestones() {
  const rows = computeMilestones();
  const tbody = document.getElementById(pid("milestoneTableBody"));
  tbody.innerHTML = "";
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${r.age} лет</td>
      <td class="num">${r.investMonthly === null ? "—" : fmtMoney(r.investMonthly)}</td>
      <td class="num">${fmtMoney(r.privateMonthly)}</td>
      <td class="num">${fmtMoney(r.stateMonthly)}</td>
      <td class="num" style="font-weight:600">${fmtMoney(r.total)}</td>`;
    tbody.appendChild(tr);
  });
}

/**
 * "Что если": желаемый доход на пенсии закрывается сначала гос.+приват.
 * пенсией, остаток — инвестициями. С возраста выхода на пенсию до 67 лет
 * гос. пенсии ещё нет, поэтому из инвестиций нужно больше; после 67 —
 * меньше (гос. пенсия подключается).
 */
function renderCombinedWhatIf() {
  const pp = computePrivatePension();
  const sp = computeStatePension();
  const proj = computePensionProjection();
  const inputs = getPensionInputs();
  const target = parseNum(document.getElementById(pid("ciTargetMonthly")).value) || 0;

  // Гос. и приват. пенсия обе начинаются с одного возраста (67) — до этого
  // весь целевой доход целиком идёт из инвестиций, после 67 — только остаток.
  const coveredByPensions = pp.actualPayout + sp.monthlyPension;
  const gapBeforePayout = target;
  const gapAfterPayout = Math.max(0, target - coveredByPensions);

  document.getElementById(pid("ciGapBeforeStateLabel")).textContent = `Нужно из инвестиций (до ${sp.payoutAge}), €/мес`;
  document.getElementById(pid("ciCoveredByPensions")).textContent = fmtMoney(coveredByPensions) + "/мес";
  document.getElementById(pid("ciGapBeforeState")).textContent = fmtMoney(gapBeforePayout) + "/мес";
  document.getElementById(pid("ciGapAfterState")).textContent = fmtMoney(gapAfterPayout) + "/мес";

  const capitalAtRetire = proj.projected;
  document.getElementById(pid("ciCapitalNote")).textContent = capitalAtRetire > 0
    ? `${fmtMoney(capitalAtRetire)} на момент выхода на пенсию (${inputs.retireAge} лет)`
    : "—";
}

function renderAllExtraPensionSections() {
  renderStatePension();
  renderPrivatePension();
  renderMilestoneSummary();
  renderMilestones();
  renderCombinedWhatIf();
}

function wireExtraPensionSections() {
  const ids = ["deSalaryGross", "deYearsWorked", "ppContrib", "ppFullPayout", "ciTargetMonthly"];
  ids.forEach((id) => {
    document.getElementById(pid(id)).addEventListener("input", renderAllExtraPensionSections);
  });
  renderAllExtraPensionSections();
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
    // База — цена на дату ПЕРВОЙ реальной котировки этого тикера в выбранном
    // периоде (а не на начало всего диапазона графика): так линия тикера
    // корректно начинается с даты его покупки/появления в данных, даже если
    // другие тикеры/сам портфель имеют историю до этой даты.
    const firstIdx = filtered.findIndex((r) => parseNum(r[colIdx]) > 0);
    const firstPrice = firstIdx === -1 ? 0 : parseNum(filtered[firstIdx][colIdx]);
    series[ticker] = filtered.map((r, i) => {
      if (firstPrice <= 0 || i < firstIdx) return null;
      const p = parseNum(r[colIdx]);
      return p > 0 ? (p / firstPrice - 1) * 100 : null;
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

  const totalDays = Math.max(1, (end.getTime() - start.getTime()) / 86400000);

  // Asset_History обновляется батчем только по ЗАКРЫТИИ дня — сегодняшняя
  // (ещё не закрытая) строка там может быть вчерашней/устаревшей. "Текущая
  // цена" в Актуальном Портфеле, наоборот, живая (то же самое, что уже
  // использует формула "30 days" в детальной таблице). Поэтому для сегодняшнего
  // дня берём цену оттуда, а не из Asset_History — иначе цифры расходятся
  // именно в дни сильных внутридневных движений.
  const today = new Date();
  const isEndToday = end.getFullYear() === today.getFullYear() && end.getMonth() === today.getMonth() && end.getDate() === today.getDate();
  const livePriceByTicker = {};
  if (isEndToday) {
    (derived.actualPortfolio?.rows || []).forEach((r) => { if (r.price) livePriceByTicker[r.ticker] = r.price; });
  }

  coreTickers.forEach((ticker) => {
    const sharesStart = sharesAsOfDate(ticker, dayBeforeStart);
    const sharesEnd = sharesAsOfDate(ticker, end);
    if (Math.abs(sharesStart) < 1e-9 && Math.abs(sharesEnd) < 1e-9) return;

    const priceStart = priceOnOrBefore(ticker, start);
    const priceEnd = livePriceByTicker[ticker] || priceOnOrBefore(ticker, end);
    const qtyDelta = sharesEnd - sharesStart;

    const beginValue = sharesStart * priceStart;
    const endValue = sharesEnd * priceEnd;

    // Modified Dietz: сделки внутри месяца взвешиваются по доле периода, в
    // течение которой деньги уже "работали" — иначе наивное price-ratio
    // (priceEnd/priceStart-1) искажает % доходности для активно докупаемых
    // тикеров (то же самое, что уже используется для строки "Портфель
    // целиком" через Portfolio_Monthly, теперь согласовано и по тикерам).
    let cfTotal = 0, weightedCf = 0;
    derived.txRows.forEach((t) => {
      if (t.ticker !== ticker) return;
      const d = parseSheetDate(t.date);
      if (!d || d <= dayBeforeStart || d > end) return;
      const cf = t.qty * t.price;
      const daysFromStart = (d.getTime() - start.getTime()) / 86400000;
      const weight = (totalDays - daysFromStart) / totalDays;
      cfTotal += cf;
      weightedCf += cf * weight;
    });

    const denom = beginValue + weightedCf;
    const returnPct = denom > 0 ? (endValue - beginValue - cfTotal) / denom : null;
    const returnAbs = endValue - beginValue - cfTotal;

    totalStartValue += beginValue;
    if (returnPct !== null) weightedNumerator += beginValue * returnPct;

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
  const valueData = filtered.map((m) => convertCurrency(m.value));

  const cashflowByDate = {};
  (derived.cashflowDaily || []).forEach((c) => { cashflowByDate[c.date] = c.amount; });
  const cashflowData = filtered.map((m) => {
    const key = toISODateKey(m.date);
    const amt = key && cashflowByDate[key] ? cashflowByDate[key] : 0;
    return amt ? convertCurrency(amt) : 0;
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
  getCurrency: () => profileCurrency,
  setCurrency,
  // Факт из системы для вкладки "Общий": если есть план (Portfolio500k) — берём его
  // "текущий итог" (уже включает кэш), иначе рыночная стоимость + кэш.
  // До первой загрузки данных (derived.kpi ещё нет) — total: null.
  getGoalSummary: () => {
    if (!derived.kpi) return { total: null };
    if (hasPlan && derived.planActual && derived.planActual.currentTotal !== null && derived.planActual.currentTotal !== undefined) {
      return { total: derived.planActual.currentTotal };
    }
    return { total: (derived.kpi.marketValue || 0) + (getCashValue() || 0) };
  },
  // Живые цены тикеров из "Актуальный Портфель" (для вкладки "План докупок" —
  // проверка триггеров ребалансировки по текущей цене, не по вчерашней Asset_History).
  getTickerPrices: () => {
    const map = {};
    (derived.actualPortfolio?.rows || []).forEach((r) => { if (r.price !== null && r.price !== undefined) map[r.ticker] = r.price; });
    return map;
  },
  // "Сколько докупить" по тикеру — план минус факт, живьём из листа "портфель 500к"
  // (для вкладки "План докупок": сумма к покупке берётся отсюда, а не вписывается
  // руками — таблица траншей задаёт только "когда", не "сколько").
  getPlanDeltas: () => {
    const map = {};
    (derived.planActual?.groups || []).forEach((g) => {
      g.tickers.forEach((t) => { if (t.deltaUSD !== null && t.deltaUSD !== undefined) map[t.ticker] = t.deltaUSD; });
    });
    return map;
  },
  // Исторический пик (максимальная цена закрытия) по тикеру за весь доступный
  // Asset_History — нужен для автогенерации триггерной сетки траншей (вкладка
  // "План докупок"), чтобы не спрашивать у пользователя вручную "от какой цены
  // считать просадку".
  getAssetPeaks: () => {
    const rows = raw.assetHistory || [];
    const peaks = {};
    if (rows.length < 2) return peaks;
    const header = rows[0];
    header.forEach((ticker, colIdx) => {
      if (!ticker || colIdx === 0) return;
      let max = null;
      for (let i = 1; i < rows.length; i++) {
        const v = parseNum(rows[i][colIdx]);
        if (v && (max === null || v > max)) max = v;
      }
      if (max !== null) peaks[ticker] = max;
    });
    return peaks;
  },
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
  hasIncomeTarget: true,
  hasStatePension: false,
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
  hasIncomeTarget: false,
  hasStatePension: true,
  hasWhatIfPanels: false,
  indexTickers: ["CSPX"],
  benchmarkTicker: "CSPX",
  nativeCurrency: "EUR",
});

const PROFILES = [mainProfile, alenaProfile];

// Какой профиль отвечает за какую вкладку — нужно, чтобы переключатель
// USD/EUR в шапке знал, к какому профилю применить клик.
const TAB_TO_PROFILE = {
  portfolio: mainProfile,
  pension: mainProfile,
  portfolioAlena: alenaProfile,
  pensionAlena: alenaProfile,
};
let activeTab = "portfolio";

/* -------------------------- Вкладка "Общий": 4 цели-банки + общий прогресс -------------------------- */

const GOALS_MANUAL_STORAGE_KEY = "goals_manual_facts_v1";

// getAutoFact — факт из системы (Google Sheets), задан только у Пенсии и Обучения.
// Ручной ввод (localStorage) для них — ДОБАВКА поверх системного факта, а не замена;
// у Квартиры/Подушки системного факта нет, там ручной ввод — единственный факт (как раньше).
const GOAL_DEFS = [
  { id: "pension", title: "Пенсионный портфель", plan: 500000, symbol: "$", currency: "USD", getAutoFact: () => mainProfile.getGoalSummary().total },
  { id: "education", title: "Обучение детей", plan: 100000, symbol: "€", currency: "EUR", getAutoFact: () => alenaProfile.getGoalSummary().total },
  { id: "apartment", title: "Квартира", plan: 200000, symbol: "€", currency: "EUR" },
  { id: "cushion", title: "Подушка", plan: 20000, symbol: "€", currency: "EUR" },
];

// Общий план всегда переводится в евро (используем ту же ставку eurUsdRate,
// что и остальной сайт) — так все 4 цели складываются в одной валюте, честно.
function toGoalEUR(value, currency) {
  if (currency === "EUR") return value;
  return convertCurrency(value, "EUR"); // convertCurrency ждёт значение в USD
}

function loadManualGoalFacts() {
  try {
    const raw = localStorage.getItem(GOALS_MANUAL_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; } // повреждённые данные в localStorage — просто игнорируем, останутся дефолты
}
function saveManualGoalFacts(data) {
  localStorage.setItem(GOALS_MANUAL_STORAGE_KEY, JSON.stringify(data));
}
let manualGoalFacts = loadManualGoalFacts();

function fmtGoalMoney(value, symbol) {
  if (value === null || value === undefined || isNaN(value)) return "—";
  return `${symbol}${Math.round(value).toLocaleString("en-US")}`;
}
function fmtGoalPct(pct) { return `${pct.toFixed(1)}%`; }

// Высота видимой (закруглённой) области банки во viewBox SVG — должна совпадать
// с rect'ами в index.html (x=2 y=2 width=96 height=156).
const GOAL_JAR_VIEWBOX_H = 156;
const GOAL_JAR_VIEWBOX_Y0 = 2;

function renderOverallTab() {
  let sumAuto = 0;
  let sumManual = 0;
  let sumPlan = 0;

  GOAL_DEFS.forEach((g) => {
    const rawAuto = g.getAutoFact ? g.getAutoFact() : null;
    const auto = (rawAuto === null || rawAuto === undefined || isNaN(rawAuto)) ? 0 : rawAuto;
    const savedManual = manualGoalFacts[g.id];
    const manual = (savedManual === undefined || savedManual === null || isNaN(savedManual)) ? 0 : savedManual;

    const planEl = document.getElementById("goalPlan_" + g.id);
    if (planEl) planEl.textContent = fmtGoalMoney(g.plan, g.symbol);

    const autoPct = g.plan > 0 ? (auto / g.plan) * 100 : 0;
    const manualPct = g.plan > 0 ? (manual / g.plan) * 100 : 0;
    const totalPct = autoPct + manualPct;

    // "Итого" (факт + введено вручную, в % плана) — общее для всех 4 целей.
    const totalPctEl = document.getElementById("goalTotalPct_" + g.id);
    if (totalPctEl) totalPctEl.textContent = fmtGoalPct(totalPct);

    if (g.getAutoFact) {
      // Пенсия / Обучение: два слоя в банке (система снизу, ручное сверху).
      const autoValueEl = document.getElementById("goalAutoValue_" + g.id);
      if (autoValueEl) autoValueEl.textContent = rawAuto === null ? "—" : fmtGoalMoney(auto, g.symbol);

      const autoFillPct = g.plan > 0 ? Math.max(0, Math.min(100, autoPct)) : 0;
      const manualFillPct = g.plan > 0 ? Math.max(0, Math.min(100 - autoFillPct, manualPct)) : 0;
      const autoFillH = (autoFillPct / 100) * GOAL_JAR_VIEWBOX_H;
      const manualFillH = (manualFillPct / 100) * GOAL_JAR_VIEWBOX_H;

      const autoFillEl = document.getElementById("goalFillAuto_" + g.id);
      if (autoFillEl) {
        autoFillEl.setAttribute("y", String(GOAL_JAR_VIEWBOX_Y0 + (GOAL_JAR_VIEWBOX_H - autoFillH)));
        autoFillEl.setAttribute("height", String(autoFillH));
      }
      const manualFillEl = document.getElementById("goalFillManual_" + g.id);
      if (manualFillEl) {
        manualFillEl.setAttribute("y", String(GOAL_JAR_VIEWBOX_Y0 + (GOAL_JAR_VIEWBOX_H - autoFillH - manualFillH)));
        manualFillEl.setAttribute("height", String(manualFillH));
      }
    } else {
      // Квартира / Подушка: один слой, ручной ввод это весь факт (totalPct = manualPct).
      const fillEl = document.getElementById("goalFill_" + g.id);
      if (fillEl) {
        const pct = Math.max(0, Math.min(100, manualPct));
        const fillH = (pct / 100) * GOAL_JAR_VIEWBOX_H;
        fillEl.setAttribute("y", String(GOAL_JAR_VIEWBOX_Y0 + (GOAL_JAR_VIEWBOX_H - fillH)));
        fillEl.setAttribute("height", String(fillH));
      }
    }

    sumAuto += toGoalEUR(auto, g.currency);
    sumManual += toGoalEUR(manual, g.currency);
    sumPlan += toGoalEUR(g.plan, g.currency);
  });

  const overallAutoPct = sumPlan > 0 ? (sumAuto / sumPlan) * 100 : 0;
  const overallManualPct = sumPlan > 0 ? (sumManual / sumPlan) * 100 : 0;
  const overallTotalPct = overallAutoPct + overallManualPct;
  const missingAmount = Math.max(0, sumPlan - sumAuto - sumManual);
  const missingPct = Math.max(0, 100 - overallTotalPct);

  // Ширины сегментов полосы (в %, как в заливке) — по ним же центрируем подписи под ними.
  const autoBarPct = sumPlan > 0 ? Math.max(0, Math.min(100, overallAutoPct)) : 0;
  const manualBarPct = sumPlan > 0 ? Math.max(0, Math.min(100 - autoBarPct, overallManualPct)) : 0;
  const missingBarPct = Math.max(0, 100 - autoBarPct - manualBarPct);

  const fillAutoBar = document.getElementById("goalOverallFillAuto");
  const fillManualBar = document.getElementById("goalOverallFillManual");
  if (fillAutoBar) fillAutoBar.style.width = autoBarPct + "%";
  if (fillManualBar) fillManualBar.style.width = manualBarPct + "%";

  setGoalOverallSegment("Auto", autoBarPct / 2, sumAuto, overallAutoPct);
  setGoalOverallSegment("Manual", autoBarPct + manualBarPct / 2, sumManual, overallManualPct);
  setGoalOverallSegment("Missing", autoBarPct + manualBarPct + missingBarPct / 2, missingAmount, missingPct);
}

function setGoalOverallSegment(suffix, centerPct, amountEUR, pct) {
  const labelEl = document.getElementById("goalOverallSeg" + suffix);
  const sumEl = document.getElementById("goalOverall" + suffix + "Sum");
  const pctEl = document.getElementById("goalOverall" + suffix + "Pct");
  if (labelEl) labelEl.style.left = centerPct + "%";
  if (sumEl) sumEl.textContent = fmtGoalMoney(amountEUR, "€");
  if (pctEl) pctEl.textContent = fmtGoalPct(pct);
}

function wireOverallInputs() {
  GOAL_DEFS.forEach((g) => {
    const inp = document.getElementById("goalFactInput_" + g.id);
    if (!inp) return;
    const saved = manualGoalFacts[g.id];
    inp.value = (saved === undefined || saved === null) ? "" : saved;
    inp.addEventListener("input", () => {
      const val = parseNum(inp.value);
      manualGoalFacts[g.id] = isNaN(val) ? 0 : val;
      saveManualGoalFacts(manualGoalFacts);
      renderOverallTab();
    });
  });
}

/* -------------------------- Валюта (у каждого профиля своя, переключатель применяется к активной вкладке) -------------------------- */

function syncCurrencyButtons() {
  const profile = TAB_TO_PROFILE[activeTab];
  if (!profile) return; // вкладки без профиля (напр. "Недвижимость") — переключатель валют не относится
  const activeCcy = profile.getCurrency();
  document.querySelectorAll(".ccy-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.ccy === activeCcy));
}

/* -------------------------- Калькулятор недвижимости v2 (раздел "Недвижимость", независим от Google Sheets) -------------------------- */

function fmtEUR(value) {
  if (value === null || value === undefined || isNaN(value)) return "—";
  const sign = value < 0 ? "-" : "";
  return `${sign}€${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const RE_BASE_INPUT_IDS = [
  "rePrice", "reRentMonthly", "reNonRecovMonthly", "rePurchaseCostRate",
  "reInterestRate", "reLoanTermYears", "reBuildingShare", "reDepreciationRate", "reMarginalTaxRate",
];

function getRealEstateBaseInputs() {
  const pct = (id) => (parseNum(document.getElementById(id).value) || 0) / 100;
  return {
    price: parseNum(document.getElementById("rePrice").value) || 0,
    rentMonthly: parseNum(document.getElementById("reRentMonthly").value) || 0,
    nonRecovMonthly: parseNum(document.getElementById("reNonRecovMonthly").value) || 0,
    purchaseCostRate: pct("rePurchaseCostRate"),
    interestRate: pct("reInterestRate"),
    loanTermYears: Math.max(1, Math.min(30, Math.round(parseNum(document.getElementById("reLoanTermYears").value)) || 1)),
    buildingShare: pct("reBuildingShare"),
    depreciationRate: pct("reDepreciationRate"),
    marginalTaxRate: pct("reMarginalTaxRate"),
  };
}

/**
 * Расчёт по TZ_Immobilien_Kalkulator_v2.md: только год 1 (без таблицы по
 * годам и сценария продажи). K/C — коэффициенты линейной связи
 * topupAnnual = loan*K + C, которая позволяет пересчитывать
 * "Первый взнос" <-> "Доплата" мгновенно в обе стороны без итераций.
 */
function computeRealEstateBase() {
  const inp = getRealEstateBaseInputs();
  const totalInvestment = inp.price * (1 + inp.purchaseCostRate);
  const r = inp.interestRate;
  const n = inp.loanTermYears;
  const pow = Math.pow(1 + r, n);
  const annuityFactor = r > 0 ? (r * pow) / (pow - 1) : 1 / n;

  const afaAnnual = totalInvestment * inp.buildingShare * inp.depreciationRate;
  const rentAnnual = inp.rentMonthly * 12;
  const nonRecovAnnual = inp.nonRecovMonthly * 12;

  const K = annuityFactor - inp.marginalTaxRate * r;
  const C = (nonRecovAnnual - rentAnnual) * (1 - inp.marginalTaxRate) - inp.marginalTaxRate * afaAnnual;

  return { inp, totalInvestment, annuityFactor, afaAnnual, rentAnnual, nonRecovAnnual, K, C };
}

/**
 * Обновляет диапазоны слайдеров под текущие базовые параметры: "Первый
 * взнос" — от 0 до totalInvestment; "Доплата" — между значениями при
 * equity=0 (макс. доплата) и equity=totalInvestment (мин. доплата).
 */
function updateRealEstateSliderBounds(base) {
  const equityEl = document.getElementById("reEquitySlider");
  equityEl.min = 0;
  equityEl.max = Math.max(1, Math.round(base.totalInvestment));
  equityEl.step = 100; // фиксированный мелкий шаг — иначе браузер "снапит" текущее значение к шагу при его смене

  const topUpAtZeroEquity = (base.totalInvestment * base.K + base.C) / 12;
  const topUpAtFullEquity = (0 * base.K + base.C) / 12;
  const lo = Math.min(topUpAtZeroEquity, topUpAtFullEquity);
  const hi = Math.max(topUpAtZeroEquity, topUpAtFullEquity);
  const topupEl = document.getElementById("reTopUpSlider");
  topupEl.min = Math.floor(lo - 50);
  topupEl.max = Math.ceil(hi + 50);
  topupEl.step = 1;
}

function renderRealEstate(source) {
  const base = computeRealEstateBase();
  updateRealEstateSliderBounds(base);

  const equityEl = document.getElementById("reEquitySlider");
  const topupEl = document.getElementById("reTopUpSlider");
  const errEl = document.getElementById("reErrorNote");

  let equity, loan, topupMonth1;
  if (source === "topup") {
    topupMonth1 = parseNum(topupEl.value);
    loan = base.K !== 0 ? (topupMonth1 * 12 - base.C) / base.K : NaN;
    equity = base.totalInvestment - loan;
  } else {
    equity = parseNum(equityEl.value);
    loan = base.totalInvestment - equity;
    topupMonth1 = (loan * base.K + base.C) / 12;
  }

  const isError = !isFinite(loan) || !isFinite(equity) || loan <= 0 || loan > base.totalInvestment;

  if (source !== "equity") equityEl.value = Math.max(0, Math.min(Number(equityEl.max), equity));
  if (source !== "topup") topupEl.value = topupMonth1;
  document.getElementById("reEquityValue").textContent = fmtEUR(equity);
  document.getElementById("reTopUpValue").textContent = fmtEUR(topupMonth1) + "/мес";

  const kpiIds = ["reKpiLoan", "reKpiLtv", "reKpiAnnuity", "reKpiTopUpYear1"];
  if (isError) {
    kpiIds.forEach((id) => { document.getElementById(id).textContent = "Ошибка"; });
    errEl.hidden = false;
    errEl.textContent = "⚠ Первый взнос не может быть отрицательным — уменьши доплату или проверь параметры";
    return;
  }
  errEl.hidden = true;

  const annuity = loan * base.annuityFactor;
  document.getElementById("reKpiLoan").textContent = fmtEUR(loan);
  document.getElementById("reKpiLtv").textContent = base.inp.price > 0 ? ((loan / base.inp.price) * 100).toFixed(1) + "%" : "—";
  document.getElementById("reKpiAnnuity").textContent = fmtEUR(annuity / 12);
  document.getElementById("reKpiTopUpYear1").textContent = fmtEUR(topupMonth1);
}

function wireRealEstateInputs() {
  RE_BASE_INPUT_IDS.forEach((id) => {
    document.getElementById(id).addEventListener("input", () => renderRealEstate("equity"));
  });
  document.getElementById("reEquitySlider").addEventListener("input", () => renderRealEstate("equity"));
  document.getElementById("reTopUpSlider").addEventListener("input", () => renderRealEstate("topup"));
  renderRealEstate("equity");
}

/* -------------------------- Семейный бюджет (раздел "Бюджет", независим от Google Sheets) -------------------------- */

function bgEsc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Стартовые данные — перенесены из текущей реальной таблицы пользователя
 * (budget_concept_v2.html) по формуле миграции из ТЗ: там, где у статьи с
 * подстатьями было одно поле "vlad" на всю статью, взнос Влада "каскадом"
 * распределён по подстатьям по порядку (первая подстатья получает вклад
 * Влада первой, остаток — Алене) — сохраняет прежний общий Влад/Алена
 * баланс категории. Итог expenseTotal = 6760€ совпадает с контрольным
 * числом из ТЗ, что подтверждает корректность переноса.
 */
let bgIncome = [
  { name: "ЗП", vlad: 1600, alena: 3700 },
  { name: "Сдача квартиры", vlad: 0, alena: 1315.79 },
  { name: "Киндер гельд", vlad: 0, alena: 500 },
];

let bgExpenseGroups = [
  { name: "Жильё", categories: [
    { name: "Аренда квартиры", vlad: 0, alena: 2800, subrows: [] },
    { name: "Квартира родителей", vlad: 0, alena: 530, subrows: [] },
    { name: "Дом затраты", vlad: 0, alena: 0, subrows: [
      { name: "Електрика", vlad: 0, alena: 100 },
      { name: "Телефон", vlad: 0, alena: 135 },
      { name: "дом. Химия", vlad: 0, alena: 50 },
    ] },
    { name: "Комунал (Украина)", vlad: 0, alena: 0, subrows: [
      { name: "Дом", vlad: 100, alena: 50 },
      { name: "Интернет (дом)", vlad: 0, alena: 5 },
    ] },
    { name: "Кредит", vlad: 0, alena: 250, subrows: [] },
  ] },
  { name: "Повседневные", categories: [
    { name: "Питание", vlad: 0, alena: 800, subrows: [] },
    { name: "Отдых", vlad: 400, alena: 0, subrows: [] },
  ] },
  { name: "Транспорт", categories: [
    { name: "Авто", vlad: 0, alena: 0, subrows: [
      { name: "Бензин", vlad: 200, alena: 0 },
      { name: "Страховка", vlad: 0, alena: 75 },
      { name: "Ремонт", vlad: 0, alena: 0 },
    ] },
  ] },
  { name: "Дети", categories: [
    { name: "Мила", vlad: 0, alena: 0, subrows: [
      { name: "Гимнастика", vlad: 0, alena: 70 },
      { name: "Стоматолог", vlad: 0, alena: 30 },
    ] },
    { name: "Сеня", vlad: 0, alena: 0, subrows: [
      { name: "Стоматолог", vlad: 0, alena: 40 },
      { name: "Линзы", vlad: 0, alena: 20 },
    ] },
  ] },
  { name: "Личное", categories: [
    { name: "Алена", vlad: 0, alena: 0, subrows: [
      { name: "Спорт", vlad: 0, alena: 40 },
      { name: "Косметика", vlad: 0, alena: 50 },
    ] },
    { name: "Влад", vlad: 0, alena: 0, subrows: [
      { name: "Спорт", vlad: 0, alena: 40 },
    ] },
  ] },
  { name: "Прочее и резерв", categories: [
    { name: "Одежда", vlad: 200, alena: 0, subrows: [] },
    { name: "Другое", vlad: 0, alena: 0, subrows: [
      { name: "Парковка ТЦ", vlad: 50, alena: 0 },
      { name: "Проездной детей", vlad: 75, alena: 25 },
      { name: "Страховка (зубы)", vlad: 0, alena: 25 },
    ] },
    { name: "Резерв", vlad: 600, alena: 0, subrows: [] },
  ] },
];

function bgLeafTotal(leaf) { return (parseFloat(leaf.vlad) || 0) + (parseFloat(leaf.alena) || 0); }

function bgCategoryTotal(cat) {
  return cat.subrows.length > 0 ? cat.subrows.reduce((s, r) => s + bgLeafTotal(r), 0) : bgLeafTotal(cat);
}
function bgCategoryVlad(cat) {
  return cat.subrows.length > 0 ? cat.subrows.reduce((s, r) => s + (parseFloat(r.vlad) || 0), 0) : (parseFloat(cat.vlad) || 0);
}
function bgCategoryAlena(cat) {
  return cat.subrows.length > 0 ? cat.subrows.reduce((s, r) => s + (parseFloat(r.alena) || 0), 0) : (parseFloat(cat.alena) || 0);
}
function bgGroupTotal(g) { return g.categories.reduce((s, c) => s + bgCategoryTotal(c), 0); }
function bgGroupVlad(g) { return g.categories.reduce((s, c) => s + bgCategoryVlad(c), 0); }
function bgGroupAlena(g) { return g.categories.reduce((s, c) => s + bgCategoryAlena(c), 0); }

function bgRenderIncome() {
  const body = document.getElementById("bgIncomeBody");
  body.innerHTML = "";
  bgIncome.forEach((row, i) => {
    const total = bgLeafTotal(row);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="text" value="${bgEsc(row.name)}" /></td>
      <td class="num"><input type="number" step="0.01" value="${row.vlad}" /></td>
      <td class="num"><input type="number" step="0.01" value="${row.alena}" /></td>
      <td class="num readonly">${fmtEUR(total)}</td>
      <td><button class="budget-rm-btn" title="Удалить">✕</button></td>`;
    const [nameEl, vladEl, alenaEl] = tr.querySelectorAll("input");
    nameEl.addEventListener("input", () => { row.name = nameEl.value; });
    vladEl.addEventListener("change", () => { row.vlad = parseNum(vladEl.value); bgRenderIncome(); bgRecalc(); });
    alenaEl.addEventListener("change", () => { row.alena = parseNum(alenaEl.value); bgRenderIncome(); bgRecalc(); });
    tr.querySelector(".budget-rm-btn").addEventListener("click", () => { bgIncome.splice(i, 1); bgRenderIncome(); bgRecalc(); });
    body.appendChild(tr);
  });
}

function bgAddIncomeRow() { bgIncome.push({ name: "Новая статья", vlad: 0, alena: 0 }); bgRenderIncome(); bgRecalc(); }

function bgRenderExpenses() {
  const container = document.getElementById("bgExpenseGroups");
  container.innerHTML = "";
  bgExpenseGroups.forEach((group, gi) => {
    const groupTotal = bgGroupTotal(group);

    const header = document.createElement("div");
    header.className = "budget-group-header";
    header.innerHTML = `
      <input type="text" value="${bgEsc(group.name)}" />
      <span class="budget-group-total">${fmtEUR(groupTotal)}</span>
      <button class="budget-rm-group-btn">удалить группу</button>`;
    const groupNameEl = header.querySelector("input");
    groupNameEl.addEventListener("input", () => { group.name = groupNameEl.value; });
    header.querySelector(".budget-rm-group-btn").addEventListener("click", () => {
      if (confirm(`Удалить всю группу «${group.name}»?`)) { bgExpenseGroups.splice(gi, 1); bgRenderExpenses(); bgRecalc(); }
    });
    container.appendChild(header);

    const table = document.createElement("table");
    table.className = "ledger-table budget-table";
    table.innerHTML = `
      <thead><tr>
        <th>Статья</th><th class="num" style="width:100px">Сумма, €</th>
        <th class="num" style="width:95px">Влад, €</th><th class="num" style="width:95px">Алена, €</th>
        <th style="width:26px"></th>
      </tr></thead>
      <tbody></tbody>`;
    container.appendChild(table);
    const tbody = table.querySelector("tbody");

    group.categories.forEach((cat, ci) => {
      const hasSub = cat.subrows.length > 0;
      const total = bgCategoryTotal(cat);
      const vlad = bgCategoryVlad(cat);
      const alena = bgCategoryAlena(cat);

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><input type="text" value="${bgEsc(cat.name)}" /></td>
        <td class="num readonly">${fmtEUR(total)}${hasSub ? '<span class="auto-tag">АВТО</span>' : ""}</td>
        <td class="num"><input type="number" step="0.01" value="${vlad}" ${hasSub ? "disabled" : ""} /></td>
        <td class="num"><input type="number" step="0.01" value="${alena}" ${hasSub ? "disabled" : ""} /></td>
        <td><button class="budget-rm-btn" title="Удалить статью">✕</button></td>`;
      const catNameEl = tr.querySelector('input[type="text"]');
      const [catVladEl, catAlenaEl] = tr.querySelectorAll('input[type="number"]');
      catNameEl.addEventListener("input", () => { cat.name = catNameEl.value; });
      if (!hasSub) {
        catVladEl.addEventListener("change", () => { cat.vlad = parseNum(catVladEl.value); bgRenderExpenses(); bgRecalc(); });
        catAlenaEl.addEventListener("change", () => { cat.alena = parseNum(catAlenaEl.value); bgRenderExpenses(); bgRecalc(); });
      }
      tr.querySelector(".budget-rm-btn").addEventListener("click", () => {
        group.categories.splice(ci, 1); bgRenderExpenses(); bgRecalc();
      });
      tbody.appendChild(tr);

      cat.subrows.forEach((sub, si) => {
        const subTotal = bgLeafTotal(sub);
        const subtr = document.createElement("tr");
        subtr.className = "budget-subrow";
        subtr.innerHTML = `
          <td><input type="text" value="${bgEsc(sub.name)}" /></td>
          <td class="num readonly">${fmtEUR(subTotal)}</td>
          <td class="num"><input type="number" step="0.01" value="${sub.vlad}" /></td>
          <td class="num"><input type="number" step="0.01" value="${sub.alena}" /></td>
          <td><button class="budget-rm-btn" title="Удалить подстатью">✕</button></td>`;
        const subNameEl = subtr.querySelector('input[type="text"]');
        const [subVladEl, subAlenaEl] = subtr.querySelectorAll('input[type="number"]');
        subNameEl.addEventListener("input", () => { sub.name = subNameEl.value; });
        subVladEl.addEventListener("change", () => { sub.vlad = parseNum(subVladEl.value); bgRenderExpenses(); bgRecalc(); });
        subAlenaEl.addEventListener("change", () => { sub.alena = parseNum(subAlenaEl.value); bgRenderExpenses(); bgRecalc(); });
        subtr.querySelector(".budget-rm-btn").addEventListener("click", () => {
          cat.subrows.splice(si, 1); bgRenderExpenses(); bgRecalc();
        });
        tbody.appendChild(subtr);
      });

      const addSubTr = document.createElement("tr");
      addSubTr.innerHTML = `<td colspan="5"><button class="add-row-btn add-sub-btn">+ подстатья в «${bgEsc(cat.name)}»</button></td>`;
      addSubTr.querySelector("button").addEventListener("click", () => {
        cat.subrows.push({ name: "Новая подстатья", vlad: 0, alena: 0 });
        bgRenderExpenses(); bgRecalc();
      });
      tbody.appendChild(addSubTr);
    });

    const addCatBtn = document.createElement("button");
    addCatBtn.className = "add-row-btn";
    addCatBtn.textContent = `+ статья в «${group.name}»`;
    addCatBtn.addEventListener("click", () => {
      group.categories.push({ name: "Новая статья", vlad: 0, alena: 0, subrows: [] });
      bgRenderExpenses(); bgRecalc();
    });
    container.appendChild(addCatBtn);
  });
}

function bgAddGroup() {
  bgExpenseGroups.push({ name: "Новая группа", categories: [{ name: "Статья", vlad: 0, alena: 0, subrows: [] }] });
  bgRenderExpenses(); bgRecalc();
}

function bgRecalc() {
  const incomeTotal = bgIncome.reduce((s, r) => s + bgLeafTotal(r), 0);
  const vladIncome = bgIncome.reduce((s, r) => s + (parseFloat(r.vlad) || 0), 0);
  const alenaIncome = bgIncome.reduce((s, r) => s + (parseFloat(r.alena) || 0), 0);

  let expenseTotal = 0, vladExpense = 0, alenaExpense = 0, reserve = 0;
  bgExpenseGroups.forEach((g) => {
    g.categories.forEach((c) => {
      const total = bgCategoryTotal(c);
      expenseTotal += total;
      vladExpense += bgCategoryVlad(c);
      alenaExpense += bgCategoryAlena(c);
      if (c.name.trim().toLowerCase() === "резерв") reserve += total;
    });
  });

  const balance = incomeTotal - expenseTotal;
  document.getElementById("bgIncomeTotalTitle").textContent = fmtEUR(incomeTotal);
  document.getElementById("bgKpiIncome").textContent = fmtEUR(incomeTotal);
  document.getElementById("bgKpiExpense").textContent = fmtEUR(expenseTotal);
  document.getElementById("bgKpiReserve").textContent = fmtEUR(reserve);
  const balEl = document.getElementById("bgKpiBalance");
  balEl.textContent = fmtEUR(balance);
  balEl.className = "kpi-value " + signClass(balance);

  document.getElementById("bgVladIncome").textContent = fmtEUR(vladIncome);
  document.getElementById("bgVladExpense").textContent = fmtEUR(vladExpense);
  document.getElementById("bgVladNet").textContent = fmtEUR(vladIncome - vladExpense);
  document.getElementById("bgAlenaIncome").textContent = fmtEUR(alenaIncome);
  document.getElementById("bgAlenaExpense").textContent = fmtEUR(alenaExpense);
  document.getElementById("bgAlenaNet").textContent = fmtEUR(alenaIncome - alenaExpense);
}

function wireBudgetInputs() {
  document.getElementById("bgAddIncomeBtn").addEventListener("click", bgAddIncomeRow);
  document.getElementById("bgAddGroupBtn").addEventListener("click", bgAddGroup);
  bgRenderIncome();
  bgRenderExpenses();
  bgRecalc();
}

/* -------------------------- Семейный кэш-флоу на 15 лет (раздел "Кэш-флоу 15 лет") -------------------------- */

const CF_STORAGE_KEY = "cashflow_state_v1";

let cfSettings = {
  startDate: "2026-07",
  moveInDate: "2033-07",
  startReserve: 20000,
  baseIncome: 6600,
  baseExpense: 4200,
  downPaymentAmount: 100000,
  downPaymentDate: "2026-07",
};

let cfIncomeEvents = [
  { name: "Сдача квартиры (кредитной)", amount: 1400, freq: "monthly", start: "2026-07", end: null, linked: "moveIn" },
];

let cfExpenseEvents = [
  { name: "Кредит на квартиру", amount: 4150, freq: "monthly", start: "2026-07", end: null, linked: "downPayment" },
  { name: "Аренда текущей квартиры", amount: 1400, freq: "monthly", start: "2026-07", end: null, linked: "moveIn" },
];

let cfDividendsByYear = [3000, 3000, 3200, 3200, 3400];

/* ---- дата-утилиты: ym строится как year*12+(month-1), чтобы calendarYearOf корректно восстанавливал год ---- */
function cfYm(str) {
  const [y, m] = str.split("-").map(Number);
  return y * 12 + (m - 1);
}
function cfYmToLabel(idx) {
  const y = Math.floor(idx / 12);
  const m = idx - y * 12 + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}
function cfCalendarYearOf(idx) { return Math.floor(idx / 12); }

/* ---- связанные поля: "downPayment" переопределяет start, "moveIn" переопределяет end ---- */
function cfEventStart(ev) {
  if (ev.linked === "downPayment") return cfYm(cfSettings.downPaymentDate);
  return cfYm(ev.start);
}
function cfEventEnd(ev) {
  if (ev.linked === "moveIn") return cfYm(cfSettings.moveInDate) - 1;
  return ev.end ? cfYm(ev.end) : Infinity;
}

function cfMonthlyContribution(ev, monthIdx) {
  const s = cfEventStart(ev);
  const e = cfEventEnd(ev);
  if (monthIdx < s || monthIdx > e) return 0;
  const offset = monthIdx - s;
  if (ev.freq === "once") return monthIdx === s ? ev.amount : 0;
  if (ev.freq === "monthly") return ev.amount;
  if (ev.freq === "annual") return offset % 12 === 0 ? ev.amount : 0;
  return 0;
}

/* ---- дивиденды: год 1 = первый ПОЛНЫЙ календарный год после startDate, выплата целиком в декабре ---- */
function cfDividendYear(i) {
  const startYear = parseInt(cfSettings.startDate.split("-")[0], 10);
  return startYear + 1 + i;
}
function cfDividendContribution(monthIdx) {
  const calMonth = ((monthIdx % 12) + 12) % 12;
  if (calMonth !== 11) return 0;
  const y = cfCalendarYearOf(monthIdx);
  for (let i = 0; i < cfDividendsByYear.length; i++) {
    if (y === cfDividendYear(i)) return cfDividendsByYear[i];
  }
  return 0;
}

/**
 * Главный цикл: 180 месяцев с startDate. reserveBeforeDownPayment фиксируется
 * ДО списания взноса (и до начисления net этого месяца) — поэтому при
 * downPaymentDate=startDate он равен startReserve, ещё нетронутому.
 */
function cfRecalc() {
  const startIdx = cfYm(cfSettings.startDate);
  const months = [];
  for (let i = 0; i < 180; i++) months.push(startIdx + i);

  const incArr = [], expArr = [], netFlow = [], cum = [];
  let running = cfSettings.startReserve;
  const dpMonthIdx = cfYm(cfSettings.downPaymentDate);
  let reserveBeforeDownPayment = null;

  months.forEach((monthIdx) => {
    let inc = cfSettings.baseIncome;
    let exp = cfSettings.baseExpense;
    cfIncomeEvents.forEach((ev) => { inc += cfMonthlyContribution(ev, monthIdx); });
    cfExpenseEvents.forEach((ev) => { exp += cfMonthlyContribution(ev, monthIdx); });
    inc += cfDividendContribution(monthIdx);

    if (monthIdx === dpMonthIdx) {
      reserveBeforeDownPayment = running;
      exp += cfSettings.downPaymentAmount;
    }

    incArr.push(inc);
    expArr.push(exp);
    const net = inc - exp;
    netFlow.push(net);
    running += net;
    cum.push(running);
  });

  if (reserveBeforeDownPayment === null) reserveBeforeDownPayment = cfSettings.startReserve;
  return { months, incArr, expArr, netFlow, cum, reserveBeforeDownPayment, dpMonthIdx };
}

function cfRenderKpis(res) {
  const endReserve = res.cum[179];
  let minVal = res.cum[0], minIdx = 0;
  res.cum.forEach((v, i) => { if (v < minVal) { minVal = v; minIdx = i; } });
  const gapMonths = res.cum.filter((v) => v < 0).length;

  const endEl = document.getElementById("cfKpiEndReserve");
  endEl.textContent = fmtEUR(endReserve);
  endEl.className = "kpi-value " + signClass(endReserve);

  const minEl = document.getElementById("cfKpiMinReserve");
  minEl.textContent = `${fmtEUR(minVal)} (${cfYmToLabel(res.months[minIdx])})`;
  minEl.className = "kpi-value " + signClass(minVal);

  const gapEl = document.getElementById("cfKpiGapMonths");
  gapEl.textContent = String(gapMonths);
  gapEl.className = "kpi-value " + (gapMonths === 0 ? "is-positive" : "is-negative");

  const enough = res.reserveBeforeDownPayment >= cfSettings.downPaymentAmount;
  const dpEl = document.getElementById("cfKpiDownPayment");
  if (enough) {
    const spare = res.reserveBeforeDownPayment - cfSettings.downPaymentAmount;
    dpEl.textContent = `Накоплено ${fmtEUR(res.reserveBeforeDownPayment)} из ${fmtEUR(cfSettings.downPaymentAmount)} — с запасом ${fmtEUR(spare)}`;
    dpEl.className = "kpi-value is-positive";
  } else {
    const gap = cfSettings.downPaymentAmount - res.reserveBeforeDownPayment;
    dpEl.textContent = `Накоплено ${fmtEUR(res.reserveBeforeDownPayment)} из ${fmtEUR(cfSettings.downPaymentAmount)} — не хватает ${fmtEUR(gap)} к ${cfSettings.downPaymentDate}`;
    dpEl.className = "kpi-value is-negative";
  }
}

let cfReserveChart = null;
let cfNetFlowChart = null;

function cfYearBoundaryLabel(months, i) {
  if (i === 0) return String(cfCalendarYearOf(months[0]));
  const yPrev = cfCalendarYearOf(months[i - 1]);
  const yCur = cfCalendarYearOf(months[i]);
  return yCur !== yPrev ? String(yCur) : "";
}

function cfZeroLineGrid(ctx) {
  return ctx.tick.value === 0 ? "#7C8798" : "#1E2530";
}

function cfRenderCharts(res) {
  const labels = res.months.map((m) => cfYmToLabel(m));

  if (cfReserveChart) cfReserveChart.destroy();
  cfReserveChart = new Chart(document.getElementById("cfReserveChart"), {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Резерв нарастающим итогом",
        data: res.cum,
        borderWidth: 2.5,
        pointRadius: 0,
        fill: true,
        backgroundColor: "rgba(195,154,72,0.10)",
        tension: 0.1,
        segment: {
          borderColor: (ctx) => (ctx.p0.parsed.y < 0 || ctx.p1.parsed.y < 0) ? "#C25C50" : "#C39A48",
        },
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { color: "#7C8798", font: { family: "IBM Plex Mono", size: 10 }, autoSkip: false, maxRotation: 0, callback: (v, i) => cfYearBoundaryLabel(res.months, i) },
          grid: { color: "#1E2530" },
        },
        y: {
          ticks: { color: "#7C8798", font: { family: "IBM Plex Mono", size: 10 } },
          grid: { color: cfZeroLineGrid },
        },
      },
    },
  });

  if (cfNetFlowChart) cfNetFlowChart.destroy();
  cfNetFlowChart = new Chart(document.getElementById("cfNetFlowChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Чистый поток",
        data: res.netFlow,
        backgroundColor: res.netFlow.map((v) => (v < 0 ? "rgba(194,92,80,0.65)" : "rgba(76,123,147,0.65)")),
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { color: "#7C8798", font: { family: "IBM Plex Mono", size: 10 }, autoSkip: false, maxRotation: 0, callback: (v, i) => cfYearBoundaryLabel(res.months, i) },
          grid: { color: "#1E2530" },
        },
        y: {
          ticks: { color: "#7C8798", font: { family: "IBM Plex Mono", size: 10 } },
          grid: { color: cfZeroLineGrid },
        },
      },
    },
  });
}

/**
 * Группировка строго по реальным календарным годам (не "12 месяцев от
 * старта") — первый/последний год горизонта обычно неполные, это подписано
 * явно. Строка года свёрнута по умолчанию, клик разворачивает месяцы.
 */
function cfRenderYearTable(res) {
  const tbody = document.getElementById("cfYearTableBody");
  tbody.innerHTML = "";

  const byYear = {};
  res.months.forEach((monthIdx, i) => {
    const y = cfCalendarYearOf(monthIdx);
    if (!byYear[y]) byYear[y] = [];
    byYear[y].push(i);
  });
  const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);

  years.forEach((year) => {
    const idxs = byYear[year];
    const yIncome = idxs.reduce((s, i) => s + res.incArr[i], 0);
    const yExpense = idxs.reduce((s, i) => s + res.expArr[i], 0);
    const yBalance = res.cum[idxs[idxs.length - 1]];
    const isPartial = idxs.length < 12;

    const yearTr = document.createElement("tr");
    yearTr.className = "cf-year-row";
    yearTr.innerHTML = `
      <td>${year}${isPartial ? ` (неполный, ${idxs.length} мес.)` : ""}</td>
      <td class="num">${fmtEUR(yIncome)}</td>
      <td class="num">${fmtEUR(yExpense)}</td>
      <td class="num ${signClass(yBalance)}">${fmtEUR(yBalance)}</td>`;
    tbody.appendChild(yearTr);

    const monthRows = [];
    idxs.forEach((i) => {
      const monthTr = document.createElement("tr");
      monthTr.className = "cf-month-row is-hidden";
      monthTr.innerHTML = `
        <td>${cfYmToLabel(res.months[i])}</td>
        <td class="num">${fmtEUR(res.incArr[i])}</td>
        <td class="num">${fmtEUR(res.expArr[i])}</td>
        <td class="num ${signClass(res.cum[i])}">${fmtEUR(res.cum[i])}</td>`;
      tbody.appendChild(monthTr);
      monthRows.push(monthTr);
    });

    yearTr.addEventListener("click", () => {
      const expanded = yearTr.classList.toggle("is-expanded");
      monthRows.forEach((r) => r.classList.toggle("is-hidden", !expanded));
    });
  });
}

function cfSaveState() {
  localStorage.setItem(CF_STORAGE_KEY, JSON.stringify({
    settings: cfSettings,
    incomeEvents: cfIncomeEvents,
    expenseEvents: cfExpenseEvents,
    dividendsByYear: cfDividendsByYear,
  }));
}

function cfLoadState() {
  try {
    const raw = localStorage.getItem(CF_STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.settings) Object.assign(cfSettings, data.settings);
    if (Array.isArray(data.incomeEvents)) cfIncomeEvents = data.incomeEvents;
    if (Array.isArray(data.expenseEvents)) cfExpenseEvents = data.expenseEvents;
    if (Array.isArray(data.dividendsByYear)) cfDividendsByYear = data.dividendsByYear;
  } catch (e) { /* повреждённые данные в localStorage — просто игнорируем, останутся дефолты */ }
}

function cfApplySettingsToDom() {
  document.getElementById("cfStartDate").value = cfSettings.startDate;
  document.getElementById("cfMoveInDate").value = cfSettings.moveInDate;
  document.getElementById("cfStartReserve").value = cfSettings.startReserve;
  document.getElementById("cfDownPaymentAmount").value = cfSettings.downPaymentAmount;
  document.getElementById("cfDownPaymentDate").value = cfSettings.downPaymentDate;
  document.getElementById("cfBaseIncome").value = cfSettings.baseIncome;
  document.getElementById("cfBaseExpense").value = cfSettings.baseExpense;
}

function cfReadSettingsFromDom() {
  cfSettings.startDate = document.getElementById("cfStartDate").value || cfSettings.startDate;
  cfSettings.moveInDate = document.getElementById("cfMoveInDate").value || cfSettings.moveInDate;
  cfSettings.startReserve = parseNum(document.getElementById("cfStartReserve").value) || 0;
  cfSettings.downPaymentAmount = parseNum(document.getElementById("cfDownPaymentAmount").value) || 0;
  cfSettings.downPaymentDate = document.getElementById("cfDownPaymentDate").value || cfSettings.downPaymentDate;
  cfSettings.baseIncome = parseNum(document.getElementById("cfBaseIncome").value) || 0;
  cfSettings.baseExpense = parseNum(document.getElementById("cfBaseExpense").value) || 0;
}

function cfRenderDividends() {
  const grid = document.getElementById("cfDividendsGrid");
  grid.innerHTML = "";
  cfDividendsByYear.forEach((val, i) => {
    const year = cfDividendYear(i);
    const label = document.createElement("label");
    label.className = "pension-input";
    label.innerHTML = `<span class="figure-label">${year}, €</span><input type="number" step="100" value="${val}" />`;
    const input = label.querySelector("input");
    input.addEventListener("change", () => { cfDividendsByYear[i] = parseNum(input.value) || 0; cfFullRender(); });
    grid.appendChild(label);
  });
}

function cfRenderEventsTable(events, tbodyId) {
  const tbody = document.getElementById(tbodyId);
  tbody.innerHTML = "";
  events.forEach((ev, i) => {
    const startDisabled = ev.linked === "downPayment";
    const endDisabled = ev.linked === "moveIn";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="text" value="${bgEsc(ev.name)}" /></td>
      <td class="num"><input type="number" step="10" value="${ev.amount}" /></td>
      <td>
        <select>
          <option value="monthly" ${ev.freq === "monthly" ? "selected" : ""}>в месяц</option>
          <option value="annual" ${ev.freq === "annual" ? "selected" : ""}>в год</option>
          <option value="once" ${ev.freq === "once" ? "selected" : ""}>разово</option>
        </select>
      </td>
      <td>${startDisabled ? '<span class="cf-linked-badge">🔗 дата взноса</span>' : `<input type="month" value="${ev.start || ""}" />`}</td>
      <td>${endDisabled ? '<span class="cf-linked-badge">🔗 до переезда</span>' : `<input type="month" value="${ev.end || ""}" />`}</td>
      <td><button class="budget-rm-btn" title="Удалить">✕</button></td>`;

    const nameEl = tr.querySelector('input[type="text"]');
    const amountEl = tr.querySelector('input[type="number"]');
    const freqEl = tr.querySelector("select");
    const monthInputs = tr.querySelectorAll('input[type="month"]');

    nameEl.addEventListener("input", () => { ev.name = nameEl.value; cfSaveState(); });
    amountEl.addEventListener("change", () => { ev.amount = parseNum(amountEl.value) || 0; cfFullRender(); });
    freqEl.addEventListener("change", () => { ev.freq = freqEl.value; cfFullRender(); });
    if (!startDisabled) {
      monthInputs[0].addEventListener("change", () => { ev.start = monthInputs[0].value; cfFullRender(); });
    }
    if (!endDisabled) {
      const endEl = monthInputs[monthInputs.length - 1];
      endEl.addEventListener("change", () => { ev.end = endEl.value || null; cfFullRender(); });
    }
    tr.querySelector(".budget-rm-btn").addEventListener("click", () => {
      events.splice(i, 1);
      cfRenderEventsTable(events, tbodyId);
      cfFullRender();
    });
    tbody.appendChild(tr);
  });
}

function cfFullRender() {
  cfReadSettingsFromDom();
  const res = cfRecalc();
  cfRenderKpis(res);
  cfRenderCharts(res);
  cfRenderYearTable(res);
  cfSaveState();
}

function wireCashflowInputs() {
  cfLoadState();
  cfApplySettingsToDom();

  const settingsIds = ["cfStartDate", "cfMoveInDate", "cfStartReserve", "cfDownPaymentAmount", "cfDownPaymentDate", "cfBaseIncome", "cfBaseExpense"];
  settingsIds.forEach((id) => {
    document.getElementById(id).addEventListener("change", () => {
      cfFullRender();
      cfRenderDividends();
    });
  });

  document.getElementById("cfAddIncomeEventBtn").addEventListener("click", () => {
    cfIncomeEvents.push({ name: "Новый доход", amount: 0, freq: "monthly", start: cfSettings.startDate, end: null, linked: null });
    cfRenderEventsTable(cfIncomeEvents, "cfIncomeEventsBody");
    cfFullRender();
  });
  document.getElementById("cfAddExpenseEventBtn").addEventListener("click", () => {
    cfExpenseEvents.push({ name: "Новая затрата", amount: 0, freq: "monthly", start: cfSettings.startDate, end: null, linked: null });
    cfRenderEventsTable(cfExpenseEvents, "cfExpenseEventsBody");
    cfFullRender();
  });

  cfRenderEventsTable(cfIncomeEvents, "cfIncomeEventsBody");
  cfRenderEventsTable(cfExpenseEvents, "cfExpenseEventsBody");
  cfRenderDividends();
  cfFullRender();
}

/* -------------------------- Сохранение полей "Пенсия Алена" между открытиями (localStorage) -------------------------- */

const PENSION_ALENA_STORAGE_KEY = "pensionAlena_inputs_v1";
const PENSION_ALENA_FIELD_IDS = [
  "bPAge", "bPRetireAge", "bPEndAge", "bPNominalReturn", "bPInflation", "bPWithdrawRate", "bPAnnualContribution",
  "bDeYearsWorked", "bDeSalaryGross", "bPpContrib", "bPpFullPayout", "bCiTargetMonthly",
];

function loadPensionAlenaInputs() {
  try {
    const raw = localStorage.getItem(PENSION_ALENA_STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    PENSION_ALENA_FIELD_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (el && data[id] !== undefined) el.value = data[id];
    });
  } catch (e) { /* повреждённые данные в localStorage — просто игнорируем */ }
}

function savePensionAlenaInputs() {
  const data = {};
  PENSION_ALENA_FIELD_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) data[id] = el.value;
  });
  localStorage.setItem(PENSION_ALENA_STORAGE_KEY, JSON.stringify(data));
}

function wirePensionAlenaPersistence() {
  PENSION_ALENA_FIELD_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", savePensionAlenaInputs);
  });
}

/* -------------------------- План докупок / ребалансировки (раздел "План докупок", localStorage) -------------------------- */

const RP_STORAGE_KEY = "rebalancePlan_v1";

// Единственный реально известный транш из обсуждения плана (SMH, транш 2) —
// стартовый пример; остальные транши пользователь добавляет сам кнопкой
// "+ добавить транш" или кнопкой "Сгенерировать 3 транша" (портфель "500к" в
// Google Sheets не хранит триггеры/дедлайны транша, только план/факт по
// активам — взять их оттуда напрямую нельзя, только сумму через getPlanDeltas()).
// side: "buy" (докупка на просадке) | "sell" (продажа — напр. к дедлайну).
let rpTranches = [];
let rpWorkerUrl = "";

function rpUid() {
  return `rp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function rpTodayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function rpSaveState() {
  localStorage.setItem(RP_STORAGE_KEY, JSON.stringify({ tranches: rpTranches, workerUrl: rpWorkerUrl }));
}

function rpLoadState() {
  try {
    const raw = localStorage.getItem(RP_STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (Array.isArray(data.tranches)) rpTranches = data.tranches;
      if (typeof data.workerUrl === "string") rpWorkerUrl = data.workerUrl;
    }
  } catch (e) { /* повреждённые данные в localStorage — просто игнорируем, останутся дефолты */ }

  // Одноразовая миграция: план "избавиться от GOOGL к концу года" — сумма уже
  // считается сама (план по GOOGL в "портфель 500к" обнулён, факт минус план
  // даёт нужную сумму продажи), здесь нужен только дедлайн. Добавляется
  // автоматически при первом заходе, если такого транша ещё нет — руками
  // вводить не нужно.
  if (!rpTranches.some((t) => t.asset === "GOOGL")) {
    rpTranches.push({
      id: "rp-seed-googl-sell", asset: "GOOGL", side: "sell", tranche: 1, triggerPct: "",
      triggerPrice: "", peakRef: "", amountPlan: "", deadline: "2026-12-31", status: "pending",
      execDate: "", execPrice: "", execAmount: "", cycle: "2026-divest",
    });
    rpSaveState();
  }

  // Одноразовая миграция: старый вручную зафиксированный SMH-транш (сумма
  // 12819 — фиксированный override) больше не нужен, он покрывал только
  // часть текущей живой суммы ($42,793 из "портфель 500к"). Убираем его,
  // чтобы SMH попал в тот же механизм автогенерации ("Сгенерировать 3
  // транша"), что и остальные активы без своего транша — единообразно.
  if (rpTranches.some((t) => t.id === "rp-seed-smh-2")) {
    rpTranches = rpTranches.filter((t) => t.id !== "rp-seed-smh-2");
    rpSaveState();
  }
}

function rpGetAssetPrices() {
  const prices = {};
  if (mainProfile.getTickerPrices) Object.assign(prices, mainProfile.getTickerPrices());
  return prices;
}

function rpGetAssetPeaks() {
  const peaks = {};
  if (mainProfile.getAssetPeaks) Object.assign(peaks, mainProfile.getAssetPeaks());
  return peaks;
}

// "Сколько докупить/продать" по тикеру — живьём из "портфель 500к" (план минус
// факт). Источник истины по сумме — Sheet, не вручную вписанное "Сумма плана"
// в таблице траншей (та задаёт только тайминг — триггер/дедлайн).
function rpGetPlanDeltas() {
  const deltas = {};
  if (mainProfile.getPlanDeltas) Object.assign(deltas, mainProfile.getPlanDeltas());
  return deltas;
}

// Сумма, которую показывать/рекомендовать для конкретного транша: если в
// строке транша вручную указана "Сумма плана" (override) — используем её;
// иначе — живой остаток из Sheet ("план минус факт" по этому активу).
// Возвращается модуль суммы — знак (докупить/продать) уже несёт "Команда"/"Тип",
// дублировать его в сумме не нужно (для "продать" в Sheet дельта отрицательна —
// факт больше плана, т.е. актив в избытке).
function rpTrancheAmount(t, deltas) {
  if (t.amountPlan !== null && t.amountPlan !== undefined && t.amountPlan !== "" && t.amountPlan !== 0) return Math.abs(t.amountPlan);
  const delta = deltas[t.asset];
  return delta !== null && delta !== undefined ? Math.abs(delta) : null;
}

// Логика триггера — та же, что зашита в системный промпт Worker'а (раздел 4
// ТЗ): срабатывает по цене ИЛИ по дедлайну (гибрид — не ждать бесконечно).
// Для покупки (side="buy") триггер — цена УПАЛА до trigger_price или ниже
// (просадка от пика). Для продажи (side="sell") — цена ВЫРОСЛА до trigger_price
// или выше (если задана); в любом случае дедлайн срабатывает независимо от
// цены — это покрывает случай "избавиться от актива к такому-то сроку".
// Только для статуса "pending".
function rpComputeLiveStatus(t, prices, todayISO) {
  const price = prices[t.asset];
  const hasTriggerPrice = t.triggerPrice !== null && t.triggerPrice !== undefined && t.triggerPrice !== "";
  const hasPrice = price !== null && price !== undefined && hasTriggerPrice;
  const triggeredByPrice = hasPrice && (t.side === "sell" ? price >= t.triggerPrice : price <= t.triggerPrice);
  const triggeredByDeadline = !!t.deadline && todayISO >= t.deadline;
  const verb = t.side === "sell" ? "ПРОДАТЬ" : "КУПИТЬ";
  if (triggeredByPrice && triggeredByDeadline) return { label: `${verb} (цена+дедлайн)`, cls: "rp-badge--hit", triggered: true };
  if (triggeredByPrice) return { label: `${verb} (цена)`, cls: "rp-badge--hit", triggered: true };
  if (triggeredByDeadline) return { label: `${verb} (дедлайн)`, cls: "rp-badge--hit", triggered: true };
  return { label: "ждать", cls: "rp-badge--wait", triggered: false };
}

function rpFmtUSD(value) {
  if (value === null || value === undefined || value === "" || isNaN(value)) return "—";
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

// Сводка "актив → что делать сейчас": по одному ряду на каждый актив, у
// которого либо есть настроенный транш, либо есть живая дельта план/факт из
// "портфель 500к" (кроме Cash — это не торгуемый актив). Так активы без
// вручную настроенного триггера (CSPX, SOXX и т.п.) тоже видны сразу — по
// ним статус "см. рекомендацию": точный тайминг ещё не задан, но кнопка
// "Обновить рекомендацию" всё равно даст совет от Claude по цене/времени,
// используя эту же живую сумму.
function rpRenderAssetsSummary() {
  const body = document.getElementById("rpAssetsBody");
  if (!body) return;
  body.innerHTML = "";
  const prices = rpGetAssetPrices();
  const deltas = rpGetPlanDeltas();
  const today = rpTodayISO();

  const assets = [];
  rpTranches.forEach((t) => { if (t.asset && !assets.includes(t.asset)) assets.push(t.asset); });
  Object.keys(deltas).forEach((ticker) => {
    if (ticker !== "Cash" && !assets.includes(ticker)) assets.push(ticker);
  });

  if (!assets.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty-row">Нет ни настроенных траншей, ни данных плана/факта — добавь транш ниже или проверь «портфель 500к».</td></tr>';
    return;
  }

  assets.forEach((asset) => {
    const pending = rpTranches.filter((t) => t.asset === asset && t.status === "pending");
    const price = prices[asset];
    const delta = deltas[asset];
    const triggered = pending
      .map((t) => ({ t, live: rpComputeLiveStatus(t, prices, today) }))
      .filter((x) => x.live.triggered);

    let command, cls, explain, amountText, needsGenerateBtn = false;
    if (!pending.length && !rpTranches.some((t) => t.asset === asset)) {
      command = "СМ. РЕКОМЕНДАЦИЮ"; cls = "rp-cmd--hold";
      explain = "триггер/тайминг не настроен — жми «Обновить рекомендацию» за советом или сгенерируй черновые транши автоматически →";
      amountText = delta !== null && delta !== undefined ? rpFmtUSD(delta) : "—";
      needsGenerateBtn = delta !== null && delta !== undefined && delta !== 0;
    } else if (!pending.length) {
      command = "—"; cls = "rp-cmd--hold";
      explain = "нет ожидающих траншей по этому активу";
      amountText = delta !== null && delta !== undefined ? rpFmtUSD(delta) : "—";
    } else if (triggered.length) {
      const verbs = [...new Set(triggered.map((x) => (x.t.side === "sell" ? "ПРОДАВАТЬ" : "ПОКУПАТЬ")))];
      command = verbs.join(" / "); cls = "rp-cmd--act";
      explain = triggered.map((x) => `транш №${x.t.tranche ?? "?"}: ${x.live.label.toLowerCase()}`).join("; ");
      const amounts = triggered.map((x) => rpTrancheAmount(x.t, deltas)).filter((a) => a !== null && a !== undefined);
      amountText = amounts.length ? amounts.map(rpFmtUSD).join(" + ") : "—";
    } else {
      command = "ДЕРЖАТЬ"; cls = "rp-cmd--hold";
      const nearest = pending[0];
      explain = `ближайший транш №${nearest.tranche ?? "?"}: триггер ${nearest.triggerPrice || "—"}${nearest.deadline ? `, дедлайн ${nearest.deadline}` : ""}`;
      amountText = delta !== null && delta !== undefined ? rpFmtUSD(delta) : "—";
    }

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${bgEsc(asset)}</td>
      <td class="num">${amountText}</td>
      <td class="num">${price !== null && price !== undefined ? price : "—"}</td>
      <td><span class="rp-cmd ${cls}">${command}</span></td>
      <td class="rp-explain">${bgEsc(explain)}${needsGenerateBtn ? ' <button class="rp-generate-btn" type="button">Сгенерировать 3 транша</button>' : ""}</td>`;
    if (needsGenerateBtn) {
      tr.querySelector(".rp-generate-btn").addEventListener("click", () => rpGenerateTranches(asset));
    }
    body.appendChild(tr);
  });
}

function rpRenderTable() {
  const body = document.getElementById("rpTableBody");
  if (!body) return;
  body.innerHTML = "";
  const prices = rpGetAssetPrices();
  const today = rpTodayISO();

  rpTranches.forEach((t, i) => {
    const live = t.status === "pending" ? rpComputeLiveStatus(t, prices, today) : null;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="text" value="${bgEsc(t.asset || "")}" /></td>
      <td>
        <select class="rp-side-select">
          <option value="buy"${t.side !== "sell" ? " selected" : ""}>покупка</option>
          <option value="sell"${t.side === "sell" ? " selected" : ""}>продажа</option>
        </select>
      </td>
      <td class="num"><input type="number" step="1" value="${t.tranche ?? ""}" /></td>
      <td class="num"><input type="number" step="0.1" value="${t.triggerPct ?? ""}" /></td>
      <td class="num"><input type="number" step="0.01" value="${t.triggerPrice ?? ""}" /></td>
      <td class="num"><input type="number" step="0.01" value="${t.peakRef ?? ""}" /></td>
      <td class="num"><input type="number" step="1" value="${t.amountPlan ?? ""}" /></td>
      <td><input type="date" value="${t.deadline || ""}" /></td>
      <td class="rp-status-cell">
        <select class="rp-status-select">
          <option value="pending"${t.status === "pending" ? " selected" : ""}>pending</option>
          <option value="done"${t.status === "done" ? " selected" : ""}>done</option>
          <option value="skipped"${t.status === "skipped" ? " selected" : ""}>skipped</option>
        </select>
        ${live ? `<span class="rp-badge ${live.cls}">${live.label}</span>` : ""}
      </td>
      <td><input type="date" value="${t.execDate || ""}" /></td>
      <td class="num"><input type="number" step="0.01" value="${t.execPrice ?? ""}" /></td>
      <td class="num"><input type="number" step="1" value="${t.execAmount ?? ""}" /></td>
      <td><input type="text" value="${bgEsc(t.cycle || "")}" /></td>
      <td><button class="budget-rm-btn" title="Удалить">✕</button></td>`;

    const [assetEl, trancheEl, pctEl, priceEl, peakEl, amountEl, deadlineEl, execDateEl, execPriceEl, execAmountEl, cycleEl] =
      tr.querySelectorAll("input");
    const sideEl = tr.querySelector(".rp-side-select");
    const statusEl = tr.querySelector(".rp-status-select");

    assetEl.addEventListener("change", () => { t.asset = assetEl.value.trim().toUpperCase(); rpRenderAll(); rpSaveState(); });
    sideEl.addEventListener("change", () => { t.side = sideEl.value; rpRenderAll(); rpSaveState(); });
    trancheEl.addEventListener("change", () => { t.tranche = parseNum(trancheEl.value); rpRenderAssetsSummary(); rpSaveState(); });
    pctEl.addEventListener("change", () => { t.triggerPct = parseNum(pctEl.value); rpSaveState(); });
    priceEl.addEventListener("change", () => { t.triggerPrice = parseNum(priceEl.value); rpRenderAll(); rpSaveState(); });
    peakEl.addEventListener("change", () => { t.peakRef = parseNum(peakEl.value); rpSaveState(); });
    amountEl.addEventListener("change", () => { t.amountPlan = parseNum(amountEl.value); rpSaveState(); });
    deadlineEl.addEventListener("change", () => { t.deadline = deadlineEl.value; rpRenderAll(); rpSaveState(); });
    execDateEl.addEventListener("change", () => { t.execDate = execDateEl.value; rpSaveState(); });
    execPriceEl.addEventListener("change", () => { t.execPrice = parseNum(execPriceEl.value); rpSaveState(); });
    execAmountEl.addEventListener("change", () => { t.execAmount = parseNum(execAmountEl.value); rpSaveState(); });
    cycleEl.addEventListener("input", () => { t.cycle = cycleEl.value; rpSaveState(); });
    statusEl.addEventListener("change", () => { t.status = statusEl.value; rpRenderAll(); rpSaveState(); });
    tr.querySelector(".budget-rm-btn").addEventListener("click", () => { rpTranches.splice(i, 1); rpRenderAll(); rpSaveState(); });

    body.appendChild(tr);
  });
}

function rpRenderAll() {
  rpRenderAssetsSummary();
  rpRenderTable();
}

function rpAddTranche() {
  rpTranches.push({
    id: rpUid(), asset: "", side: "buy", tranche: rpTranches.length + 1, triggerPct: -20, triggerPrice: "",
    peakRef: "", amountPlan: "", deadline: "", status: "pending",
    execDate: "", execPrice: "", execAmount: "", cycle: "",
  });
  rpRenderAll();
  rpSaveState();
}

// Разбить всю сумму "нужно докупить/продать" по активу на 3 транша с
// триггерами -10% / -20% / -30% от исторического пика (Asset_History) —
// вместо того чтобы просить пользователя считать это руками. Пик берётся не
// ниже текущей цены (иначе триггер получился бы уже пройденным задним числом).
// Суммы округляются до сотен долларов (реальный размер сделки, не копейки
// живой дельты). Дедлайны — гибрид с триггером, чтобы транш не ждал просадки
// бесконечно: 3/6/9 месяцев от сегодня (мельче просадка — ближе дедлайн).
const RP_AUTO_TRIGGER_LEVELS = [-10, -20, -30];
const RP_AUTO_DEADLINE_MONTHS = [3, 6, 9];

function rpRoundToHundred(v) {
  return Math.round(v / 100) * 100;
}

function rpAddMonths(dateISO, months) {
  const d = new Date(dateISO + "T00:00:00");
  d.setMonth(d.getMonth() + months);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function rpGenerateTranches(asset) {
  const deltas = rpGetPlanDeltas();
  const prices = rpGetAssetPrices();
  const peaks = rpGetAssetPeaks();
  const delta = deltas[asset];
  if (delta === null || delta === undefined || delta === 0) return;

  const side = delta < 0 ? "sell" : "buy";
  const totalAmount = Math.abs(delta);
  const price = prices[asset] || 0;
  const historicalPeak = peaks[asset] || 0;
  const peak = Math.max(historicalPeak, price) || price;
  const existingCount = rpTranches.filter((t) => t.asset === asset).length;
  const today = rpTodayISO();

  const n = RP_AUTO_TRIGGER_LEVELS.length;
  const rawBase = Math.floor(totalAmount / n);
  const rawAmounts = RP_AUTO_TRIGGER_LEVELS.map((_, i) => (i === n - 1 ? totalAmount - rawBase * (n - 1) : rawBase));
  const amounts = rawAmounts.map((a) => Math.max(100, rpRoundToHundred(a)));

  RP_AUTO_TRIGGER_LEVELS.forEach((pct, i) => {
    const triggerPrice = peak ? Math.round(peak * (1 + pct / 100) * 100) / 100 : "";
    rpTranches.push({
      id: rpUid(), asset, side, tranche: existingCount + i + 1, triggerPct: pct, triggerPrice,
      peakRef: peak || "", amountPlan: amounts[i], deadline: rpAddMonths(today, RP_AUTO_DEADLINE_MONTHS[i]),
      status: "pending", execDate: "", execPrice: "", execAmount: "", cycle: "авто",
    });
  });
  rpRenderAll();
  rpSaveState();
}

async function rpRefreshRecommendation() {
  const box = document.getElementById("rpRecommendBox");
  const meta = document.getElementById("rpRecommendMeta");
  const btn = document.getElementById("rpRefreshBtn");
  const base = (document.getElementById("rpWorkerUrl").value || "").trim().replace(/\/+$/, "");

  if (!base) {
    box.innerHTML = '<p class="rp-recommend-error">Сначала укажите URL Cloudflare Worker выше (после деплоя).</p>';
    return;
  }
  const url = `${base}/api/rebalance-recommendation`;

  btn.disabled = true;
  btn.textContent = "Запрашиваю...";
  box.innerHTML = '<p class="rp-recommend-placeholder">Запрашиваю рекомендацию...</p>';
  meta.textContent = "";

  try {
    const planRows = rpTranches
      .filter((t) => t.status === "pending")
      .map((t) => ({
        asset: t.asset, side: t.side || "buy", tranche: t.tranche, trigger_pct: t.triggerPct, trigger_price: t.triggerPrice,
        peak_ref: t.peakRef, amount_plan: t.amountPlan, deadline: t.deadline, status: t.status,
      }));

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        asset_prices: rpGetAssetPrices(),
        plan_deltas: rpGetPlanDeltas(),
        plan_rows: planRows,
        today: rpTodayISO(),
      }),
    });
    if (!resp.ok) throw new Error(`Worker вернул ошибку ${resp.status}`);
    const data = await resp.json();

    box.innerHTML = `<p class="rp-recommend-text">${bgEsc(data.recommendation || "(пустой ответ)")}</p>`;
    const ts = data.generated_at ? new Date(data.generated_at) : new Date();
    meta.textContent = `Сгенерировано: ${ts.toLocaleString("ru-RU")}`;
  } catch (e) {
    box.innerHTML = `<p class="rp-recommend-error">Не удалось получить рекомендацию: ${bgEsc(e.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Обновить рекомендацию";
  }
}

function wireRebalanceInputs() {
  rpLoadState();
  const urlInput = document.getElementById("rpWorkerUrl");
  urlInput.value = rpWorkerUrl;
  urlInput.addEventListener("change", () => { rpWorkerUrl = urlInput.value.trim(); rpSaveState(); });
  document.getElementById("rpAddTrancheBtn").addEventListener("click", rpAddTranche);
  document.getElementById("rpRefreshBtn").addEventListener("click", rpRefreshRecommendation);
  rpRenderAll();
}

/* -------------------------- Wire up UI (общее + по вкладкам) -------------------------- */

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("signInBtn").addEventListener("click", signIn);
  document.getElementById("signOutBtn").addEventListener("click", signOut);
  document.getElementById("refreshBtn").addEventListener("click", () => {
    PROFILES.forEach((p) => p.fetchAll());
  });
  document.querySelectorAll(".ccy-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const profile = TAB_TO_PROFILE[activeTab];
      if (!profile) return;
      profile.setCurrency(btn.dataset.ccy);
      syncCurrencyButtons();
    });
  });

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      activeTab = tab;
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
      document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.hidden = panel.dataset.tab !== tab;
      });
      document.querySelector(".currency-toggle").hidden = !TAB_TO_PROFILE[tab];
      syncCurrencyButtons();
      if (tab === "pension" && mainProfile.hasData()) mainProfile.renderPension();
      if (tab === "pensionAlena" && alenaProfile.hasData()) alenaProfile.renderPension();
      if (tab === "rebalance") rpRenderAll();
    });
  });

  PROFILES.forEach((p) => p.wireInteractions());
  wireRealEstateInputs();
  wireBudgetInputs();
  wireCashflowInputs();
  wireRebalanceInputs();
  wireOverallInputs();
  renderOverallTab();
  syncCurrencyButtons();

  initGis();
});
