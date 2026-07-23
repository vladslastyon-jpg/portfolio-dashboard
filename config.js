/**
 * КОНФИГУРАЦИЯ ДАШБОРДА
 * Теперь тут ДВА портфеля — твой ("main") и Алены ("alena") — оба на одном
 * сайте, переключаются вкладками сверху.
 */
window.DASHBOARD_CONFIG = {

  // OAuth Client ID из Google Cloud Console (тип "Web application") — один
  // на оба портфеля, т.к. это один и тот же сайт/домен.
  CLIENT_ID: "489308457784-4betgrc680spkh4tgm8e623lh1veicou.apps.googleusercontent.com",

  // ---------------- Твой портфель ----------------

  // ID твоей Google Таблицы «Анализ портфеля».
  SPREADSHEET_ID: "15bl-QSfCiUjbRs2aMzqoc5su7VpGQCzj7b5qO-DQcZg",

  // Названия листов твоей таблицы
  SHEETS: {
    portfolioSummary: "Portfolio_Summary",
    mdSummary: "MD_Summary",
    portfolioMonthly: "Portfolio_Monthly",
    transactions: "Транзакции",
    assetHistory: "Asset_History",
    goldHistory: "Gold_History",
    dashboardInputs: "Dashboard_Inputs",
    actualPortfolio: "Актуальный Портфель",
    portfolio500k: "портфель 500к",
  },

  // Тикеры твоего портфеля для графика "Доходность по активам" и легенды
  CORE_TICKERS: ["VOO", "CSPX", "SOXX", "SMH", "GOOGL", "4GLD"],
  ASSET_COLORS: {
    VOO: "#55A776", CSPX: "#3E7B8C", SOXX: "#C25C50",
    SMH: "#9A6BA0", GOOGL: "#C39A48", "4GLD": "#B8934A",
    Портфель: "#E9E6DC",
  },

  // ---------------- Портфель Алены ----------------

  // ID её Google Таблицы «Анализ портфеля Алена».
  SPREADSHEET_ID_ALENA: "1CT2jLPnx4CxFM75pFgJE7aQLBKkhJqYCKMIjoprb-Co",

  // Названия листов — оставлены такими же, т.к. её таблица является копией
  // твоей (поменяй здесь, если в её копии какой-то лист назван иначе).
  SHEETS_ALENA: {
    portfolioSummary: "Portfolio_Summary",
    mdSummary: "MD_Summary",
    portfolioMonthly: "Portfolio_Monthly",
    transactions: "Транзакции",
    assetHistory: "Asset_History",
    goldHistory: "Gold_History",
    dashboardInputs: "Dashboard_Inputs",
    actualPortfolio: "Актуальный Портфель",
    portfolio500k: "портфель 500к",
  },

  // Её реальные тикеры (для графика "Доходность по активам" и легенды)
  CORE_TICKERS_ALENA: ["AAPL", "META", "MSFT", "AMD", "AMZN", "GOOGL", "JNJ", "CSPX", "IBKR"],
  ASSET_COLORS_ALENA: {
    AAPL: "#55A776", META: "#3E7B8C", MSFT: "#C25C50", AMD: "#9A6BA0",
    AMZN: "#C39A48", GOOGL: "#8B6FB3", JNJ: "#4A8FA0", CSPX: "#B8934A",
    IBKR: "#7C8798",
    Портфель: "#E9E6DC",
  },

  // Права доступа: чтение + запись — одни на оба портфеля
  SCOPES: "https://www.googleapis.com/auth/spreadsheets",
};
