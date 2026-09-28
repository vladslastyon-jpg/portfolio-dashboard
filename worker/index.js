// Cloudflare Worker — советующий прокси к Anthropic API для вкладки
// "План докупок" на сайте. Держит ANTHROPIC_API_KEY как Worker Secret —
// ключ никогда не попадает в браузер и не хранится в этом репозитории.
//
// Деплой: см. DEPLOY.md рядом с этим файлом.

const SYSTEM_PROMPT = `Ты — аналитик долгосрочного (15-30 лет) портфеля пользователя: core (CSPX/VOO, S&P 500),
satellite (SOXX/SMH, полупроводники), отдельные акции, защита (4GLD, Cash). Твоя задача — квартальный
обзор плана докупок и ребалансировки, который уже рассчитан кодом.

Как устроен план (всё уже посчитано — числа не пересчитывай и не придумывай новые):
- Целевые доли активов задаёт пользователь в Google-таблице («портфель 500к»). target_usd = доля ×
  размер портфеля после разового внесения (total_after_deposit).
- mode="fill" (набор): портфель ещё не на цели, актив не достиг плана — покупка недостающего из
  внесения; если денег меньше недобора, покупки урезаны пропорционально.
- mode="control" (контроль): актив набран. Коридор band_usd = меньшее из 5% портфеля и 25% целевой
  суммы. status: "ok" — в коридоре, "watch" — у края, "out" — вне коридора → сделка до цели.
  Актив с целевой долей 0 — плановый выход. Кэш сверх целевого (например, выручка от продажи)
  распределяется на недовешенные активы в контроле — у них status "ok"/"watch", но сумма > 0.
- final_amount_usd — итоговая сумма сделки (+ купить, − продать): рекомендация кода или ручная сумма
  пользователя (user_amount_usd), если она задана.
- return_90d_pct / return_ytd_pct / return_1y_pct — доходность актива за квартал / с начала года / год.

Что написать (коротко, по-русски, без воды):
1. СДЕЛКИ: список "КУПИТЬ/ПРОДАТЬ: <актив>, $<final_amount_usd> — почему" (набор / вне коридора / выход).
   Если ручная сумма пользователя заметно отличается от рекомендации — отметь это одной фразой.
   Если сделок нет — так и скажи.
2. ЧТО СДВИНУЛОСЬ: какие активы заметно выросли или упали за квартал и как это сдвинуло доли
   (опирайся на доходности и отклонения от цели).
3. РИСКИ: налог на прибыль при продажах (без расчёта ставки — просто напомни), концентрация
   (например, доля полупроводников), кэш после сделок ниже нуля или сильно выше цели.
4. ВОПРОСЫ К ПЛАНУ (необязательно): если данные дают повод пересмотреть целевые доли — сформулируй
   это как вопрос пользователю. Сам доли не меняй: пропорции решает пользователь в Google.

Не прогнозируй рынок и не давай советов вне этого плана; если нужен разговор о стратегии —
предложи обсудить его в обычном чате с Claude.`;

// Разрешённые источники для CORS — сайт на GitHub Pages + локальный сервер
// для тестирования (см. serve.ps1 в проекте). Если поменяешь адрес сайта —
// поправь и здесь.
const ALLOWED_ORIGINS = [
  "https://vladslastyon-jpg.github.io",
  "http://localhost:8843",
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    const url = new URL(request.url);
    if (url.pathname !== "/api/rebalance-recommendation" || request.method !== "POST") {
      return json({ error: "not found" }, 404, headers);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "invalid JSON body" }, 400, headers);
    }

    // Все суммы, режимы и коридоры уже посчитаны на сайте — сюда приходит
    // готовый план; модель только разбирает его (см. SYSTEM_PROMPT).
    if (!Array.isArray(body.assets) || !body.portfolio) {
      return json({ error: "ожидается { portfolio, assets[] } — обновите сайт до новой версии вкладки" }, 400, headers);
    }
    const payload = {
      today: body.today || new Date().toISOString().slice(0, 10),
      last_review: body.last_review || null,
      band_rule: body.band_rule || null,
      portfolio: body.portfolio,
      assets: body.assets,
    };

    const userMessage =
      `Текущий план докупок и ребалансировки (JSON):\n\n${JSON.stringify(payload, null, 2)}\n\n` +
      `Сделай квартальный обзор строго по структуре из системного промпта — пройдись по всем активам.`;

    let anthropicResp;
    try {
      anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 1500,
          thinking: { type: "disabled" },
          output_config: { effort: "medium" },
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMessage }],
        }),
      });
    } catch (e) {
      return json({ error: "upstream request to Anthropic API failed" }, 502, headers);
    }

    if (!anthropicResp.ok) {
      const details = await anthropicResp.text();
      return json({ error: `Anthropic API вернул ошибку ${anthropicResp.status}`, details }, 502, headers);
    }

    const data = await anthropicResp.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    const recommendation = textBlock ? textBlock.text : "(пустой ответ от модели)";

    return json({ recommendation, generated_at: new Date().toISOString() }, 200, headers);
  },
};
