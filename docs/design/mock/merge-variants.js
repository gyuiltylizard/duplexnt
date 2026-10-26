(() => {
  const reduce = document.getElementById('mv-reduce');
  const slow = document.getElementById('mv-slow');
  reduce.checked = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let mode = 'ok';
  const render = () => {
    document.body.classList.toggle('mv-reduced', reduce.checked);
    document.querySelectorAll('.mx-opt').forEach((o) =>
      Sort.mount(o.querySelector('.sort'), o.dataset.variant, { mismatch: mode === 'mismatch', still: reduce.checked, k: slow.checked ? 2 : 1 }));
  };
  reduce.onchange = slow.onchange = render;
  document.querySelectorAll('#mx-mode .segment').forEach((b) => (b.onclick = () => {
    mode = b.dataset.mode;
    document.querySelectorAll('#mx-mode .segment').forEach((x) => x.classList.toggle('segment--selected', x === b));
    render();
  }));
  render();
})();
