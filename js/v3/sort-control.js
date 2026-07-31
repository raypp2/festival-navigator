// Sort control (DT-7): chip + popover listbox. The native <select> could
// never render the design's caret (appearance:none on a select paints
// nothing) and read as a static label. This is the app's control-vocabulary
// version: quiet surface, live caret, keyboard parity with the native one —
// Enter/Space/ArrowDown open, arrows move, Enter selects, Esc closes,
// first-letter typeahead. createElement-only (XSS rule).

const OPTIONS = [
  // For you (Discovery M5): rankLineup's ranking — listed first, and the
  // default sort-control.js's caller (app.js) applies whenever the active
  // festival has any enriched artist (genres or sources). Everyone else keeps
  // today's default (billing).
  { value: 'foryou', label: 'For you' },
  { value: 'billing', label: 'Billing' },
  { value: 'az', label: 'A → Z' },
  { value: 'mine', label: 'My picks' },
  { value: 'crew', label: 'Most picked' },  // vocabulary is picked/must/notes/fest — never 'favorites'
];

export function createSortControl({ initial = 'billing', onChange }) {
  let value = initial;
  let open = false;
  let activeIdx = OPTIONS.findIndex((o) => o.value === value);

  const wrap = document.createElement('span');
  wrap.className = 'sort-wrap';

  const chip = document.createElement('button');
  chip.className = 'sort-chip';
  chip.setAttribute('aria-haspopup', 'listbox');
  chip.setAttribute('aria-expanded', 'false');
  chip.setAttribute('aria-label', 'Sort artists');
  const labelSpan = document.createElement('span');
  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.textContent = '▾';
  caret.setAttribute('aria-hidden', 'true');
  chip.append(labelSpan, caret);

  const pop = document.createElement('ul');
  pop.className = 'sort-pop';
  pop.setAttribute('role', 'listbox');
  pop.setAttribute('aria-label', 'Sort artists');
  pop.style.display = 'none';

  const items = OPTIONS.map((opt, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.id = `sort-opt-${opt.value}`;
    const check = document.createElement('span');
    check.className = 'check';
    const text = document.createElement('span');
    text.textContent = opt.label;
    li.append(check, text);
    li.addEventListener('click', () => select(i));
    return li;
  });
  pop.append(...items);

  function paint() {
    labelSpan.textContent = OPTIONS.find((o) => o.value === value).label;
    items.forEach((li, i) => {
      const selected = OPTIONS[i].value === value;
      li.setAttribute('aria-selected', String(selected));
      li.firstChild.textContent = selected ? '✓' : '';
      li.classList.toggle('kb-active', open && i === activeIdx);
    });
    chip.setAttribute('aria-expanded', String(open));
    pop.style.display = open ? '' : 'none';
    if (open) pop.setAttribute('aria-activedescendant', items[activeIdx].id);
  }

  function setOpen(next) {
    open = next;
    if (open) activeIdx = OPTIONS.findIndex((o) => o.value === value);
    paint();
    if (open) {
      // Viewport collision (audit 2.1): the popover is right-anchored by
      // default, but when the chip sits near the LEFT edge (390px wraps the
      // toolbar) that pushes most of the menu off-canvas — and body
      // overflow-x:clip makes it unreachable. Flip to left-anchored when it
      // would spill.
      pop.style.right = '';
      pop.style.left = '';
      const r = pop.getBoundingClientRect();
      if (r.left < 8) { pop.style.right = 'auto'; pop.style.left = '0'; }
    }
  }

  function select(i) {
    const next = OPTIONS[i].value;
    setOpen(false);
    chip.focus();
    if (next !== value) {
      value = next;
      paint();
      onChange(value);
    }
  }

  chip.addEventListener('click', () => setOpen(!open));
  chip.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      // The first arrow press OPENS and highlights the current choice — it
      // must not also advance past it (Codex ship gate, P2).
      if (!open) { setOpen(true); return; }
    }
    if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); }
    if (open && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(activeIdx); return; }
    if (open && e.key === 'ArrowDown') { activeIdx = (activeIdx + 1) % OPTIONS.length; paint(); }
    if (open && e.key === 'ArrowUp') { activeIdx = (activeIdx - 1 + OPTIONS.length) % OPTIONS.length; paint(); }
    if (open && /^[a-z]$/i.test(e.key)) {
      const hit = OPTIONS.findIndex((o) => o.label.toLowerCase().startsWith(e.key.toLowerCase()));
      if (hit >= 0) { activeIdx = hit; paint(); }
    }
  });
  document.addEventListener('click', (e) => { if (open && !wrap.contains(e.target)) setOpen(false); });
  // Tabbing away closes the popover too — a click elsewhere isn't the only
  // way focus leaves (options aren't focusable, so option clicks are safe).
  wrap.addEventListener('focusout', (e) => {
    if (open && !wrap.contains(e.relatedTarget)) setOpen(false);
  });

  wrap.append(chip, pop);
  paint();
  return {
    el: wrap,
    get value() { return value; },
    // Programmatic set, no onChange fired — for app.js's one-time smart
    // default (Discovery M5: "For you" when the festival has enriched data).
    // A user's own later pick through the control still fires onChange as
    // normal; this only ever runs before that, syncing the chip's label to
    // whatever default app.js already applied to ctx.sort.
    setValue(v) {
      if (v === value || !OPTIONS.some((o) => o.value === v)) return;
      value = v;
      paint();
    },
  };
}
