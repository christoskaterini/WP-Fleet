const state = {
  me: null,
  sites: [],
  activeTab: 'sites',
  matrixType: 'plugin',
  matrixItems: [],
  drawerDomain: null,
  drawerAssets: [],
  deployTarget: null,
  sse: null,
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

async function api(url, opts = {}) {
  const hasJsonBody = opts.body !== undefined && !(opts.body instanceof FormData);
  const res = await fetch(url, {
    headers: hasJsonBody ? { 'Content-Type': 'application/json' } : {},
    ...opts,
    body:
      hasJsonBody && typeof opts.body !== 'string'
        ? JSON.stringify(opts.body)
        : opts.body,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('Unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function showLogin() {
  $('#login-view').classList.remove('hidden');
  $('#app-view').classList.add('hidden');
  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }
}

function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toast-wrap').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function showApp(me) {
  state.me = me;
  const isAdmin = me?.role === 'admin';
  document.querySelectorAll('[data-admin-only="1"]').forEach((el) => {
    el.classList.toggle('hidden', !isAdmin);
  });
  $('#user-pill').textContent = isAdmin
    ? `${me.user} (Admin) ▾`
    : `${me.user} (${me.hestiaUser}) ▾`;
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  connectSSE();
  loadSites();
  loadVersionBadge();
}

async function loadVersionBadge() {
  try {
    const v = await api('/api/system/version');
    const el = $('#version-badge');
    if (v.updateAvailable) {
      el.textContent = `v${v.current} → Update v${v.latest}`;
      el.className = 'badge badge-warn';
      el.style.cursor = 'pointer';
      el.onclick = async () => {
        if (!confirm(`Update WP Fleet from v${v.current} to v${v.latest} and restart?`)) return;
        try {
          await api('/api/system/update', { method: 'POST' });
          toast('Updating & restarting...');
          setTimeout(() => location.reload(), 3500);
        } catch (err) {
          toast(err.message, 'error');
        }
      };
    } else {
      el.textContent = `v${v.current}`;
      el.className = 'badge';
      el.style.cursor = 'default';
      el.onclick = null;
    }
  } catch {
    // ignore
  }
}

async function boot() {
  try {
    const me = await api('/api/auth/me');
    showApp(me);
  } catch {
    showLogin();
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').classList.add('hidden');
  try {
    await api('/api/auth/login', {
      method: 'POST',
      body: {
        username: $('#login-user').value.trim(),
        password: $('#login-pass').value,
      },
    });
    const me = await api('/api/auth/me');
    showApp(me);
  } catch (err) {
    $('#login-error').textContent = err.message;
    $('#login-error').classList.remove('hidden');
  }
});

$('#btn-logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  showLogin();
});

// --- Tabs ---
document.querySelectorAll('.nav-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.activeTab = btn.dataset.tab;
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
    $(`#tab-${state.activeTab}`).classList.remove('hidden');

    if (state.activeTab === 'matrix') loadMatrix();
    if (state.activeTab === 'vault') loadVault();
    if (state.activeTab === 'blueprints') loadBlueprints();
    if (state.activeTab === 'users') loadFleetUsers();
    if (state.activeTab === 'audit') loadAudit();
  });
});

// --- Sites ---
async function loadSites() {
  const { sites } = await api('/api/sites');
  state.sites = sites;
  renderSites();
}

function renderSites() {
  const q = $('#sites-filter').value.trim().toLowerCase();
  const filtered = state.sites.filter(
    (s) => s.domain.toLowerCase().includes(q) || s.user.toLowerCase().includes(q)
  );

  const totalUpdates = state.sites.reduce(
    (acc, s) => acc + (s.plugin_updates || 0) + (s.theme_updates || 0) + (s.wp_update_version ? 1 : 0),
    0
  );
  $('#sites-stats').innerHTML = `
    <div class="stat-pill"><strong>${state.sites.length}</strong> Sites</div>
    <div class="stat-pill"><strong>${totalUpdates}</strong> Pending Updates</div>
  `;

  $('#sites-tbody').innerHTML =
    filtered.length === 0
      ? `<tr><td colspan="8" class="muted">${
          state.sites.length === 0
            ? 'No sites indexed yet. Click "Refresh Scan" above to discover WordPress sites.'
            : 'No matching sites.'
        }</td></tr>`
      : filtered
          .map((s) => {
      const updTotal = (s.plugin_updates || 0) + (s.theme_updates || 0);
      let healthHtml = '<span class="muted">Not checked</span>';
      if (s.http_status !== null && s.http_status !== undefined) {
        if (s.http_status >= 200 && s.http_status < 400) {
          healthHtml = `<span class="badge badge-ok">${s.http_status} OK</span> <span class="muted">${s.ttfb_ms} ms</span>`;
        } else {
          healthHtml = `<span class="badge badge-err">${esc(s.health_error || `HTTP ${s.http_status}`)}</span>`;
        }
      }

      const wpCoreHtml = s.wp_update_version
        ? `${esc(s.wp_version)} <button class="btn btn-primary btn-xs" onclick="updateCore('${esc(s.domain)}')">→ ${esc(s.wp_update_version)}</button>`
        : esc(s.wp_version || '—');

      const updBadge =
        updTotal > 0
          ? `<span class="badge badge-warn">${updTotal} updates</span>`
          : `<span class="badge badge-ok">Up to date</span>`;

      return `
        <tr>
          <td>
            <strong>${esc(s.domain)}</strong> ${s.staging_of ? `<span class="badge badge-warn">Staging</span>` : ''}
            <div><a class="muted" href="${esc(s.site_url)}" target="_blank" rel="noopener">Visit Site ↗</a></div>
          </td>
          <td><span class="badge badge-brand">${esc(s.user)}</span></td>
          <td>${esc(s.php_version || '—')}</td>
          <td>${wpCoreHtml}</td>
          <td>${esc(s.active_theme || '—')}</td>
          <td>${updBadge}</td>
          <td>${healthHtml}</td>
          <td class="text-right">
            <div class="btn-group" style="justify-content:flex-end">
              <button class="btn btn-primary btn-xs" onclick="openDrawer('${esc(s.domain)}')">Manage</button>
              <button class="btn btn-secondary btn-xs" onclick="magicLogin('${esc(s.domain)}')">Magic Login ↗</button>
              <button class="btn btn-secondary btn-xs" onclick="flushCache('${esc(s.domain)}')">Flush Cache</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

$('#sites-filter').addEventListener('input', renderSites);

$('#btn-scan').addEventListener('click', async () => {
  try {
    $('#btn-scan').disabled = true;
    $('#btn-scan').textContent = 'Scanning…';
    $('#scan-banner-text').textContent = 'Discovering WordPress sites...';
    $('#scan-banner').classList.remove('hidden');
    await api('/api/sites/scan', { method: 'POST' });
    openTerminal();
  } catch (err) {
    $('#btn-scan').disabled = false;
    $('#btn-scan').textContent = 'Refresh Scan';
    $('#scan-banner').classList.add('hidden');
    toast(err.message, 'error');
  }
});

$('#btn-health-all').addEventListener('click', async () => {
  try {
    toast('Checking health for all sites...');
    await api('/api/sites/health-all', { method: 'POST' });
    await loadSites();
    toast('Health checks complete');
  } catch (err) {
    toast(err.message, 'error');
  }
});

window.updateCore = async (domain) => {
  try {
    await api(`/api/sites/${encodeURIComponent(domain)}/update`, {
      method: 'POST',
      body: { target: 'core' },
    });
    toast(`Core update queued for ${domain}`);
    openTerminal();
  } catch (err) {
    toast(err.message, 'error');
  }
};

window.flushCache = async (domain) => {
  try {
    await api(`/api/sites/${encodeURIComponent(domain)}/cache-flush`, { method: 'POST' });
    toast(`Cache flush queued for ${domain}`);
    openTerminal();
  } catch (err) {
    toast(err.message, 'error');
  }
};

window.magicLogin = async (domain, userId = '') => {
  try {
    const { url } = await api(`/api/sites/${encodeURIComponent(domain)}/magic-login`, {
      method: 'POST',
      body: userId ? { userId: String(userId) } : {},
    });
    window.open(url, '_blank', 'noopener');
  } catch (err) {
    toast(`Magic Login failed: ${err.message}`, 'error');
  }
};

// --- Site Drawer ---
window.openDrawer = async (domain) => {
  state.drawerDomain = domain;
  $('#site-drawer').classList.remove('hidden');
  $('#drawer-domain').textContent = domain;
  $('#debug-log-box').classList.add('hidden');
  $('#db-viewer-panel').classList.add('hidden');
  $('#wporg-plugin-results').classList.add('hidden');
  $('#wporg-theme-results').classList.add('hidden');
  document.querySelectorAll('.dtab').forEach((b) => b.classList.toggle('active', b.dataset.dtab === 'overview'));
  document.querySelectorAll('.dtab-panel').forEach((p) => p.classList.toggle('hidden', p.id !== 'dtab-overview'));
  await loadDrawerData();
};

async function loadDrawerData() {
  if (!state.drawerDomain) return;
  const [{ site, assets }, info] = await Promise.all([
    api(`/api/sites/${encodeURIComponent(state.drawerDomain)}/assets`),
    api(`/api/sites/${encodeURIComponent(state.drawerDomain)}/info`),
  ]);
  state.drawerAssets = assets;
  $('#drawer-meta').textContent = `User: ${site.user} · WP ${site.wp_version || '?'} · PHP ${site.php_version || '?'}`;

  // Overview: Iframe, URL/Path, DB Details
  const siteUrl = info.homeUrl || site.site_url;
  $('#site-preview-frame').src = siteUrl;
  $('#link-open-site').href = siteUrl;
  $('#info-site-url').value = siteUrl;
  $('#info-site-path').value = site.path;
  $('#info-site-path').readOnly = state.me?.role !== 'admin';
  $('#info-search-replace').checked = false;

  const db = info.db || {};
  const passRow =
    state.me?.role === 'admin'
      ? `<div class="db-detail-row">
      <span class="muted">Password</span>
      <span>
        <code id="db-pass-val" data-pass="${esc(db.password || '')}">••••••••</code>
        <button type="button" class="btn btn-ghost btn-xs" onclick="const el=$('#db-pass-val');el.textContent=el.textContent==='••••••••'?el.dataset.pass:'••••••••'">Show</button>
      </span>
    </div>`
      : '';
  $('#info-db-details').innerHTML = `
    <div class="db-detail-row"><span class="muted">Database</span><strong>${esc(db.name || '—')}</strong></div>
    <div class="db-detail-row"><span class="muted">DB User</span><strong>${esc(db.user || '—')}</strong></div>
    <div class="db-detail-row"><span class="muted">DB Host</span><strong>${esc(db.host || '—')}</strong></div>
    <div class="db-detail-row"><span class="muted">Table Prefix</span><strong>${esc(db.prefix || 'wp_')}</strong></div>
    ${passRow}
  `;

  // Color existing toggle buttons according to current state
  const setToggleState = (onAct, offAct, isOn) => {
    const onBtn = document.querySelector(`[data-toggle="${onAct}"]`);
    const offBtn = document.querySelector(`[data-toggle="${offAct}"]`);
    if (onBtn) onBtn.className = `btn btn-sm ${isOn ? 'btn-primary' : 'btn-secondary'}`;
    if (offBtn) offBtn.className = `btn btn-sm ${!isOn ? 'btn-primary' : 'btn-secondary'}`;
  };
  setToggleState('debug-on', 'debug-off', info.wpDebug);
  setToggleState('maintenance-on', 'maintenance-off', info.maintenance);

  // Staging view
  if (site.staging_of) {
    $('#staging-live-view').classList.add('hidden');
    $('#staging-child-view').classList.remove('hidden');
    $('#staging-parent-domain').textContent = site.staging_of;
  } else {
    $('#staging-child-view').classList.add('hidden');
    $('#staging-live-view').classList.remove('hidden');
    $('#staging-domain-input').value = `staging.${site.domain}`;
    const stg = info.stagingSites || [];
    $('#staging-list-tbody').innerHTML =
      stg.length === 0
        ? '<tr><td colspan="3" class="muted">No staging copies yet.</td></tr>'
        : stg
            .map(
              (s) => `
            <tr>
              <td><strong>${esc(s.domain)}</strong></td>
              <td><a href="${esc(s.site_url)}" target="_blank" rel="noopener">${esc(s.site_url)} ↗</a></td>
              <td class="text-right">
                <button class="btn btn-secondary btn-xs" onclick="openDrawer('${esc(s.domain)}')">Manage</button>
              </td>
            </tr>`
            )
            .join('');
  }

  renderDrawerAssets();
  loadSnapshots();
  loadWpUsers();
}

// --- Site WP Users ---
async function loadWpUsers() {
  if (!state.drawerDomain) return;
  try {
    const { users } = await api(`/api/sites/${encodeURIComponent(state.drawerDomain)}/wp-users`);
    $('#drawer-wpusers-tbody').innerHTML = users
      .map(
        (u) => `
        <tr>
          <td>${esc(u.ID)}</td>
          <td><strong>${esc(u.user_login)}</strong></td>
          <td class="muted">${esc(u.user_email)}</td>
          <td><span class="badge">${esc(u.roles)}</span></td>
          <td class="text-right">
            <div class="btn-group" style="justify-content:flex-end">
              <button class="btn btn-secondary btn-xs" onclick="magicLogin('${esc(state.drawerDomain)}','${esc(u.ID)}')">Login ↗</button>
              <button class="btn btn-secondary btn-xs" onclick="resetWpUserPass('${esc(u.ID)}')">Reset Pass</button>
              <button class="btn btn-danger btn-xs" onclick="deleteWpUser('${esc(u.ID)}','${esc(u.user_login)}')">Delete</button>
            </div>
          </td>
        </tr>`
      )
      .join('');
  } catch (err) {
    $('#drawer-wpusers-tbody').innerHTML = `<tr><td colspan="5" class="muted">${esc(err.message)}</td></tr>`;
  }
}

$('#wp-user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api(`/api/sites/${encodeURIComponent(state.drawerDomain)}/wp-users`, {
      method: 'POST',
      body: {
        login: $('#wpu-login').value.trim(),
        email: $('#wpu-email').value.trim(),
        password: $('#wpu-pass').value,
        role: $('#wpu-role').value,
      },
    });
    $('#wpu-login').value = '';
    $('#wpu-email').value = '';
    $('#wpu-pass').value = '';
    toast('WordPress user created');
    loadWpUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
});

window.resetWpUserPass = async (id) => {
  const pw = prompt('Enter new password for this WordPress user:');
  if (!pw) return;
  try {
    await api(`/api/sites/${encodeURIComponent(state.drawerDomain)}/wp-users/${id}`, {
      method: 'PATCH',
      body: { password: pw },
    });
    toast('WordPress user password updated');
  } catch (err) {
    toast(err.message, 'error');
  }
};

window.deleteWpUser = async (id, login) => {
  if (!confirm(`Delete WordPress user "${login}"?`)) return;
  try {
    await api(`/api/sites/${encodeURIComponent(state.drawerDomain)}/wp-users/${id}`, {
      method: 'DELETE',
    });
    toast('WordPress user deleted');
    loadWpUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
};

$('#btn-reload-iframe').addEventListener('click', () => {
  const f = $('#site-preview-frame');
  f.src = f.src;
});

$('#site-settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api(`/api/sites/${encodeURIComponent(state.drawerDomain)}/update-settings`, {
      method: 'POST',
      body: {
        siteUrl: $('#info-site-url').value.trim(),
        sitePath: $('#info-site-path').value.trim(),
        runSearchReplace: $('#info-search-replace').checked,
      },
    });
    toast('URL / Path update queued');
    openTerminal();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#btn-view-db').addEventListener('click', async () => {
  const panel = $('#db-viewer-panel');
  panel.classList.remove('hidden');
  $('#db-tables-list').innerHTML = '<div class="muted" style="padding:8px">Loading tables...</div>';
  try {
    const { tables } = await api(`/api/sites/${encodeURIComponent(state.drawerDomain)}/db/tables`);
    $('#db-tables-list').innerHTML = tables
      .map(
        (t) =>
          `<button class="db-table-btn" onclick="loadDbTable('${esc(t.name)}', this)"><span>${esc(t.name)}</span><span class="muted">${t.rows}</span></button>`
      )
      .join('');
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#btn-close-db').addEventListener('click', () => $('#db-viewer-panel').classList.add('hidden'));

const dbViewState = { table: '', offset: 0, hasMore: false, loading: false };

function renderDbRowsHtml(rows) {
  return rows
    .map(
      (r) =>
        `<tr>${r
          .map(
            (v) =>
              `<td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(v)}">${esc(v)}</td>`
          )
          .join('')}</tr>`
    )
    .join('');
}

async function fetchMoreDbRows() {
  if (!dbViewState.hasMore || dbViewState.loading) return;
  dbViewState.loading = true;
  try {
    const { rows, hasMore, nextOffset } = await api(
      `/api/sites/${encodeURIComponent(state.drawerDomain)}/db/rows?table=${encodeURIComponent(dbViewState.table)}&offset=${dbViewState.offset}&limit=100`
    );
    dbViewState.offset = nextOffset;
    dbViewState.hasMore = hasMore;
    const tbody = $('#db-rows-tbody');
    if (tbody) tbody.insertAdjacentHTML('beforeend', renderDbRowsHtml(rows));
    $('#db-viewer-table-name').textContent = `— ${dbViewState.table} (${dbViewState.offset} rows loaded${hasMore ? ', scroll for more' : ''})`;
    const moreBtn = $('#db-load-more-btn');
    if (moreBtn) moreBtn.classList.toggle('hidden', !hasMore);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    dbViewState.loading = false;
  }
}

$('#db-rows-wrap').addEventListener('scroll', () => {
  const el = $('#db-rows-wrap');
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
    fetchMoreDbRows();
  }
});

window.loadDbTable = async (table, btn) => {
  document.querySelectorAll('.db-table-btn').forEach((b) => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  dbViewState.table = table;
  dbViewState.offset = 0;
  dbViewState.hasMore = false;
  dbViewState.loading = true;
  $('#db-viewer-table-name').textContent = `— ${table}`;
  $('#db-rows-wrap').innerHTML = '<div class="muted" style="padding:14px">Loading rows...</div>';
  try {
    const { columns, rows, hasMore, nextOffset } = await api(
      `/api/sites/${encodeURIComponent(state.drawerDomain)}/db/rows?table=${encodeURIComponent(table)}&offset=0&limit=100`
    );
    dbViewState.offset = nextOffset || rows.length;
    dbViewState.hasMore = !!hasMore;
    if (!columns.length) {
      $('#db-rows-wrap').innerHTML = '<div class="muted" style="padding:14px">Empty table.</div>';
      return;
    }
    $('#db-viewer-table-name').textContent = `— ${table} (${dbViewState.offset} rows loaded${hasMore ? ', scroll for more' : ''})`;
    $('#db-rows-wrap').innerHTML = `
      <table class="data-table">
        <thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody id="db-rows-tbody">${renderDbRowsHtml(rows)}</tbody>
      </table>
      <div style="padding:8px;text-align:center">
        <button id="db-load-more-btn" class="btn btn-secondary btn-xs ${hasMore ? '' : 'hidden'}" onclick="fetchMoreDbRows()">Load More (100)</button>
      </div>`;
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    dbViewState.loading = false;
  }
};
window.fetchMoreDbRows = fetchMoreDbRows;

$('#staging-create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const stagingDomain = $('#staging-domain-input').value.trim();
    await api(`/api/sites/${encodeURIComponent(state.drawerDomain)}/staging/create`, {
      method: 'POST',
      body: { stagingDomain },
    });
    toast(`Creating staging ${stagingDomain}...`);
    openTerminal();
  } catch (err) {
    toast(err.message, 'error');
  }
});

async function pushStaging(mode) {
  const msg =
    mode === 'full'
      ? `Push FULL (Files + Database) from ${state.drawerDomain} to Live? This overwrites the Live DB (a pre-push snapshot is taken first).`
      : `Push FILES ONLY from ${state.drawerDomain} to Live? Live database/orders remain untouched (a pre-push snapshot is taken first).`;
  if (!confirm(msg)) return;
  try {
    await api(`/api/sites/${encodeURIComponent(state.drawerDomain)}/staging/push`, {
      method: 'POST',
      body: { mode },
    });
    toast(`Pushing staging (${mode}) to live...`);
    openTerminal();
  } catch (err) {
    toast(err.message, 'error');
  }
}

$('#btn-push-files').addEventListener('click', () => pushStaging('files'));
$('#btn-push-full').addEventListener('click', () => pushStaging('full'));

$('#btn-delete-staging').addEventListener('click', async () => {
  if (!confirm(`Permanently delete staging site ${state.drawerDomain} and its database?`)) return;
  try {
    await api(`/api/sites/${encodeURIComponent(state.drawerDomain)}/staging`, { method: 'DELETE' });
    toast('Staging site deleted');
    $('#site-drawer').classList.add('hidden');
    state.drawerDomain = null;
    loadSites();
  } catch (err) {
    toast(err.message, 'error');
  }
});

function renderDrawerAssets() {
  const plugins = state.drawerAssets.filter((a) => a.type === 'plugin');
  const themes = state.drawerAssets.filter((a) => a.type === 'theme');

  $('#drawer-plugins-tbody').innerHTML = plugins
    .map((p) => {
      const statusBadge =
        p.status === 'active'
          ? '<span class="badge badge-ok">active</span>'
          : `<span class="badge">${esc(p.status)}</span>`;
      const updBtn = p.update_version
        ? `<button class="btn btn-primary btn-xs" onclick="siteUpdate('plugin','${esc(p.slug)}')">Update → ${esc(p.update_version)}</button>`
        : '<span class="muted">—</span>';
      const toggleBtn =
        p.status === 'active'
          ? `<button class="btn btn-secondary btn-xs" onclick="pluginAct('deactivate','${esc(p.slug)}')">Deactivate</button>`
          : `<button class="btn btn-secondary btn-xs" onclick="pluginAct('activate','${esc(p.slug)}')">Activate</button>`;
      const delBtn =
        p.status !== 'must-use'
          ? `<button class="btn btn-danger btn-xs" onclick="pluginAct('delete','${esc(p.slug)}')">Delete</button>`
          : '';
      return `
        <tr>
          <td><strong>${esc(p.name)}</strong><div class="muted">${esc(p.slug)}</div></td>
          <td>${statusBadge}</td>
          <td>${esc(p.version)}</td>
          <td>${updBtn}</td>
          <td class="text-right"><div class="btn-group" style="justify-content:flex-end">${toggleBtn}${delBtn}</div></td>
        </tr>
      `;
    })
    .join('');

  $('#drawer-themes-tbody').innerHTML = themes
    .map((t) => {
      const statusBadge =
        t.status === 'active'
          ? '<span class="badge badge-ok">active</span>'
          : `<span class="badge">${esc(t.status)}</span>`;
      const updBtn = t.update_version
        ? `<button class="btn btn-primary btn-xs" onclick="siteUpdate('theme','${esc(t.slug)}')">Update → ${esc(t.update_version)}</button>`
        : '<span class="muted">—</span>';
      const actBtn =
        t.status !== 'active'
          ? `<button class="btn btn-secondary btn-xs" onclick="themeAct('activate','${esc(t.slug)}')">Activate</button>
             <button class="btn btn-danger btn-xs" onclick="themeAct('delete','${esc(t.slug)}')">Delete</button>`
          : '';
      return `
        <tr>
          <td><strong>${esc(t.name)}</strong><div class="muted">${esc(t.slug)}</div></td>
          <td>${statusBadge}</td>
          <td>${esc(t.version)}</td>
          <td>${updBtn}</td>
          <td class="text-right"><div class="btn-group" style="justify-content:flex-end">${actBtn}</div></td>
        </tr>
      `;
    })
    .join('');
}

async function loadSnapshots() {
  const dom = state.drawerDomain;
  $('#snap-storage-path').textContent = `Stored in /var/backups/wp-fleet/${dom}/ (14d retention)`;
  const { snapshots } = await api(`/api/sites/${encodeURIComponent(dom)}/snapshots`);
  $('#drawer-snapshots-tbody').innerHTML =
    snapshots.length === 0
      ? '<tr><td colspan="5" class="muted">No snapshots yet. Click "Take Full Snapshot" above or run an update.</td></tr>'
      : snapshots
          .map((s) => {
            const dlDb = s.db_file
              ? `<a class="btn btn-secondary btn-xs" href="/api/sites/${encodeURIComponent(dom)}/snapshots/${s.id}/download?part=db">DB .sql.gz</a>`
              : '';
            const dlFiles = s.archive_file
              ? `<a class="btn btn-secondary btn-xs" href="/api/sites/${encodeURIComponent(dom)}/snapshots/${s.id}/download?part=files">Files .tar.gz</a>`
              : '';
            return `
        <tr>
          <td>${esc(new Date(s.created_at).toLocaleString())}</td>
          <td>${esc(s.action)}</td>
          <td>${esc(s.slug || '—')}</td>
          <td><div class="btn-group">${dlDb}${dlFiles}</div></td>
          <td class="text-right">
            <div class="btn-group" style="justify-content:flex-end">
              <button class="btn btn-secondary btn-xs" onclick="restoreSnap(${s.id})">Restore</button>
              <button class="btn btn-danger btn-xs" onclick="deleteSnap(${s.id})">Delete</button>
            </div>
          </td>
        </tr>`;
          })
          .join('');
}

$('#btn-snap-full').addEventListener('click', async () => {
  try {
    await api(`/api/sites/${encodeURIComponent(state.drawerDomain)}/snapshots`, {
      method: 'POST',
      body: { includeContent: true },
    });
    toast('Full snapshot queued');
    openTerminal();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#btn-snap-db').addEventListener('click', async () => {
  try {
    await api(`/api/sites/${encodeURIComponent(state.drawerDomain)}/snapshots`, {
      method: 'POST',
      body: { includeContent: false },
    });
    toast('DB snapshot queued');
    openTerminal();
  } catch (err) {
    toast(err.message, 'error');
  }
});

window.deleteSnap = async (id) => {
  if (!confirm('Delete this snapshot from disk?')) return;
  try {
    await api(`/api/sites/${encodeURIComponent(state.drawerDomain)}/snapshots/${id}`, {
      method: 'DELETE',
    });
    toast('Snapshot deleted');
    loadSnapshots();
  } catch (err) {
    toast(err.message, 'error');
  }
};

$('#drawer-close').addEventListener('click', () => {
  $('#site-drawer').classList.add('hidden');
  state.drawerDomain = null;
});

$('#drawer-magic-login').addEventListener('click', () => {
  if (state.drawerDomain) window.magicLogin(state.drawerDomain);
});

document.querySelectorAll('.dtab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.dtab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.dtab-panel').forEach((p) => p.classList.add('hidden'));
    $(`#dtab-${btn.dataset.dtab}`).classList.remove('hidden');
  });
});

window.siteUpdate = async (target, slug) => {
  await api(`/api/sites/${encodeURIComponent(state.drawerDomain)}/update`, {
    method: 'POST',
    body: { target, slug },
  });
  openTerminal();
};

$('#btn-update-all-plugins').addEventListener('click', () => window.siteUpdate('all-plugins', ''));
$('#btn-update-all-themes').addEventListener('click', () => window.siteUpdate('all-themes', ''));

window.pluginAct = async (action, slug) => {
  if (action === 'delete' && !confirm(`Delete plugin ${slug}?`)) return;
  await api(`/api/sites/${encodeURIComponent(state.drawerDomain)}/plugin-action`, {
    method: 'POST',
    body: { action, slug },
  });
  openTerminal();
};

window.themeAct = async (action, slug) => {
  if (action === 'delete' && !confirm(`Delete theme ${slug}?`)) return;
  await api(`/api/sites/${encodeURIComponent(state.drawerDomain)}/theme-action`, {
    method: 'POST',
    body: { action, slug },
  });
  openTerminal();
};

window.restoreSnap = async (id) => {
  if (!confirm('Restore this snapshot? This will overwrite current plugin/theme files and DB.')) return;
  await api(`/api/sites/${encodeURIComponent(state.drawerDomain)}/snapshots/restore`, {
    method: 'POST',
    body: { id },
  });
  openTerminal();
};

async function searchWpOrg(type) {
  const q = $(`#wporg-${type}-q`).value.trim();
  if (!q) return;
  const box = $(`#wporg-${type}-results`);
  box.classList.remove('hidden');
  box.innerHTML = '<div class="muted">Searching WordPress.org...</div>';
  try {
    const { items } = await api(
      `/api/sites/${encodeURIComponent(state.drawerDomain)}/search-repo?type=${type}&q=${encodeURIComponent(q)}`
    );
    if (!items.length) {
      box.innerHTML = '<div class="muted">No results found.</div>';
      return;
    }
    box.innerHTML = items
      .map((i) => {
        const img = i.icon
          ? `<img class="search-icon ${type === 'theme' ? 'theme-thumb' : ''}" src="${esc(i.icon)}" alt="">`
          : `<div class="search-icon ${type === 'theme' ? 'theme-thumb' : ''}"></div>`;
        return `
        <div class="search-card">
          <div class="search-card-top">
            ${img}
            <div>
              <div><strong>${esc(i.name)}</strong></div>
              <div class="muted">${esc(i.slug)} · v${esc(i.version)}</div>
              <div class="search-desc">${esc(i.description || '')}</div>
            </div>
          </div>
          <div class="text-right">
            <button class="btn btn-primary btn-xs" onclick="${type}Act('install','${esc(i.slug)}')">Install & Activate</button>
          </div>
        </div>`;
      })
      .join('');
  } catch (err) {
    box.innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
  }
}

$('#btn-search-plugin').addEventListener('click', () => searchWpOrg('plugin'));
$('#btn-search-theme').addEventListener('click', () => searchWpOrg('theme'));
$('#wporg-plugin-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') searchWpOrg('plugin');
});
$('#wporg-theme-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') searchWpOrg('theme');
});

function startDiagStream(jobId, label) {
  state.diagJobId = jobId;
  const box = $('#debug-log-box');
  box.classList.remove('hidden');
  box.textContent = `Running: ${label}...\n`;
}

document.querySelectorAll('[data-diag]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      const { jobId } = await api(
        `/api/sites/${encodeURIComponent(state.drawerDomain)}/${btn.dataset.diag}`,
        { method: 'POST' }
      );
      startDiagStream(jobId, btn.textContent.trim());
    } catch (err) {
      toast(err.message, 'error');
    }
  });
});

document.querySelectorAll('[data-toggle]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      const { jobId } = await api(
        `/api/sites/${encodeURIComponent(state.drawerDomain)}/toggles`,
        {
          method: 'POST',
          body: { action: btn.dataset.toggle },
        }
      );
      startDiagStream(jobId, btn.textContent.trim());
    } catch (err) {
      toast(err.message, 'error');
    }
  });
});

$('#btn-tail-debug').addEventListener('click', async () => {
  const box = $('#debug-log-box');
  box.classList.remove('hidden');
  box.textContent = 'Loading...';
  const { lines } = await api(
    `/api/sites/${encodeURIComponent(state.drawerDomain)}/debug-log`
  );
  box.textContent = lines || '(empty)';
});

// --- Cross-Site Matrix ---
async function loadMatrix() {
  const { items } = await api(`/api/matrix?type=${state.matrixType}`);
  state.matrixItems = items;
  renderMatrix();
}

function renderMatrix() {
  const q = $('#matrix-filter').value.trim().toLowerCase();
  const filtered = state.matrixItems.filter(
    (i) => i.slug.toLowerCase().includes(q) || i.name.toLowerCase().includes(q)
  );
  $('#matrix-tbody').innerHTML = filtered
    .map((item) => {
      const outdatedDomains = item.sites.filter((s) => s.update_version).map((s) => s.domain);
      const instancesHtml = item.sites
        .map((s) => {
          const badge = s.update_version
            ? `<span class="badge badge-warn">${esc(s.domain)} (${esc(s.version)} → ${esc(s.update_version)})</span>`
            : `<span class="badge">${esc(s.domain)} (${esc(s.version)})</span>`;
          return badge;
        })
        .join(' ');
      const bulkBtn =
        outdatedDomains.length > 0
          ? `<button class="btn btn-primary btn-xs" onclick="bulkUpdate('${esc(item.slug)}', ${esc(JSON.stringify(outdatedDomains))})">Update ${outdatedDomains.length} Site(s)</button>`
          : '<span class="muted">All current</span>';
      return `
        <tr>
          <td><strong>${esc(item.name)}</strong><div class="muted">${esc(item.slug)}</div></td>
          <td>${item.sites.length}</td>
          <td>${item.updatesAvailable > 0 ? `<span class="badge badge-warn">${item.updatesAvailable}</span>` : '<span class="badge badge-ok">0</span>'}</td>
          <td>${instancesHtml}</td>
          <td class="text-right">${bulkBtn}</td>
        </tr>`;
    })
    .join('');
}

$('#matrix-filter').addEventListener('input', renderMatrix);
$('#matrix-type-plugin').addEventListener('click', () => {
  state.matrixType = 'plugin';
  $('#matrix-type-plugin').className = 'btn btn-primary btn-sm';
  $('#matrix-type-theme').className = 'btn btn-secondary btn-sm';
  loadMatrix();
});
$('#matrix-type-theme').addEventListener('click', () => {
  state.matrixType = 'theme';
  $('#matrix-type-theme').className = 'btn btn-primary btn-sm';
  $('#matrix-type-plugin').className = 'btn btn-secondary btn-sm';
  loadMatrix();
});

window.bulkUpdate = async (slug, domains) => {
  await api('/api/matrix/bulk-update', {
    method: 'POST',
    body: { type: state.matrixType, slug, domains },
  });
  openTerminal();
};

// --- Pro ZIP Vault ---
async function loadVault() {
  const { plugins, themes } = await api('/api/vault');
  const renderRows = (type, list) =>
    list.length === 0
      ? '<tr><td colspan="3" class="muted">No ZIPs uploaded.</td></tr>'
      : list
          .map(
            (f) => `
          <tr>
            <td><strong>${esc(f.filename)}</strong></td>
            <td>${(f.size / 1024 / 1024).toFixed(2)} MB</td>
            <td class="text-right">
              <div class="btn-group" style="justify-content:flex-end">
                <button class="btn btn-primary btn-xs" onclick="openDeploy('${type}','${esc(f.filename)}')">Deploy…</button>
                <button class="btn btn-danger btn-xs" onclick="deleteVault('${type}','${esc(f.filename)}')">Delete</button>
              </div>
            </td>
          </tr>`
          )
          .join('');
  $('#vault-plugins-tbody').innerHTML = renderRows('plugin', plugins);
  $('#vault-themes-tbody').innerHTML = renderRows('theme', themes);
}

async function handleZipUpload(type, input) {
  const file = input.files?.[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  await api(`/api/vault/upload?type=${type}`, { method: 'POST', body: fd });
  input.value = '';
  loadVault();
}

$('#upload-plugin-zip').addEventListener('change', (e) => handleZipUpload('plugin', e.target));
$('#upload-theme-zip').addEventListener('change', (e) => handleZipUpload('theme', e.target));

window.deleteVault = async (type, filename) => {
  if (!confirm(`Delete ${filename} from vault?`)) return;
  await api(`/api/vault/${type}/${encodeURIComponent(filename)}`, { method: 'DELETE' });
  loadVault();
};

window.openDeploy = (type, filename) => {
  state.deployTarget = { kind: 'vault', type, filename };
  $('#deploy-title').textContent = `Deploy ${filename} (${type})`;
  renderDeploySites();
};

window.openApplyBlueprint = (id, name) => {
  state.deployTarget = { kind: 'blueprint', id, name };
  $('#deploy-title').textContent = `Apply Blueprint: ${name}`;
  renderDeploySites();
};

function renderDeploySites() {
  $('#deploy-sites-list').innerHTML = state.sites
    .map(
      (s) => `
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" class="deploy-cb" value="${esc(s.domain)}">
        <span><strong>${esc(s.domain)}</strong> <span class="muted">(${esc(s.user)})</span></span>
      </label>`
    )
    .join('');
  $('#deploy-modal').classList.remove('hidden');
}

$('#deploy-close').addEventListener('click', () => $('#deploy-modal').classList.add('hidden'));
$('#deploy-select-all').addEventListener('click', () => {
  document.querySelectorAll('.deploy-cb').forEach((cb) => (cb.checked = true));
});
$('#deploy-confirm').addEventListener('click', async () => {
  const domains = Array.from(document.querySelectorAll('.deploy-cb:checked')).map((c) => c.value);
  if (!domains.length) return alert('Select at least one site.');
  try {
    if (state.deployTarget?.kind === 'blueprint') {
      await api(`/api/blueprints/${state.deployTarget.id}/apply`, {
        method: 'POST',
        body: { domains },
      });
      toast(`Blueprint "${state.deployTarget.name}" queued for ${domains.length} site(s)`);
    } else {
      await api('/api/vault/deploy', {
        method: 'POST',
        body: { type: state.deployTarget.type, filename: state.deployTarget.filename, domains },
      });
      toast(`Deploy queued for ${domains.length} site(s)`);
    }
    $('#deploy-modal').classList.add('hidden');
    openTerminal();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// --- Blueprints ---
const bpState = {
  selected: new Set(),
  known: [],
  displayed: [],
};

function renderBpSelected() {
  const box = $('#bp-selected-plugins');
  if (bpState.selected.size === 0) {
    box.innerHTML = '<span class="muted">No WP.org plugins selected yet.</span>';
    return;
  }
  box.innerHTML = Array.from(bpState.selected)
    .map(
      (slug) =>
        `<span class="badge badge-brand">${esc(slug)} <a href="#" onclick="toggleBpPlugin('${esc(slug)}');return false" style="margin-left:4px;color:inherit">×</a></span>`
    )
    .join('');
}

function renderBpPicker() {
  const box = $('#bp-plugin-picker');
  if (!bpState.displayed.length) {
    box.innerHTML = '<div class="muted" style="padding:6px">No plugins found. Try "Search WP.org".</div>';
    return;
  }
  box.innerHTML = bpState.displayed
    .map((p) => {
      const checked = bpState.selected.has(p.slug) ? 'checked' : '';
      const icon = p.icon
        ? `<img class="bp-pick-icon" src="${esc(p.icon)}" alt="">`
        : `<div class="bp-pick-icon"></div>`;
      return `
        <label class="bp-pick-row" title="${esc(p.name)} (${esc(p.slug)})">
          <input type="checkbox" ${checked} onchange="toggleBpPlugin('${esc(p.slug)}')">
          ${icon}
          <span><strong>${esc(p.name)}</strong></span>
        </label>`;
    })
    .join('');
}

window.toggleBpPlugin = (slug) => {
  if (bpState.selected.has(slug)) bpState.selected.delete(slug);
  else bpState.selected.add(slug);
  renderBpSelected();
  renderBpPicker();
};

async function searchBpPlugins() {
  const q = $('#bp-plugin-search').value.trim();
  if (!q) {
    bpState.displayed = bpState.known;
    renderBpPicker();
    return;
  }
  $('#bp-plugin-picker').innerHTML = '<div class="muted" style="padding:6px">Searching WordPress.org...</div>';
  try {
    const { items } = await api(`/api/search-repo?type=plugin&q=${encodeURIComponent(q)}`);
    bpState.displayed = items;
    renderBpPicker();
  } catch (err) {
    toast(err.message, 'error');
  }
}

$('#bp-plugin-search').addEventListener('input', () => {
  const q = $('#bp-plugin-search').value.trim().toLowerCase();
  bpState.displayed = q
    ? bpState.known.filter((p) => p.slug.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
    : bpState.known;
  renderBpPicker();
});
$('#bp-plugin-search-btn').addEventListener('click', searchBpPlugins);
$('#bp-plugin-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    searchBpPlugins();
  }
});

async function loadBlueprints() {
  const isAdmin = state.me?.role === 'admin';
  const [{ blueprints }, vault, known] = await Promise.all([
    api('/api/blueprints'),
    isAdmin ? api('/api/vault') : Promise.resolve({ plugins: [], themes: [] }),
    api('/api/known-plugins'),
  ]);
  bpState.known = known.items || [];
  bpState.displayed = bpState.known;
  renderBpSelected();
  renderBpPicker();

  $('#bp-vault-plugins').innerHTML =
    vault.plugins.length === 0
      ? '<span class="muted">No Pro plugin ZIPs in vault</span>'
      : vault.plugins
          .map(
            (p) => `
          <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer">
            <input type="checkbox" class="bp-vp-cb" value="${esc(p.filename)}">
            <span>${esc(p.filename)}</span>
          </label>`
          )
          .join('');

  $('#bp-vault-theme').innerHTML =
    '<option value="">None</option>' +
    vault.themes.map((t) => `<option value="${esc(t.filename)}">${esc(t.filename)}</option>`).join('');

  $('#bp-tbody').innerHTML =
    blueprints.length === 0
      ? '<tr><td colspan="3" class="muted">No blueprints saved yet.</td></tr>'
      : blueprints
          .map((bp) => {
            const parts = [
              ...bp.plugins.map((s) => `<span class="badge">${esc(s)}</span>`),
              ...bp.vaultPlugins.map((z) => `<span class="badge badge-brand">${esc(z)}</span>`),
              bp.vault_theme ? `<span class="badge badge-ok">${esc(bp.vault_theme)}</span>` : '',
            ].join(' ');
            return `
            <tr>
              <td><strong>${esc(bp.name)}</strong></td>
              <td>${parts || '<span class="muted">Empty</span>'}</td>
              <td class="text-right">
                <div class="btn-group" style="justify-content:flex-end">
                  <button class="btn btn-primary btn-xs" onclick="openApplyBlueprint(${bp.id},'${esc(bp.name)}')">Apply to Sites…</button>
                  <button class="btn btn-danger btn-xs" onclick="deleteBlueprint(${bp.id})">Delete</button>
                </div>
              </td>
            </tr>`;
          })
          .join('');
}

$('#bp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const name = $('#bp-name').value.trim();
    const plugins = Array.from(bpState.selected);
    const vaultPlugins = Array.from(document.querySelectorAll('.bp-vp-cb:checked')).map((c) => c.value);
    const vaultTheme = $('#bp-vault-theme').value;

    await api('/api/blueprints', {
      method: 'POST',
      body: { name, plugins, vaultPlugins, vaultTheme },
    });
    $('#bp-name').value = '';
    $('#bp-plugin-search').value = '';
    bpState.selected.clear();
    renderBpSelected();
    renderBpPicker();
    toast(`Blueprint "${name}" saved`);
    loadBlueprints();
  } catch (err) {
    toast(err.message, 'error');
  }
});

window.deleteBlueprint = async (id) => {
  if (!confirm('Delete this blueprint?')) return;
  try {
    await api(`/api/blueprints/${id}`, { method: 'DELETE' });
    toast('Blueprint deleted');
    loadBlueprints();
  } catch (err) {
    toast(err.message, 'error');
  }
};

// --- Fleet Users (Admin Only) ---
$('#fu-role').addEventListener('change', () => {
  $('#fu-hestia-wrap').classList.toggle('hidden', $('#fu-role').value === 'admin');
});

async function loadFleetUsers() {
  try {
    const { users, hestiaUsers } = await api('/api/users');
    $('#fu-hestia-user').innerHTML = hestiaUsers.length
      ? hestiaUsers.map((u) => `<option value="${esc(u)}">${esc(u)}</option>`).join('')
      : '<option value="">No Hestia users discovered</option>';

    $('#fu-tbody').innerHTML =
      users.length === 0
        ? '<tr><td colspan="5" class="muted">No additional Fleet users created yet.</td></tr>'
        : users
            .map(
              (u) => `
            <tr>
              <td><strong>${esc(u.username)}</strong></td>
              <td><span class="badge ${u.role === 'admin' ? 'badge-brand' : ''}">${esc(u.role)}</span></td>
              <td>${esc(u.hestia_user || '—')}</td>
              <td><span class="badge ${u.active ? 'badge-ok' : 'badge-err'}">${u.active ? 'Active' : 'Disabled'}</span></td>
              <td class="text-right">
                <div class="btn-group" style="justify-content:flex-end">
                  <button class="btn btn-secondary btn-xs" onclick="toggleFleetUser(${u.id}, ${u.active ? 0 : 1})">${u.active ? 'Disable' : 'Enable'}</button>
                  <button class="btn btn-secondary btn-xs" onclick="resetFleetUserPass(${u.id})">Reset Pass</button>
                  <button class="btn btn-danger btn-xs" onclick="deleteFleetUser(${u.id},'${esc(u.username)}')">Delete</button>
                </div>
              </td>
            </tr>`
            )
            .join('');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function isStrongPassword(pw) {
  return typeof pw === 'string' && pw.length >= 8 && /[a-zA-Z]/.test(pw) && /[0-9]/.test(pw);
}

$('#btn-profile').addEventListener('click', () => {
  $('#profile-username').textContent = state.me?.user || '';
  $('#prof-current').value = '';
  $('#prof-new').value = '';
  $('#prof-confirm').value = '';
  $('#profile-modal').classList.remove('hidden');
});

$('#profile-close').addEventListener('click', () => $('#profile-modal').classList.add('hidden'));

$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cur = $('#prof-current').value;
  const pw = $('#prof-new').value;
  const conf = $('#prof-confirm').value;
  if (pw !== conf) return toast('Passwords do not match', 'error');
  if (!isStrongPassword(pw)) return toast('Password must be 8+ chars with letters and numbers', 'error');
  try {
    await api('/api/auth/change-password', {
      method: 'POST',
      body: { currentPassword: cur, newPassword: pw },
    });
    $('#profile-modal').classList.add('hidden');
    toast('Password updated');
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#fleet-user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('#fu-password').value;
  const conf = $('#fu-confirm').value;
  if (pw !== conf) return toast('Passwords do not match', 'error');
  if (!isStrongPassword(pw)) return toast('Password must be 8+ chars with letters and numbers', 'error');
  try {
    await api('/api/users', {
      method: 'POST',
      body: {
        username: $('#fu-username').value.trim(),
        password: pw,
        role: $('#fu-role').value,
        hestiaUser: $('#fu-hestia-user').value,
      },
    });
    $('#fu-username').value = '';
    $('#fu-password').value = '';
    $('#fu-confirm').value = '';
    toast('Fleet user created');
    loadFleetUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
});

window.toggleFleetUser = async (id, active) => {
  try {
    await api(`/api/users/${id}`, { method: 'PATCH', body: { active: !!active } });
    toast(active ? 'User enabled' : 'User disabled');
    loadFleetUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
};

window.resetFleetUserPass = async (id) => {
  const pw = prompt('Enter new password (min 8 chars, letters + numbers):');
  if (!pw) return;
  if (!isStrongPassword(pw)) return toast('Password must be 8+ chars with letters and numbers', 'error');
  try {
    await api(`/api/users/${id}`, { method: 'PATCH', body: { password: pw } });
    toast('Password updated');
  } catch (err) {
    toast(err.message, 'error');
  }
};

window.deleteFleetUser = async (id, name) => {
  if (!confirm(`Delete Fleet user "${name}"?`)) return;
  try {
    await api(`/api/users/${id}`, { method: 'DELETE' });
    toast('Fleet user deleted');
    loadFleetUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
};

// --- Audit Log ---
async function loadAudit() {
  const { logs } = await api('/api/audit');
  $('#audit-tbody').innerHTML = logs
    .map(
      (l) => `
      <tr>
        <td>${esc(new Date(l.created_at).toLocaleString())}</td>
        <td>${esc(l.domain || 'global')}</td>
        <td>${esc(l.action)}</td>
        <td><span class="badge ${l.status === 'success' ? 'badge-ok' : 'badge-err'}">${esc(l.status)}</span></td>
        <td class="muted">${esc(l.details)}</td>
      </tr>`
    )
    .join('');
}

// --- Live SSE Terminal ---
function openTerminal() {
  // Keep terminal non-intrusive: only expand when user clicks the bar
}

$('#terminal-toggle').addEventListener('click', (e) => {
  if (e.target.id === 'terminal-clear') return;
  const out = $('#terminal-output');
  const hidden = out.classList.toggle('hidden');
  $('#terminal-chevron').textContent = hidden ? '▲' : '▼';
});

$('#terminal-clear').addEventListener('click', () => {
  $('#terminal-output').textContent = '';
});

function appendTerminal(text) {
  const out = $('#terminal-output');
  out.textContent += `${text}\n`;
  out.scrollTop = out.scrollHeight;
}

function connectSSE() {
  if (state.sse) state.sse.close();
  const es = new EventSource('/api/events');
  state.sse = es;

  es.addEventListener('ready', () => $('#sse-dot').classList.add('connected'));
  es.onerror = () => $('#sse-dot').classList.remove('connected');

  es.addEventListener('job', (e) => {
    const { payload } = JSON.parse(e.data);
    if (payload.status === 'running') {
      $('#active-job-label').textContent = `— ${payload.label}`;
      appendTerminal(`\n=== [${payload.domain}] ${payload.label} ===`);
      if (payload.action === 'scan') {
        $('#btn-scan').disabled = true;
        $('#btn-scan').textContent = 'Scanning…';
        $('#scan-banner').classList.remove('hidden');
      }
    } else if (payload.status === 'done') {
      $('#active-job-label').textContent = '';
      appendTerminal(`=== DONE: ${payload.label} ===`);
      toast(`Done: ${payload.label}`);
      if (payload.action === 'scan') {
        $('#btn-scan').disabled = false;
        $('#btn-scan').textContent = 'Refresh Scan';
        $('#scan-banner').classList.add('hidden');
      }
      if (state.diagJobId && state.diagJobId === payload.id) {
        const box = $('#debug-log-box');
        box.textContent += `\n✔ Done: ${payload.label}\n`;
        box.scrollTop = box.scrollHeight;
      }
      loadSites();
      if (state.drawerDomain === payload.domain) loadDrawerData();
      if (state.activeTab === 'matrix') loadMatrix();
      if (state.activeTab === 'audit') loadAudit();
    } else if (payload.status === 'error') {
      $('#active-job-label').textContent = '';
      appendTerminal(`=== FAILED: ${payload.error} ===`);
      toast(`Failed: ${payload.error}`, 'error');
      if (payload.action === 'scan') {
        $('#btn-scan').disabled = false;
        $('#btn-scan').textContent = 'Refresh Scan';
        $('#scan-banner').classList.add('hidden');
      }
      if (state.diagJobId && state.diagJobId === payload.id) {
        const box = $('#debug-log-box');
        box.textContent += `\n✖ Failed: ${payload.error}\n`;
        box.scrollTop = box.scrollHeight;
      }
    }
  });

  es.addEventListener('log', (e) => {
    const { payload } = JSON.parse(e.data);
    appendTerminal(`[${payload.domain}] ${payload.line}`);
    if ((payload.domain === 'global' || payload.domain.startsWith('user:')) && payload.line.startsWith('Scanning ')) {
      $('#scan-banner-text').textContent = payload.line;
    }
    if (state.diagJobId && state.diagJobId === payload.id) {
      const box = $('#debug-log-box');
      box.textContent += `${payload.line}\n`;
      box.scrollTop = box.scrollHeight;
    }
  });
}

boot();
