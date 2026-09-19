import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProbeResult } from '@shared';
import './app.css';

type ProbeState =
  | { readonly status: 'pending' }
  | { readonly status: 'ok'; readonly result: ProbeResult }
  | { readonly status: 'failed'; readonly message: string };

const VERSION_KEYS = ['electron', 'chrome', 'node', 'sharp', 'libvips'] as const;
const SHEET_SAMPLES = [1, 2, 5] as const;

// Proof-shell M0 — технический экран, а не экран из UI_SPEC: доказывает, что токены, шрифты,
// локаль и мост живы. Исключение из правила «сначала мок» утверждено автором (план M0, KTD-9).
// В M1 его заменяет экран `setup`.
export function App() {
  const { t } = useTranslation();
  const [probe, setProbe] = useState<ProbeState>({ status: 'pending' });

  useEffect(() => {
    let cancelled = false;

    window.api.probe({ token: 'proof-shell' }).then(
      (result) => {
        if (!cancelled) {
          setProbe({ status: 'ok', result });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setProbe({
            status: 'failed',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="shell">
      <header className="shell__header">
        <h1 className="shell__title">{t('app.title')}</h1>
        <p className="shell__tagline">{t('app.tagline')}</p>
      </header>

      <section className="card" aria-labelledby="probe-heading">
        <h2 id="probe-heading" className="card__heading">
          {t('probe.heading')}
        </h2>

        {probe.status === 'pending' && (
          <p role="status" className="status status--pending">
            {t('probe.pending')}
          </p>
        )}

        {probe.status === 'failed' && (
          <p role="alert" className="status status--failed">
            {t('probe.failed', { message: probe.message })}
          </p>
        )}

        {probe.status === 'ok' && (
          <>
            <p role="status" className="status status--ok">
              {t('probe.ok', { libvips: probe.result.versions.libvips })}
            </p>
            <dl className="versions">
              {VERSION_KEYS.map((key) => (
                <div key={key} className="versions__row">
                  <dt>{t(`versions.${key}`)}</dt>
                  <dd>{probe.result.versions[key] ?? t('versions.unknown')}</dd>
                </div>
              ))}
            </dl>
            <p className="card__note">{t('probe.image', probe.result.image)}</p>
          </>
        )}
      </section>

      <section className="card" aria-labelledby="plurals-heading">
        <h2 id="plurals-heading" className="card__heading">
          {t('plurals.heading')}
        </h2>
        <ul className="samples">
          {SHEET_SAMPLES.map((count) => (
            <li key={count}>{t('sheets', { count })}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
