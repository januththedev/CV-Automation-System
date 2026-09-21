(() => {
  'use strict';
  let token = '';
  let offset = 0;
  let total = 0;
  let busy = false;
  const limit = 50;
  const el = id => document.getElementById(id);
  const clear = () => {
    token = '';
    el('admin-token').value = '';
    el('stats').textContent = '';
    el('providers').textContent = '';
    document.querySelector('#applications tbody').textContent = '';
    el('content-card').hidden = true;
    el('login-card').hidden = false;
  };
  const request = async route => {
    const response = await fetch(route, {
      headers: { Authorization: `Bearer ${token}` },
      mode: 'same-origin', credentials: 'omit', cache: 'no-store', redirect: 'error',
    });
    if (!response.ok) throw new Error('Inspection unavailable');
    return response.json();
  };
  const pair = (parent, label, value) => {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = String(value);
    parent.append(dt, dd);
  };
  async function refresh() {
    if (!token || busy) return;
    busy = true;
    el('error').textContent = 'Loading';
    try {
      const [stats, services, page] = await Promise.all([
        request('/admin/stats'), request('/admin/services'),
        request(`/admin/applications?limit=${limit}&offset=${offset}`),
      ]);
      if (!token) return;
      el('stats').textContent = '';
      pair(el('stats'), 'Total', stats.total);
      pair(el('stats'), 'Last 24 hours', stats.last24h);
      for (const [status, count] of Object.entries(stats.byStatus)) pair(el('stats'), status, count);
      el('providers').textContent = '';
      for (const name of ['whatsapp', 'openrouter', 'onedrive', 'sheets']) {
        pair(el('providers'), name, services.providers[name].configured ? 'Configured' : 'Unconfigured');
      }
      const tbody = document.querySelector('#applications tbody');
      tbody.textContent = '';
      for (const application of page.applications) {
        const tr = document.createElement('tr');
        for (const key of ['id', 'created_at', 'whatsapp_number', 'cv_phone_number', 'status', 'review']) {
          const td = document.createElement('td');
          td.textContent = application[key] === null ? '—' : String(application[key]);
          tr.append(td);
        }
        tbody.append(tr);
      }
      total = page.total;
      el('page').textContent = `${offset + (page.applications.length ? 1 : 0)}–${offset + page.applications.length} of ${total}`;
      el('prev').disabled = offset === 0;
      el('next').disabled = offset + limit >= total || offset + limit > 100000;
      el('login-card').hidden = true;
      el('content-card').hidden = false;
      el('error').textContent = 'Read-only snapshot';
    } catch {
      clear();
      el('login-error').textContent = 'Inspection unavailable. Check the token and local service, then reconnect.';
    } finally { busy = false; }
  }
  el('connect').addEventListener('click', () => {
    token = el('admin-token').value;
    el('admin-token').value = '';
    el('login-error').textContent = '';
    offset = 0;
    void refresh();
  });
  el('refresh').addEventListener('click', () => { void refresh(); });
  el('disconnect').addEventListener('click', clear);
  el('prev').addEventListener('click', () => { if (!busy) { offset = Math.max(0, offset - limit); void refresh(); } });
  el('next').addEventListener('click', () => { if (!busy && offset + limit < total && offset + limit <= 100000) { offset += limit; void refresh(); } });
  window.addEventListener('pagehide', clear);
})();
