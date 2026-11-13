/**
 * llm/input.js — подготовка входа агента: сокращение длинных материалов.
 */

/**
 * Задача Б (HANDOFF_v2 §5.1): раньше обрезка входа при превышении maxChars
 * происходила молча — ни в логах, ни в ответе не было следа, что часть
 * материалов не попала к агенту. Теперь факт обрезки логируется всегда.
 *
 * Баг №25 (найден при подготовке этого патча): если поле
 * materials.correspondence или materials.crm_notes отсутствует во входных
 * данных, старый код всё равно делал `undefined + '\n...[сокращено]'`,
 * что в JS даёт строку "undefined\n...[сокращено]" — она подставлялась
 * как БУКВАЛЬНЫЙ контент в промпт агенту. Теперь отсутствующее поле
 * остаётся отсутствующим (не обрезается и не заменяется мусорной строкой).
 *
 * Баг №26 (найден по логам с прода после включения логирования обрезки):
 * materials.dialog_history — вся история сообщений по сделке, склеенная
 * в одну строку в stateMachine.js (`db.getMessages(dealId)`), — росла БЕЗ
 * ОГРАНИЧЕНИЙ и не участвовала в обрезке вообще. На реальной сделке это
 * дало вход в 69137 символов для strategy при том, что correspondence
 * после обрезки был всего 3000 — то есть основную стоимость запроса
 * создавал именно необрезанный dialog_history. Теперь обрезается и он,
 * но с ХВОСТА (оставляем последние maxDialogChars символов, а не первые) —
 * недавняя история сделки обычно важнее самой старой для текущего решения.
 */
function compressInput(inputData, agentName, maxChars = 12000) {
  const str = JSON.stringify(inputData);
  if (str.length <= maxChars) return inputData;

  const MAX_CORRESPONDENCE = 3000;
  const CORRESPONDENCE_HEAD = 1000;
  const MAX_CRM_NOTES = 1000;
  const MAX_DIALOG_HISTORY = 4000;
  // Материалы менеджера: начало (исходная переписка) важнее всего, плюс
  // свежие сообщения в конце.
  const MAX_SOURCE = 8000;
  const SOURCE_HEAD = 5500;

  const originalCorrespondence = inputData.materials?.correspondence;
  const originalCrmNotes = inputData.materials?.crm_notes;
  const originalDialogHistory = inputData.materials?.dialog_history;
  const truncatedFields = [];

  const newMaterials = { ...inputData.materials };

  if (typeof originalCorrespondence === 'string' && originalCorrespondence.length > MAX_CORRESPONDENCE) {
    // Шаг 4 (2026-11-11): раньше оставались первые 3000 символов, и в длинной
    // вставленной переписке терялись самые свежие сообщения клиента (они в
    // конце). Теперь — начало (вводные менеджера) + конец (последние сообщения).
    const head = originalCorrespondence.slice(0, CORRESPONDENCE_HEAD);
    const tail = originalCorrespondence.slice(-(MAX_CORRESPONDENCE - CORRESPONDENCE_HEAD));
    newMaterials.correspondence = head + '\n...[середина сокращена]...\n' + tail;
    truncatedFields.push(`correspondence (${originalCorrespondence.length} → ${MAX_CORRESPONDENCE} симв., начало + конец)`);
  }
  if (typeof originalCrmNotes === 'string' && originalCrmNotes.length > MAX_CRM_NOTES) {
    newMaterials.crm_notes = originalCrmNotes.slice(0, MAX_CRM_NOTES) + '\n...[сокращено]';
    truncatedFields.push(`crm_notes (${originalCrmNotes.length} → ${MAX_CRM_NOTES} симв.)`);
  }
  if (typeof originalDialogHistory === 'string' && originalDialogHistory.length > MAX_DIALOG_HISTORY) {
    // Оставляем хвост (последние сообщения), а не начало — для истории
    // диалога недавний контекст важнее самого раннего.
    newMaterials.dialog_history = '[начало истории сокращено]...\n' + originalDialogHistory.slice(-MAX_DIALOG_HISTORY);
    truncatedFields.push(`dialog_history (${originalDialogHistory.length} → ${MAX_DIALOG_HISTORY} симв., оставлен хвост)`);
  }

  const src = inputData.materials?.source_materials;
  if (src && typeof src.text === 'string' && src.text.length > MAX_SOURCE) {
    newMaterials.source_materials = {
      ...src,
      text: src.text.slice(0, SOURCE_HEAD) + '\n...[середина сокращена]...\n' + src.text.slice(-(MAX_SOURCE - SOURCE_HEAD))
    };
    truncatedFields.push(`source_materials (${src.text.length} → ${MAX_SOURCE} симв., начало + конец)`);
  }

  const result = { ...inputData, materials: newMaterials };
  const resultStr = JSON.stringify(result);

  const dealLabel = inputData?.deal?.client || inputData?.deal?.id || 'unknown_deal';
  if (truncatedFields.length) {
    console.warn(
      `[compressInput] Вход обрезан для агента "${agentName}" (сделка: ${dealLabel}). ` +
      `Было ${str.length} симв., стало ${resultStr.length} симв. Обрезаны поля: ${truncatedFields.join(', ')}.`
    );
  } else {
    // Порог превышен, но обрезать нечего (correspondence/crm_notes короткие
    // или отсутствуют) — значит, размер раздувают другие поля. Раньше это
    // проходило вообще без следа.
    console.warn(
      `[compressInput] Вход агента "${agentName}" (сделка: ${dealLabel}) превышает лимит ` +
      `${maxChars} симв. (факт. ${str.length}), но materials.correspondence/crm_notes обрезать ` +
      `нечего — размер раздувают другие поля входных данных. Вход отправлен БЕЗ обрезки.`
    );
  }

  return truncatedFields.length ? result : inputData;
}

module.exports = { compressInput };
