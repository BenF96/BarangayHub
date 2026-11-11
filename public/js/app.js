// Sidebar / hamburger behaviour
(function () {
  const body = document.body;
  const toggle = document.getElementById('menu-toggle');
  const backdrop = document.getElementById('sidebar-backdrop');
  const mobile = () => window.matchMedia('(max-width: 900px)').matches;

  // Remember collapsed state on desktop
  try { if (localStorage.getItem('sidebar-collapsed') === '1') body.classList.add('sidebar-collapsed'); } catch {}

  function setExpanded() {
    const open = mobile() ? body.classList.contains('sidebar-open') : !body.classList.contains('sidebar-collapsed');
    toggle.setAttribute('aria-expanded', String(open));
  }

  toggle.addEventListener('click', () => {
    if (mobile()) {
      body.classList.toggle('sidebar-open');
    } else {
      body.classList.toggle('sidebar-collapsed');
      try { localStorage.setItem('sidebar-collapsed', body.classList.contains('sidebar-collapsed') ? '1' : '0'); } catch {}
      // Content width changed: let tables re-check whether they fit once the drawer has animated
      setTimeout(() => window.dispatchEvent(new Event('resize')), 260);
    }
    setExpanded();
  });

  backdrop.addEventListener('click', () => { body.classList.remove('sidebar-open'); setExpanded(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && body.classList.contains('sidebar-open')) { body.classList.remove('sidebar-open'); setExpanded(); }
  });
  window.addEventListener('resize', () => { if (!mobile()) body.classList.remove('sidebar-open'); setExpanded(); });
  setExpanded();

  // Tables: give every cell the label of its column, then stack a table into cards when it doesn't fit its card
  // (always on phones). Re-checked when the window is resized or the phone is rotated.
  const tables = [...document.querySelectorAll('.table-wrap table')].filter((table) => {
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    if (!heads.length) return false;
    table.classList.add('rtable');
    table.querySelectorAll('tbody tr, tfoot tr').forEach((tr) => {
      let col = 0;
      [...tr.children].forEach((cell) => {
        if (!cell.hasAttribute('data-label')) cell.setAttribute('data-label', heads[col] || '');
        col += cell.colSpan || 1;
      });
    });
    return true;
  });
  const fitTables = () => {
    const phone = window.matchMedia('(max-width: 700px)').matches;
    tables.forEach((t) => {
      t.classList.remove('stack');
      if (phone || t.scrollWidth > t.parentElement.clientWidth + 1) t.classList.add('stack');
    });
  };
  let fitTimer;
  window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitTables, 120); });
  fitTables();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitTables); // widths change once Roboto loads

  // Reservation form: live rent estimate and stock availability for the chosen dates
  const form = document.getElementById('reservation-form');
  if (form) {
    const $ = (id) => document.getElementById(id);
    const php = (n) => '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2 });
    const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

    const read = () => {
      const opt = form.equipment.selectedOptions[0];
      const s = form.startDate.value, e = form.endDate.value;
      const days = s && e && e >= s ? Math.round((new Date(e) - new Date(s)) / 86400000) + 1 : 0;
      return { opt, id: opt && opt.value, fee: Number((opt && opt.dataset.fee) || 0), qty: Number(form.quantity.value || 0), s, e, days };
    };

    const estimate = () => {
      const v = read();
      const hint = $('stock-hint');
      if (hint) hint.textContent = v.id ? `The barangay owns ${v.opt.dataset.qty}.` : '';
      $('est-rate').textContent = v.id ? (v.fee ? php(v.fee) : 'Free') : '—';
      $('est-units').textContent = v.qty || '—';
      $('est-days').textContent = v.days || (v.s && v.e ? 'check dates' : '—');
      $('fee-estimate').textContent = v.id && v.qty && v.days ? (v.fee ? php(v.fee * v.qty * v.days) : 'Free') : '—';
    };

    let timer, seq = 0;
    const availability = () => {
      const v = read();
      const box = $('avail-body');
      if (!v.id || !v.s || !v.e) { box.replaceChildren(el('p', 'empty', 'Choose an item and both dates.')); return; }
      const my = ++seq;
      const qs = new URLSearchParams({ equipment: v.id, start: v.s, end: v.e, exclude: form.dataset.exclude || '' });
      fetch('/reservations/availability?' + qs, { headers: { accept: 'application/json' } })
        .then((r) => r.json())
        .then((d) => {
          if (my !== seq) return; // a newer request is on its way
          if (d.error) { box.replaceChildren(el('p', 'empty', d.error)); return; }
          const enough = v.qty <= d.free;
          const state = el('div', 'avail-state ' + (d.free === 0 ? 'avail-none' : enough ? 'avail-ok' : 'avail-low'));
          state.append(el('span', 'big', String(d.free)), el('span', null, `of ${d.owned} free for ${d.days} day${d.days > 1 ? 's' : ''}` + (v.qty ? (enough ? ` — enough for ${v.qty}.` : ` — not enough for ${v.qty}.`) : '')));
          const table = el('table', 'money');
          const tb = el('tbody');
          const row = (a, b, cls) => { const tr = el('tr', cls); tr.append(el('td', null, a), el('td', 'num', b)); tb.append(tr); };
          row('Item', d.name);
          row('Condition', d.condition);
          row('Units owned', String(d.owned));
          row('Booked by others (peak)', String(d.booked));
          row('This request', v.qty ? String(v.qty) : '—', 'sum');
          table.append(tb);
          const parts = [state, table];
          if (d.condition === 'Needs Repair') parts.push(el('div', 'panel-foot red', 'This item is marked as needing repair.'));
          if (d.bookings.length) {
            parts.push(el('div', 'panel-foot', 'Overlapping bookings:'));
            const ul = el('ul', 'log');
            d.bookings.forEach((b) => {
              const li = el('li');
              const a = el('a', null, b.refNo); a.href = '/reservations/' + b.id;
              li.append(a, document.createTextNode(` · ${b.borrower} · ${b.units} unit${b.units > 1 ? 's' : ''} · ${b.status}`), el('time', null, `${b.start} – ${b.end}`));
              ul.append(li);
            });
            parts.push(ul);
          }
          box.replaceChildren(...parts);
        })
        .catch(() => { if (my === seq) box.replaceChildren(el('p', 'empty', 'Could not check availability. It will still be checked when you save.')); });
    };

    const onChange = () => { estimate(); clearTimeout(timer); timer = setTimeout(availability, 250); };
    form.addEventListener('input', onChange);
    form.addEventListener('change', onChange);
    estimate();
    availability();
  }

  // Print borrowing slip
  document.querySelectorAll('[data-print]').forEach((b) => b.addEventListener('click', () => window.print()));

  // "Are you sure?" for forms marked with data-confirm (deletes, release with unpaid rent, cancel after paying)
  document.addEventListener('submit', (e) => {
    const msg = e.target.getAttribute && e.target.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });
})();
