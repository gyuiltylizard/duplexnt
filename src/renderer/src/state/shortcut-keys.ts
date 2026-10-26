// Разбор клавиш редактора (вынесено из EditorScreen — ориентир размера R21, B-4).

/** Типы `<input>`, где Ctrl+Z и Delete — текстовые: ленточные сочетания их не перехватывают. */
const NON_TEXT_INPUTS: readonly string[] = ['checkbox', 'radio', 'button', 'submit', 'reset'];

export function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target instanceof HTMLInputElement) {
    return !NON_TEXT_INPUTS.includes(target.type);
  }
  return target instanceof HTMLTextAreaElement || target.isContentEditable;
}

/**
 * Буква сочетания с Ctrl: по `key` для латиницы, иначе по физической клавише — в русской
 * раскладке Ctrl+Z приходит с `key` «я».
 */
export function shortcutLetter(event: globalThis.KeyboardEvent): string {
  const key = event.key.toLowerCase();
  if (/^[a-z]$/u.test(key)) {
    return key;
  }
  return event.code.startsWith('Key') ? event.code.slice(3).toLowerCase() : key;
}
