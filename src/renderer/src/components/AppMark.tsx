import type { ReactNode } from 'react';

// Монограмма D’ приложения (handoff `app-icon.md`, B-7) для подвала инспектора (B-45): геометрия
// и цвета — мастер `build/icon-small.svg` (вариант для мелких размеров, без блика и с толстым
// штрихом), без его c2pa-метаданных. Цвета — цвета значка, а не токены темы: плитка одна и та
// же в панели задач и в интерфейсе. Размер задаёт CSS (`--size-beta`); декоративна.

export function AppMark({ className }: { readonly className?: string }): ReactNode {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="62" height="62" rx="10" fill="#1c1a16" />
      <path
        fill="#fbfaf7"
        fillRule="evenodd"
        d="M10 14H22a18 18 0 0 1 0 36H10Z M19 23H22a9 9 0 0 1 0 18H19Z"
      />
      <rect x="44" y="14" width="8" height="16" rx="4" fill="#a06a2a" />
    </svg>
  );
}
