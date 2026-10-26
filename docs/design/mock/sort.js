/* Иллюстрация «сортировки» (B-5). Варианты описаны как раскадровки: у каждого листа — ключевые
   кадры {x, y, o, z, s} во времени цикла. Это то же, что @keyframes в CSS: handoff переносит
   раскадровку выбранного варианта в keyframes один к одному. */
(() => {
  const EASE = 'cubic-bezier(.45,0,.55,1)'; // ≈ --ease-loop (ease-in-out)

  function track(loop, init) {
    const kf = [[0, { s: 1, o: 1, ...init }]];
    let cur = kf[0][1];
    const api = {
      hold(t) { kf.push([t, { ...cur }]); return api; },
      to(t, p) { cur = { ...cur, ...p }; kf.push([t, { ...cur }]); return api; },
      set(t, p) { return api.hold(t).to(t + 1, p); },
      arc(t, dur, p, lift = 14) {
        api.hold(t);
        const mid = { x: (cur.x + p.x) / 2, y: Math.min(cur.y, p.y ?? cur.y) - lift };
        return api.to(t + dur / 2, mid).to(t + dur, p);
      },
      done() { kf.push([loop, { ...kf[0][1] }]); return kf; },
    };
    return api;
  }

  const V = {};

  /* 1a — две стопки сливаются */
  V.a = (mis) => {
    const loop = 3800, w = 64, h = 84, els = [];
    for (let i = 0; i < 3; i++) {
      const p = { x: 20 + i * 3, y: 40 + i * 3, z: 10 - i };
      const ts = 250 + i * 800;
      const d = mis ? { x: 92, y: 64 + i * 5 } : { x: 128, y: 62 + 2 * i * 4 };
      els.push({ kind: 'front', w, h, kf: track(loop, p).set(ts, { z: 20 + 2 * i }).arc(ts + 1, 450, d).hold(2900).to(3300, { y: d.y + 44, o: 0 }).set(3300, { ...p, o: 0 }).to(3700, { o: 1 }).done() });
    }
    for (let i = 0; i < 3; i++) {
      const p = { x: 236 - i * 3, y: 40 + i * 3, z: 10 - i };
      if (mis && i === 2) { els.push({ kind: 'back', w, h, kf: track(loop, { ...p, o: 0 }).done() }); continue; }
      const ts = 650 + i * 800;
      const d = mis ? { x: 164, y: 64 + i * 5 } : { x: 128, y: 62 + (2 * i + 1) * 4 };
      els.push({ kind: 'back', w, h, kf: track(loop, p).set(ts, { z: 21 + 2 * i }).arc(ts + 1, 450, d).hold(2900).to(3300, { y: d.y + 44, o: 0 }).set(3300, { ...p, o: 0 }).to(3700, { o: 1 }).done() });
    }
    return { loop, els, still: 2850 };
  };

  /* 1b — пары. mode: ok · short (оборотов меньше) · extra (оборотов больше) · fronts (обороты не нужны) */
  V.b = (mode) => {
    const loop = 3800, w = 48, h = 64, els = [];
    const m = mode === true ? 'short' : mode || 'ok';
    const paired = m === 'ok';
    const slot = (j) => ({ x: 74 + j * 62, y: 40 });
    const gatherY = (lvl) => 72 + lvl * 5;
    const fronts = m === 'extra' ? 2 : 3;
    const backs = m === 'fronts' ? 0 : m === 'short' ? 2 : 3;
    const pileF = (i) => ({ x: 14 + i * 3, y: 52 + i * 3, z: 10 - i });
    const pileB = (i) => ({ x: 258 - i * 3, y: 52 + i * 3, z: 10 - i });
    // в паре оборот ложится за лицо и выглядывает из-под него
    const backAt = (j) => ({ x: slot(j).x + 8, y: 48 });
    const ghost = (pos, z) => els.push({ kind: 'ghost', name: 'ghost', w, h, kf: track(loop, { ...pos, z, o: 0 }).hold(2050).to(2300, { o: 1 }).hold(3000).to(3350, { o: 0 }).done() });
    const finish = (t, p, lvl) => {
      if (m === 'fronts') t.set(2350, { z: 40 + lvl }).to(2800, { x: 136, y: gatherY(lvl) }).hold(3000).to(3350, { y: gatherY(lvl) + 40, o: 0 });
      else if (paired) t.set(2350, { z: 40 + lvl }).to(2800, { x: 136, y: gatherY(lvl) }).hold(3000).to(3350, { y: gatherY(lvl) + 40, o: 0 });
      else t.hold(3000).to(3350, { o: 0 }); // не сошлось: пары в стопку не собираются
      return t.set(3350, { ...p, o: 0 }).to(3750, { o: 1 }).done();
    };
    for (let i = 0; i < 3; i++) {
      const p = pileF(i);
      if (i >= fronts) { els.push({ kind: 'front', name: `f${i + 1}`, w, h, kf: track(loop, { ...p, o: 0 }).done() }); ghost({ ...slot(i), z: 0 }, 29); continue; }
      const ts = 150 + i * 330;
      const lvl = m === 'fronts' ? i : 2 * i;
      els.push({ kind: 'front', name: `f${i + 1}`, w, h, kf: finish(track(loop, p).set(ts, { z: 30 + i }).arc(ts + 1, 400, slot(i)), p, lvl) });
    }
    for (let i = 0; i < 3; i++) {
      const p = pileB(i);
      if (m === 'fronts') continue;
      if (i >= backs) { els.push({ kind: 'back', name: `b${i + 1}`, w, h, kf: track(loop, { ...p, o: 0 }).done() }); ghost(backAt(i), 19); continue; }
      const ts = 1200 + i * 330;
      els.push({ kind: 'back', name: `b${i + 1}`, w, h, kf: finish(track(loop, p).set(ts, { z: 20 + i }).arc(ts + 1, 400, backAt(i)), p, 2 * i + 1) });
    }
    return { loop, els, still: 2300, tray: false };
  };

  /* 1c — две половины */
  V.c = (mis) => {
    const loop = 1200, w = 36, h = 96, y = 40;
    const lx = mis ? 118 : 124, rx = mis ? 166 : 160;
    const half = (kind, x0, x1) => ({ kind, w, h, kf: track(loop, { x: x0, y, o: 0, z: 10 }).to(420, { x: x1, o: 1 }).hold(620).to(1000, { y: y + 56, o: 0 }).done() });
    return { loop, els: [half('front half-l', lx - 48, lx), half('back half-r', rx + 48, rx)], still: 600 };
  };

  function frames(kf, loop) {
    return kf.map(([t, p]) => ({
      offset: Math.min(1, t / loop),
      transform: `translate(${p.x}px, ${p.y}px) scale(${p.s})`,
      opacity: p.o,
      zIndex: p.z,
      easing: EASE,
    }));
  }

  function mount(host, variant, { mode = 'ok', mismatch = false, still = false, k = 1 } = {}) {
    host.innerHTML = '';
    host.classList.toggle('sort--still', still);
    const def = V[variant](variant === 'b' ? (mismatch ? 'short' : mode) : mismatch || mode !== 'ok');
    const anims = def.els.map((e) => {
      const el = document.createElement('span');
      el.className = e.kind.split(' ').map((c) => `sort__sheet sort__sheet--${c}`).join(' ');
      el.style.width = e.w + 'px';
      el.style.height = e.h + 'px';
      el.innerHTML = '<span class="sort__line"></span><span class="sort__line"></span><span class="sort__line"></span>';
      host.appendChild(el);
      const a = el.animate(frames(e.kf, def.loop), { duration: def.loop * k, iterations: Infinity });
      if (still) { a.pause(); a.currentTime = def.still * k; }
      return a;
    });
    if (def.tray !== false) host.insertAdjacentHTML('beforeend', '<span class="sort__tray"><span class="sort__bar"></span></span>');
    return { anims, loop: def.loop };
  }

  window.Sort = { mount, storyboard: (v, m) => V[v](m) };
})();
