import { useEffect, useState } from 'react';
import { APP_NAME, type ProbeResult } from '@shared';

type ProbeState =
  | { readonly status: 'pending' }
  | { readonly status: 'ok'; readonly result: ProbeResult }
  | { readonly status: 'failed'; readonly message: string };

// Заглушка каркаса: результат пробы сырым текстом. Proof-shell с токенами, шрифтами и
// строками через t() — U7.
export function App() {
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
    <main>
      <h1>{APP_NAME}</h1>
      <p>Каркас M0</p>
      {probe.status === 'pending' && <p>Проба…</p>}
      {probe.status === 'ok' && <pre>{JSON.stringify(probe.result, null, 2)}</pre>}
      {probe.status === 'failed' && <p role="alert">Проба не прошла: {probe.message}</p>}
    </main>
  );
}
