import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LOCALES, type Locale, type Result } from '@shared';

// Переключатель языка интерфейса (B-41, U6; handoff 2026-11-b41-language). Текстовый
// переключатель, не `Segments`: тише сегментов и не похож на параметр сканирования. Подписи
// опций — каждая на своём языке и не переводятся («Русский» / «English»), у кнопки `lang` её
// языка. Сначала запись, потом смена: выделение едет только со снимком, при отказе откатывать
// нечего. Пока идёт запись — `aria-busy`, щелчки игнорируются и в очередь не встают.

export interface LanguageSwitchProps {
  /** Эффективный язык из снимка — выделение следует за ним, не за кликом. */
  readonly language: Locale;
  /** Запись выбора: общий путь записи настроек. */
  readonly onChange: (locale: Locale) => Promise<Result<void>>;
  /** Запись отказала: вызывающий показывает тост на прежнем языке. */
  readonly onFailed: () => void;
}

export function LanguageSwitch({ language, onChange, onFailed }: LanguageSwitchProps): ReactNode {
  const { t } = useTranslation();
  const [pending, setPending] = useState<Locale | null>(null);
  /** Язык, который только что применился со снимком: после коммита фокус — на его опцию. */
  const [applied, setApplied] = useState<Locale | null>(null);
  const options = useRef(new Map<Locale, HTMLButtonElement>());

  // Снимок принёс новый язык: ожидание снято корректировкой состояния при рендере (react.dev
  // «You Might Not Need an Effect»), а фокус на выбранную опцию возвращается после коммита —
  // DOM перерисовался на новом языке.
  if (pending !== null && pending === language) {
    setPending(null);
    setApplied(language);
  }
  useEffect(() => {
    if (applied !== null) {
      options.current.get(applied)?.focus();
    }
  }, [applied]);

  const select = (locale: Locale): void => {
    if (pending !== null || locale === language) {
      return;
    }
    setPending(locale);
    onChange(locale).then(
      (result) => {
        if (!result.ok) {
          setPending(null);
          onFailed();
        }
      },
      (error: unknown) => {
        console.error('[renderer] язык не отправлен', error);
        setPending(null);
        onFailed();
      },
    );
  };

  return (
    <div
      className="lang-switch"
      role="radiogroup"
      aria-label={t('setup.language.label')}
      aria-busy={pending !== null ? true : undefined}
    >
      <span className="kicker" aria-hidden="true">
        {t('setup.language.kicker')}
      </span>
      <span className="lang-switch__opts">
        {LOCALES.map((locale) => (
          <button
            key={locale}
            ref={(node) => {
              if (node === null) {
                options.current.delete(locale);
              } else {
                options.current.set(locale, node);
              }
            }}
            type="button"
            role="radio"
            lang={locale}
            aria-checked={locale === language}
            className={
              pending === locale ? 'lang-switch__opt lang-switch__opt--pending' : 'lang-switch__opt'
            }
            onClick={() => {
              select(locale);
            }}
          >
            {t(`setup.language.${locale}`)}
          </button>
        ))}
      </span>
    </div>
  );
}
