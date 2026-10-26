(() => {
  const reduceInput = document.getElementById('mv-reduce');
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  reduceInput.checked = mq.matches;
  const syncReduce = () => document.body.classList.toggle('mv-reduced', reduceInput.checked);
  reduceInput.addEventListener('change', syncReduce);
  syncReduce();
  const reduced = () => reduceInput.checked;
  const slowInput = document.getElementById('mv-slow');
  const k = () => (slowInput.checked ? 4 : 1);
  const EASE_OUT = 'cubic-bezier(.2,0,0,1)';

  /* ── 1. Смена экранов ── */
  const SCENES = { setup: 'setup', fronts: 'scan-fronts', flip: 'flip', backs: 'scan-backs', merge: 'merge', editor: 'editor' };
  const FRONT_PAGES = ['01', '03', '05', '07', '09', '11'];
  const BACK_PAGES = ['12', '10', '08', '06', '04', '02'];
  const SHEETS = 6;
  const tpl = {};

  class Flow {
    constructor(frame) {
      this.variant = frame.dataset.variant;
      this.stack = frame.querySelector('.mv-stack');
      this.cur = null;
      this.key = null;
      this.timers = [];
      this.anims = [];
    }
    clearTimers() { this.timers.forEach(clearTimeout); this.timers.forEach(clearInterval); this.timers = []; }
    later(fn, ms) { this.timers.push(setTimeout(fn, ms)); }
    go(key, opts = {}) {
      this.clearTimers();
      const el = document.createElement('div');
      el.className = 'app mv-screen';
      el.innerHTML = tpl[key];
      this.swap(el, this.cur, opts.dir || 'fwd');
      this.cur = el;
      this.key = key;
      this.wire(key, el, opts);
      if (this === flows[0]) document.getElementById('mv-state').textContent = key === 'fronts' ? 'scan · лица' : key === 'backs' ? 'scan · обороты' : key;
    }
    swap(next, prev, dir) {
      this.anims.forEach((a) => a.finish());
      this.anims = [];
      [...this.stack.children].forEach((c) => c !== prev && c.remove());
      this.stack.appendChild(next);
      if (!prev) return;
      const done = () => prev.remove();
      if (reduced()) return done();
      const v = this.variant;
      if (v === 'a') {
        const a = next.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180 * k(), easing: 'ease' });
        a.onfinish = done; this.anims.push(a);
      } else if (v === 'b') {
        const s = dir === 'back' ? -1 : 1;
        const a1 = next.animate([{ opacity: 0, transform: `translateX(${24 * s}px)` }, { opacity: 1, transform: 'none' }], { duration: 220 * k(), easing: EASE_OUT });
        const a2 = prev.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${-24 * s}px)` }], { duration: 160 * k(), easing: EASE_OUT, fill: 'forwards' });
        a2.onfinish = done; this.anims.push(a1, a2);
      } else {
        const a = prev.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90 * k(), easing: 'ease', fill: 'forwards' });
        a.onfinish = done; this.anims.push(a);
        const main = next.querySelector('main');
        const kids = main.classList.contains('editor-screen') ? [...main.querySelectorAll('.editor-screen__toolbar, .rail, .stage, .inspector')] : [...main.children];
        kids.forEach((k, i) => this.anims.push(k.animate(
          [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
          { duration: 180 * k(), delay: (60 + i * 30) * k(), easing: EASE_OUT, fill: 'backwards' })));
      }
    }
    wire(key, el, opts) {
      const q = (s) => el.querySelector(s);
      if (key === 'setup') {
        q('.btn--primary').onclick = () => this.go('fronts', { ret: 'setup' });
        if (auto) this.later(() => this.go('fronts', { ret: 'setup' }), 1100);
      } else if (key === 'fronts' || key === 'backs') {
        const counter = q('.scan-screen__counter');
        const strip = q('.strip');
        strip.innerHTML = '';
        let n = 0;
        const total = key === 'backs' ? ` из ${SHEETS}` : '';
        counter.textContent = `Отсканировано 0${total}`;
        const ret = opts.ret || 'setup';
        q('.btn--secondary').onclick = () => this.stop();
        this.ret = ret;
        const pages = key === 'fronts' ? FRONT_PAGES : BACK_PAGES;
        const tick = setInterval(() => {
          n++;
          counter.textContent = `Отсканировано ${n}${total}`;
          const li = document.createElement('li');
          li.className = 'strip__card';
          li.innerHTML = `<img class="strip__img" alt="Страница ${n}" src="../reference/pages/page-${pages[n - 1]}.jpg">`;
          strip.appendChild(li);
          if (strip.children.length > 5) strip.firstElementChild.remove();
          if (n >= SHEETS) {
            clearInterval(tick);
            this.later(() => key === 'fronts' ? this.go(ret === 'editor' ? 'editor' : 'flip') : this.go('merge'), 520);
          }
        }, 300);
        this.timers.push(tick);
      } else if (key === 'flip') {
        q('.btn--primary').onclick = () => this.go('backs', { ret: 'flip' });
        q('.btn--link').onclick = () => this.go('merge', { short: true });
        if (auto) this.later(() => this.go('backs', { ret: 'flip' }), 1600);
      } else if (key === 'merge') {
        this.later(() => this.go('editor'), opts.short ? 1200 : 1600);
      } else if (key === 'editor') {
        if (this === flows[0]) auto = false;
        q('.editor-screen__add').onclick = () => this.go('fronts', { ret: 'editor' });
        q('.editor-screen__toolbar-left .btn').onclick = () => this.go('setup', { dir: 'back' });
      }
    }
    stop() {
      if (this.key !== 'fronts' && this.key !== 'backs') return;
      this.go(this.ret || 'setup', { dir: 'back' });
    }
  }

  let flows = [];
  let auto = false;

  fetch('../reference/index.html').then((r) => r.text()).then((html) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const [k, id] of Object.entries(SCENES)) {
      tpl[k] = doc.querySelector(`#scene-${id} .app > main`).outerHTML.replaceAll('src="pages/', 'src="../reference/pages/');
    }
    flows = [...document.querySelectorAll('.mv-frame')].map((f) => new Flow(f));
    flows.forEach((f) => f.go('setup'));
  });

  document.getElementById('mv-run').onclick = () => { auto = true; flows.forEach((f) => f.go('setup', { dir: 'back' })); };
  document.getElementById('mv-stop').onclick = () => { auto = false; flows.forEach((f) => f.stop()); };
  document.getElementById('mv-reset').onclick = () => { auto = false; flows.forEach((f) => f.go('setup', { dir: 'back' })); };

  /* ── 2. Поворот ── */
  const PW = 191, PH = 270, LW = 300, LH = 212;
  const SCALE = LW / PH;
  const DUR = { a: 240, b: 200, c: 160 };

  class Rot {
    constructor(root) {
      this.v = root.dataset.variant;
      root.querySelector('.mv-rot__box').appendChild(document.getElementById('mv-rot-tpl').content.cloneNode(true));
      this.paper = root.querySelector('.mv-rot__paper');
      this.img = root.querySelector('.mv-rot__img');
      this.thumb = root.querySelector('.thumb__img');
      this.readout = root.querySelector('.mv-rot__readout');
      this.flip = root.querySelector('[data-flip]');
      this.angle = 0; // накопленный
      root.querySelectorAll('[data-rot]').forEach((b) => (b.onclick = () => this.cmd(+b.dataset.rot)));
      this.flip.onchange = () => this.cmd(this.flip.checked ? 180 : -180);
      this.apply(0, true);
    }
    cmd(delta) { this.angle += delta; this.apply(delta, false); }
    reset() { this.angle = 0; this.flip.checked = false; this.apply(0, true); }
    apply(delta, instant) {
      const mod = ((this.angle % 360) + 360) % 360;
      const land = mod === 90 || mod === 270;
      const s = land ? SCALE : 1;
      const t = land ? 0.7071 : 1;
      const v = this.v;
      const still = instant || reduced() || v === 'c';
      const d = DUR[v] * k();
      const tr = still ? 'none' : `transform ${d}ms ${EASE_OUT}`;
      const shown = this.angle;
      this.thumb.style.objectFit = 'contain';
      this.thumb.style.transition = tr;
      this.thumb.style.transform = `rotate(${shown}deg) scale(${t})`;
      if (v === 'a') {
        this.paper.style.transition = tr;
        this.paper.style.transform = `translate(-50%, -50%) rotate(${shown}deg) scale(${s})`;
      } else {
        this.paper.style.transition = still ? 'none' : `width ${d}ms ${EASE_OUT}, height ${d}ms ${EASE_OUT}`;
        this.paper.style.width = (land ? LW : PW) + 'px';
        this.paper.style.height = (land ? LH : PH) + 'px';
        this.img.style.transition = tr;
        this.img.style.transform = `translate(-50%, -50%) rotate(${shown}deg) scale(${s})`;
      }
      if (v === 'c' && !instant && !reduced() && delta) {
        const off = -Math.sign(delta) * (Math.abs(delta) === 180 ? 14 : 10);
        const nod = (el, base) => {
          el.getAnimations().forEach((a) => a.cancel());
          el.animate([{ opacity: 0.25, transform: `${base} rotate(${off}deg)` }, { opacity: 1, transform: base }], { duration: d, easing: EASE_OUT });
        };
        nod(this.img, `translate(-50%, -50%) rotate(${mod}deg) scale(${s})`);
        nod(this.thumb, `rotate(${mod}deg) scale(${t})`);
      }
      this.readout.textContent = `${mod}°`;
    }
  }

  const rots = [...document.querySelectorAll('.mv-rot')].map((r) => new Rot(r));
  const burst = (delta, n) => { let i = 0; const t = setInterval(() => { rots.forEach((r) => r.cmd(delta)); if (++i >= n) clearInterval(t); }, 110); };
  document.getElementById('mv-burst').onclick = () => burst(90, 4);
  document.getElementById('mv-burst-ccw').onclick = () => burst(-90, 3);
  document.getElementById('mv-rot-reset').onclick = () => rots.forEach((r) => r.reset());
})();
