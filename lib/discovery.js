import fs from 'node:fs';
import path from 'node:path';
import { getConfig, runHelper, runWp } from './wpcli.js';
import { getDb, replaceSiteAssets, upsertSite } from './db.js';

async function discoverRawSites() {
  const { mode } = getConfig();
  if (mode === 'hestia') {
    const { stdout } = await runHelper(['discover']);
    return JSON.parse(stdout || '[]');
  }

  // Local mode: scan LOCAL_SITES_ROOT (or parent of cwd)
  const root = process.env.LOCAL_SITES_ROOT || path.resolve(process.cwd(), '..');
  if (!fs.existsSync(root)) return [];

  const entries = fs.readdirSync(root, { withFileTypes: true });
  const results = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const sitePath = path.join(root, ent.name);
    if (fs.existsSync(path.join(sitePath, 'wp-config.php'))) {
      results.push({
        user: 'local',
        domain: `${ent.name}.test`,
        path: sitePath,
        php_version: 'local',
      });
    }
  }
  return results;
}

export async function refreshSiteMetadata(site, onLine) {
  const [urlRes, coreVerRes, coreUpdRes, pluginsRes, themesRes] = await Promise.allSettled([
    runWp(site, ['option', 'get', 'siteurl'], { onLine }),
    runWp(site, ['core', 'version'], { onLine }),
    runWp(site, ['core', 'check-update', '--format=json'], { onLine }),
    runWp(site, ['plugin', 'list', '--format=json'], { onLine }),
    runWp(site, ['theme', 'list', '--format=json'], { onLine }),
  ]);

  const siteUrl =
    urlRes.status === 'fulfilled' && urlRes.value.stdout
      ? urlRes.value.stdout.trim()
      : `https://${site.domain}`;
  const wpVersion =
    coreVerRes.status === 'fulfilled' ? coreVerRes.value.stdout.trim() : '';

  let wpUpdateVersion = '';
  if (coreUpdRes.status === 'fulfilled' && coreUpdRes.value.stdout) {
    try {
      const updates = JSON.parse(coreUpdRes.value.stdout);
      if (Array.isArray(updates) && updates.length > 0) {
        const major = updates.find((u) => u.update_type === 'major');
        wpUpdateVersion = (major || updates[updates.length - 1]).version || '';
      }
    } catch {
      // ignore parse errors
    }
  }

  const assets = [];
  let pluginUpdates = 0;
  let themeUpdates = 0;
  let activeTheme = '';

  if (pluginsRes.status === 'fulfilled' && pluginsRes.value.stdout) {
    try {
      const plugins = JSON.parse(pluginsRes.value.stdout);
      for (const p of plugins) {
        const upd = p.update_version || (p.update === 'available' ? 'available' : '');
        if (upd) pluginUpdates++;
        assets.push({
          type: 'plugin',
          slug: p.name,
          name: p.title || p.name,
          status: p.status || 'inactive',
          version: p.version || '',
          update_version: upd,
          auto_update: p.auto_update === 'on' || p.auto_update === true,
        });
      }
    } catch {
      // ignore
    }
  }

  if (themesRes.status === 'fulfilled' && themesRes.value.stdout) {
    try {
      const themes = JSON.parse(themesRes.value.stdout);
      for (const t of themes) {
        const upd = t.update_version || (t.update === 'available' ? 'available' : '');
        if (upd) themeUpdates++;
        if (t.status === 'active') activeTheme = t.name;
        assets.push({
          type: 'theme',
          slug: t.name,
          name: t.title || t.name,
          status: t.status || 'inactive',
          version: t.version || '',
          update_version: upd,
          auto_update: t.auto_update === 'on' || t.auto_update === true,
        });
      }
    } catch {
      // ignore
    }
  }

  upsertSite({
    domain: site.domain,
    user: site.user,
    path: site.path,
    site_url: siteUrl,
    php_version: site.php_version || '',
    wp_version: wpVersion,
    wp_update_version: wpUpdateVersion,
    active_theme: activeTheme,
    plugin_updates: pluginUpdates,
    theme_updates: themeUpdates,
    last_scan_at: new Date().toISOString(),
  });
  replaceSiteAssets(site.domain, assets);
}

export async function scanAllSites(onLine) {
  const rawSites = await discoverRawSites();
  const discoveredDomains = new Set(rawSites.map((s) => s.domain));

  // Remove sites no longer present on disk
  const existing = getDb().prepare('SELECT domain FROM sites').all();
  for (const row of existing) {
    if (!discoveredDomains.has(row.domain)) {
      getDb().prepare('DELETE FROM sites WHERE domain = ?').run(row.domain);
    }
  }

  for (const raw of rawSites) {
    if (onLine) onLine(`Scanning ${raw.domain} (${raw.user})...`);
    await refreshSiteMetadata(raw, onLine);
  }

  return rawSites.length;
}

export async function scanSitesForUser(hestiaUser, onLine) {
  const rawSites = (await discoverRawSites()).filter((s) => s.user === hestiaUser);
  const discoveredDomains = new Set(rawSites.map((s) => s.domain));

  const existing = getDb().prepare('SELECT domain FROM sites WHERE user = ?').all(hestiaUser);
  for (const row of existing) {
    if (!discoveredDomains.has(row.domain)) {
      getDb().prepare('DELETE FROM sites WHERE domain = ?').run(row.domain);
    }
  }

  for (const raw of rawSites) {
    if (onLine) onLine(`Scanning ${raw.domain} (${raw.user})...`);
    await refreshSiteMetadata(raw, onLine);
  }

  return rawSites.length;
}
