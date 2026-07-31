// Cloudflare Worker — советующий прокси к Anthropic API для вкладки
// "План докупок" на сайте. Держит ANTHROPIC_API_KEY как Worker Secret —
// ключ никогда не попадает в браузер и не хранится в этом репозитории.
//
// Деплой: см. DEPLOY.md рядом с этим файлом.

const SYSTEM_PROMPT = `Ты — ассистент по инвестиционному плану пользователя. У пользователя долгосрочный (15-30 лет)
портфель с core-частью (CSPX/VOO, S&P 500) и satellite-частью (SOXX/SMH, полупроводники).
Тебе передают: текущие цены активов (asset_prices), живой остаток "план минус факт" по тикеру из
Google-таблицы (plan_deltas — положительное число значит "ещё нужно докупить на эту сумму", ноль
или отсутствие значит "по плану всё в порядке") и таблицу плановых траншей (plan_rows) со статусом
каждого. У каждого транша есть поле side: "buy" (докупка на просадке) или "sell" (продажа —
например, плановое избавление от актива к определённому сроку, без привязки к просадке).

Правила интерпретации:
1. Для side="buy": транш "срабатывает", если текущая цена актива <= его триггер-цены (просадка
   от пика достигнута).
2. Для side="sell": транш "срабатывает", если триггер-цена задана и текущая цена >= неё (рост
   до целевого уровня), ИЛИ если триггер-цена не задана — тогда транш ждёт только дедлайна.
3. Любой транш (buy или sell) также подлежит исполнению, если сегодняшняя дата >= дедлайна, даже
   если триггер по цене не сработал (правило "гибрид с дедлайном": не ждать бесконечно).
4. Если ни триггер, ни дедлайн ещё не наступили — статус "ждать", без ложной срочности.
5. Сумма к покупке/продаже для сработавшего транша: если в транше указано amount_plan (не пусто
   и не 0) — используй его. Иначе бери сумму из plan_deltas по этому активу (это уже посчитанный
   в Google Таблице план минус факт — актуальный остаток "сколько докупить"). Если для актива нет
   ни amount_plan, ни значения в plan_deltas — честно скажи, что сумма не определена, и предложи
   уточнить её у пользователя, не придумывай число сам.
6. Никогда не меняй распределение между активами самостоятельно — только сообщай, что по плану
   пора делать.
7. Если несколько траншей у разных активов "созрели" одновременно — перечисли все, не выбирай
   один за пользователя.
8. Если по активу в plan_deltas есть заметная сумма (нужно докупить или избыток к продаже), но
   в plan_rows для него НЕТ ни одного транша — это значит пользователь ещё не задал точный триггер/
   дедлайн для этого актива. В этом случае не пропускай актив: сам предложи разумный, консервативный
   вариант тайминга (например "докупать частями по мере просадки от текущей цены, ориентир — входить
   траншами при -10%/-20%/-30% от текущего уровня" или "исполнить сейчас одной суммой, если актив и
   так близок к своим средним значениям") — явно помечай это как "ПРЕДЛОЖЕНИЕ" (в отличие от "СДЕЛАТЬ" для
   траншей с уже настроенным и сработавшим триггером), и уточни, что это не финансовая рекомендация,
   а лишь механический вариант тайминга по уже одобренной пользователем сумме докупки.
9. Формат ответа: короткий список конкретных действий вида "КУПИТЬ: <актив>, ~$<сумма> — причина
   (триггер/дедлайн)" или "ПРОДАТЬ: ..." или "ЖДАТЬ: ..." или "ПРЕДЛОЖЕНИЕ: ..." (для п.8). Без лишней
   воды, без общих рассуждений о рынке, если не спросили отдельно.
10. Ты не даёшь финансовых советов сверх исполнения уже согласованного пользователем плана — если
    пользователь спрашивает что-то за пределами плана (менять ли стратегию, покупать ли новый актив),
    явно скажи, что это выходит за рамки этой функции, и предложи обсудить в обычном чате с Claude.`;

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

    const assetPrices = body.asset_prices || {};
    const planDeltas = body.plan_deltas || {};
    const planRows = body.plan_rows || [];
    const today = body.today || new Date().toISOString().slice(0, 10);

    // Считаем детерминированно в коде (не полагаемся на то, что модель сама
    // сверит два списка) — какие активы из plan_deltas НЕ покрыты ни одним
    // траншем в plan_rows. Именно по ним нужно правило 8 (см. системный
    // промпт) — явное "ПРЕДЛОЖЕНИЕ" по тайнингу, а не молчание.
    const coveredAssets = new Set(planRows.map((r) => r.asset));
    const uncoveredAssets = Object.keys(planDeltas).filter((asset) => !coveredAssets.has(asset));

    const userMessage =
      `Текущие данные плана (JSON):\n\n${JSON.stringify({ asset_prices: assetPrices, plan_deltas: planDeltas, plan_rows: planRows, today }, null, 2)}\n\n` +
      (uncoveredAssets.length
        ? `Активы БЕЗ настроенного транша (нет ни одной строки в plan_rows), но с суммой в plan_deltas — ` +
          `по КАЖДОМУ из них обязательно дай отдельный пункт "ПРЕДЛОЖЕНИЕ" по правилу 8, не пропускай ни один: ` +
          `${uncoveredAssets.join(", ")}.\n\n`
        : "") +
      `Дай рекомендацию строго по правилам из системного промпта — пройдись по всем активам из plan_rows И по всем перечисленным выше неохваченным активам.`;

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
          max_tokens: 1000,
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
