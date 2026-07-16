/**
 * КОНФИГУРАЦИЯ ДАШБОРДА
 * Заполни эти три значения согласно инструкции в SETUP.md, прежде чем открывать index.html.
 */
window.DASHBOARD_CONFIG = {

  // OAuth Client ID из Google Cloud Console (тип "Web application")
  // Пример: "1234567890-abc123xyz.apps.googleusercontent.com"
  CLIENT_ID: "489308457784-4betgrc680spkh4tgm8e623lh1veicou.apps.googleusercontent.com",

  // ID твоей Google Таблицы «Анализ портфеля».
  // Берётся из URL таблицы: https://docs.google.com/spreadsheets/d/ЭТА_ЧАСТЬ/edit
  SPREADSHEET_ID: "15bl-QSfCiUjbRs2aMzqoc5su7VpGQCzj7b5qO-DQcZg",

  // Названия листов — поменяй, если у тебя они называются иначе
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

  // Права доступа: чтение + запись (запись понадобится на следующем этапе для
  // редактирования Dashboard_Inputs прямо из дашборда)
  SCOPES: "https://www.googleapis.com/auth/spreadsheets",
};
