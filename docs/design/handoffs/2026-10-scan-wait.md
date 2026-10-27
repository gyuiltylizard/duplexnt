# Handoff — индикатор ожидания первой страницы на `scan`

> **В репозитории (B-9):** реализовано по этому handoff'у — план
> `docs/plans/2026-10-27-003-feat-b-9-scan-wait-plan.md`, журнал
> `docs/solutions/0017-b-9-scan-wait.md`. Отличие одно: ключ строки — `scan.strip.waiting`, а не
> `scan.waitingFirst` (подписи частей экрана в локали вложены: `scan.strip.label`). Затухание
> сделано копией уходящего узла, как у карточки ленты (B-4), а не классом `.scan-wait--gone`.
> Слот растянут на ширину экрана (`align-self: stretch`), у точек `flex: none`: пустая лента
> ширины не даёт, и в слоте нулевой ширины точки сжимались в ноль (поймано смоуком).

Замечание автора от 2026-10-26: пока первая превьюшка не пришла, между блоком подачи и
кнопкой «Остановить» пусто. Туда ставим индикатор ожидания. Автор выбрал вариант **1a — три
точки** на странице вариантов `mock/wait-variants.html`.

## Поведение

- Индикатор стоит на месте ленты `.strip` и виден, только пока в ней нет ни одной страницы.
- Для каждого прохода он свой: на втором проходе и в добавленном наборе ожидание
  показывается заново, пока не придёт первая страница этого прохода.
- Когда приходит первая страница, индикатор гаснет: `opacity 1 → 0`, `--duration-fast`
  (150 мс), `--ease-standard`. В тот же момент карточка появляется в ленте как сейчас
  (B-4, `useStripMotion`), ждать окончания затухания не нужно. После затухания индикатор
  снимается из DOM.
- Счётчик «Отсканировано 0», тег и подача не меняются.
- Если нажать «Остановить» во время ожидания, всё идёт по B-4 (растворение экрана),
  индикатор уходит вместе с экраном.

## Разметка и раскладка

Ленту и индикатор нужно обернуть в общий слот, чтобы высота не менялась и экран не прыгал:

```html
<div class="scan-screen__slot">
  <ul class="strip" aria-label="Последние страницы">
    …
  </ul>
  <div class="scan-wait" role="status" aria-label="Ждём первую страницу">
    <span class="scan-wait__dot"></span><span class="scan-wait__dot"></span
    ><span class="scan-wait__dot"></span>
  </div>
</div>
```

Альтернатива без обёртки: ставить `.scan-wait` вместо `.strip`, но с той же высотой 74 px.

## Стили

```css
.scan-screen__slot {
  position: relative;
  height: 74px;
  display: flex;
  justify-content: center;
}
.scan-wait {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  transition: opacity var(--duration-fast) var(--ease-standard);
}
.scan-wait--gone {
  opacity: 0;
  pointer-events: none;
}
.scan-wait__dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-round);
  background: var(--color-text-faint);
  animation: pulse var(--duration-loop) var(--ease-loop) infinite;
}
.scan-wait__dot:nth-child(2) {
  animation-delay: var(--delay-stagger);
}
.scan-wait__dot:nth-child(3) {
  animation-delay: calc(var(--delay-stagger) * 2);
}

@media (prefers-reduced-motion: reduce) {
  .scan-wait__dot {
    animation: none;
    opacity: var(--opacity-disabled);
  }
}
```

`pulse` берётся из `app.css` (`.35 → 1 → .35`). Новых токенов нет. Точка 6 px сделана
литералом, как и остальная геометрия иллюстраций экрана `scan`.

## Reduced-motion

Цикла нет: три ровные точки с непрозрачностью 55 %. Затухание за 150 мс при появлении
страницы остаётся, по правилу 4 из B-4 (проявление вместо вспышки).

## Доступность

У индикатора `role="status"` с подписью «Ждём первую страницу». Счётчик уже работает как
`aria-live`, поэтому при появлении страницы ничего дополнительно объявлять не нужно.
Ключ строки: `scan.waitingFirst`.

## Приёмка

1. До первой страницы между подачей и «Остановить» видны три пульсирующие точки, экран не
   прыгает ни в момент появления страницы, ни после.
2. Первая страница: точки гаснут за 150 мс, карточка появляется как раньше.
3. Второй проход: точки снова видны до первого оборота.
4. Reduced-motion: точки стоят на месте.
