# Сравнение провайдеров моделей — 14.11.2026 (HANDOFF 0.7, шаг 1)

Цель: заменить Claude API (заблокирован проверкой личности) на провайдера, доступного частному лицу в России.
Решает владелец. Цены — с НДС, по открытым прайсам на октябрь–ноябрь 2026; курс $ ≈ 82,7 ₽ (ЦБ, 12.11.2026).

## Как считали цену сделки

Реальные токены из прогона «Зерно 2» (`docs/eval/2026-11-14_zerno_run2.json`), сделка с ответом клиента
(2 пути + круги editor), без судьи: **≈ 702 тыс. токенов входа + 46 тыс. выхода**. Самый большой вызов —
strategy, **≈ 103 тыс. токенов входа** (модель с контекстом меньше ~128 тыс. без «диеты» не подходит).
Оговорка: у Яндекса и Сбера свой токенизатор, русский текст у них обычно занимает меньше токенов, чем у Claude, —
реальная цена у них может быть ниже. Точную цифру даст прогон.

| Модель (где) | Вход / выход, ₽ за 1 млн | Контекст | ≈ ₽ за сделку | Заметки |
|---|---|---|---|---|
| Claude Sonnet 4.6 (сейчас) | 248 / 1240 | 200 тыс. | ~230 (факт $2,8) | недоступен — проверка личности |
| YandexGPT Pro 5.1 (Yandex AI Studio) | 800 / 800 | 32 тыс. | ~600 | не влезает strategy; дороже Claude |
| Alice AI LLM (Yandex AI Studio) | 500 / 1200 | 128 тыс. | ~410 | в независимом тесте ответы обрывались |
| Qwen3 235B (Yandex AI Studio) | 500 / 500 | уточнить | ~370 | |
| GigaChat 2 Max (Cloud.ru) | 569 / 569 | 131 тыс. | ~430 | |
| **GigaChat 3.5 Reasoning (Cloud.ru)** | 96 / 289 | 262 тыс. | **~80** | данные в РФ; + бесплатный freemium физлицам |
| **DeepSeek V4 Pro (Cloud.ru)** | 183 / 732 | 1 млн | **~160** | сильная открытая модель |
| GLM-5.1 (Cloud.ru) | 199 / 830 | 202 тыс. | ~180 | |

Не подходят: DeepSeek напрямую (оплата в $ иностранной картой), OpenRouter (ушёл из РФ в июне 2026).

## Условия для частного лица

- **GigaChat API (Сбер)**: физлицам — freemium на 12 месяцев, 365 млн токенов (в т.ч. Max 25 млн, Ultra 50 млн),
  один поток. ≈ 0,75 млн на сделку → бесплатно хватает на весь набор из 16 ситуаций несколько раз. Вход — Сбер ID.
  С 1.09.2026 новые клиенты платят через Cloud.ru.
- **Cloud.ru (Evolution Foundation Models)**: один кабинет и **один OpenAI-совместимый API** на 20+ моделей
  (GigaChat, DeepSeek, GLM, Qwen, Kimi). Для физлиц есть акции с бонусами (до 4000 ₽). Нужны ли документы —
  в открытых источниках не нашёл; проверить при регистрации.
- **Yandex AI Studio**: физлицо — Яндекс ID + карта российского банка; паспорт на странице не упоминается
  (есть «установленный порядок верификации»). Стартовый грант после привязки карты, 60 дней. API тоже
  OpenAI-совместимый.

## Что переделать в коде (шаг 2)

`llm/runner.js` сейчас вызывает Anthropic SDK напрямую (`cache_control`, формат ответа, `usage`). Сделать:
`llm/providers/anthropic.js` и `llm/providers/openai_compat.js` (один модуль закрывает Cloud.ru, Yandex,
GigaChat), выбор провайдера и модели — в `llm/registry.js` / env. Кэш у OpenAI-совместимых — автоматический или
нет (не управляем), учёт токенов — `prompt_tokens/completion_tokens`. Агенты, правила, проверки, база — не трогать.
Прогонщик и судья `tests/eval/` — через тот же модуль.

## Второй рычаг — «диета» промптов

80% входа — база знаний (strategy ~103 тыс., diagnostic ~50 тыс. токенов на вызов). Давать агентам только нужные
разделы — цена падает примерно вдвое у любого провайдера, и открывается дорога моделям с меньшим контекстом.

## Рекомендация

Начать с **Cloud.ru**: один аккаунт и один модуль → прогон 16 ситуаций на 2–3 моделях подряд
(**DeepSeek V4 Pro, GigaChat 3.5, GLM-5.1**) и выбор по цифрам судьи (планка 8 из 10). Параллельно бесплатно
проверить GigaChat через freemium. Яндекс — запасной вариант (дороже, у Pro 5.1 мал контекст).
Прогон набора на этих моделях: ≈ 16 × 0,1–0,2 тыс. ₽ ≈ **1,5–3 тыс. ₽ на модель** (против ≈ $35–45 на Claude).

## Источники

- GigaChat, тарифы физлиц: https://developers.sber.ru/docs/ru/gigachat/tariffs/individual-tariffs
- GigaChat, оплата через Cloud.ru с 1.09.2026: https://developers.sber.ru/docs/ru/gigachat/api/integration-legal-entities
- Cloud.ru, каталог и цены: https://cloud.ru/products/evolution-foundation-models , https://cloud.ru/blog/deepseek-api
- Cloud.ru, внешние модели, уход OpenRouter: https://incrussia.ru/news/cloud-ru-otkryl-rossijskomu-biznesu-dostup-k-zarubezhnym-ii-modelyam/
- Cloud.ru, акция для физлиц: https://cdn.cloud.ru/docs/legal/promotions/active/4000-rubles-testing.pdf
- Yandex AI Studio, цены (обзоры прайса, окт.–нояб. 2026): https://akovalev.pro/yandexgpt/ , https://neurounit.ai/blog/yandex-ai-studio-tarify-i-api/ , https://ai-journal.ru/yandexgpt/
- Yandex Cloud, регистрация физлица: https://yandex.cloud/ru/docs/getting-started/individuals/registration
- Качество на русском (независимый бенчмарк задач менеджера): https://mysummit.school/research/benchmark/ , https://habr.com/en/articles/1016648
- Курс ЦБ: https://investfuture.ru/articles/obzor-valyut-2026-11-12
