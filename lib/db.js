import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let db;

export function initDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'fleet.db');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sites (
      domain TEXT PRIMARY KEY,
      user TEXT NOT NULL,
      path TEXT NOT NULL,
      site_url TEXT NOT NULL,
      php_version TEXT DEFAULT '',
      wp_version TEXT DEFAULT '',
      wp_update_version TEXT DEFAULT '',
      active_theme TEXT DEFAULT '',
      plugin_updates INTEGER DEFAULT 0,
      theme_updates INTEGER DEFAULT 0,
      http_status INTEGER DEFAULT NULL,
      ttfb_ms INTEGER DEFAULT NULL,
      health_error TEXT DEFAULT '',
      last_health_at TEXT DEFAULT '',
      last_scan_at TEXT DEFAULT '',
      staging_of TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS site_assets (
      domain TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('plugin','theme')),
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      version TEXT DEFAULT '',
      update_version TEXT DEFAULT '',
      auto_update INTEGER DEFAULT 0,
      PRIMARY KEY (domain, type, slug),
      FOREIGN KEY (domain) REFERENCES sites(domain) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      action TEXT NOT NULL,
      asset_type TEXT DEFAULT '',
      slug TEXT DEFAULT '',
      db_file TEXT DEFAULT '',
      archive_file TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT DEFAULT '',
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      details TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS blueprints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      owner TEXT DEFAULT '',
      plugins_json TEXT NOT NULL DEFAULT '[]',
      vault_plugins_json TEXT NOT NULL DEFAULT '[]',
      vault_theme TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      pass_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','client')),
      hestia_user TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL
    );
  `);

  try {
    db.exec(`ALTER TABLE sites ADD COLUMN staging_of TEXT DEFAULT '';`);
  } catch {
    // column already exists
  }
  try {
    db.exec(`ALTER TABLE blueprints ADD COLUMN owner TEXT DEFAULT '';`);
  } catch {
    // column already exists
  }

  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized');
  try {
    db.exec(`ALTER TABLE sites ADD COLUMN staging_of TEXT DEFAULT '';`);
  } catch {
    // column already exists
  }
  try {
    db.exec(`ALTER TABLE blueprints ADD COLUMN owner TEXT DEFAULT '';`);
  } catch {
    // column already exists
  }

  return db;
}

export function getSite(domain) {
  return getDb().prepare('SELECT * FROM sites WHERE domain = ?').get(domain);
}

export function assertKnownSite(domain) {
  const site = getSite(domain);
  if (!site) {
    const err = new Error(`Unknown site: ${domain}`);
    err.statusCode = 404;
    throw err;
  }
  return site;
}

export function setSiteStagingOf(domain, parentDomain) {
  getDb().prepare('UPDATE sites SET staging_of = ? WHERE domain = ?').run(parentDomain || '', domain);
}

export function listStagingFor(parentDomain) {
  return getDb().prepare('SELECT * FROM sites WHERE staging_of = ? ORDER BY domain ASC').all(parentDomain);
}

export function updateSiteUrlAndPath(domain, { site_url, path }) {
  getDb().prepare('UPDATE sites SET site_url = ?, path = ? WHERE domain = ?').run(site_url, path, domain);
}

export function listSites() {
  return getDb().prepare('SELECT * FROM sites ORDER BY domain ASC').all();
}

export function upsertSite(site) {
  getDb()
    .prepare(`
      INSERT INTO sites (
        domain, user, path, site_url, php_version, wp_version,
        wp_update_version, active_theme, plugin_updates, theme_updates, last_scan_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET
        user = excluded.user,
        path = excluded.path,
        site_url = excluded.site_url,
        php_version = excluded.php_version,
        wp_version = excluded.wp_version,
        wp_update_version = excluded.wp_update_version,
        active_theme = excluded.active_theme,
        plugin_updates = excluded.plugin_updates,
        theme_updates = excluded.theme_updates,
        last_scan_at = excluded.last_scan_at
    `)
    .run(
      site.domain,
      site.user,
      site.path,
      site.site_url,
      site.php_version || '',
      site.wp_version || '',
      site.wp_update_version || '',
      site.active_theme || '',
      site.plugin_updates || 0,
      site.theme_updates || 0,
      site.last_scan_at || new Date().toISOString()
    );
}

export function replaceSiteAssets(domain, assets) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    d.prepare('DELETE FROM site_assets WHERE domain = ?').run(domain);
    const stmt = d.prepare(`
      INSERT INTO site_assets (domain, type, slug, name, status, version, update_version, auto_update)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const a of assets) {
      stmt.run(
        domain,
        a.type,
        a.slug,
        a.name || a.slug,
        a.status || 'inactive',
        a.version || '',
        a.update_version || '',
        a.auto_update ? 1 : 0
      );
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

export function getSiteAssets(domain) {
  return getDb()
    .prepare('SELECT * FROM site_assets WHERE domain = ? ORDER BY type ASC, name ASC')
    .all(domain);
}

export function getMatrixAssets(type) {
  return getDb()
    .prepare(`
      SELECT a.slug, a.name, a.domain, a.status, a.version, a.update_version, s.user, s.site_url
      FROM site_assets a
      JOIN sites s ON s.domain = a.domain
      WHERE a.type = ?
      ORDER BY a.slug ASC, a.domain ASC
    `)
    .all(type);
}

export function updateSiteHealth(domain, { http_status, ttfb_ms, health_error }) {
  getDb()
    .prepare(`
      UPDATE sites
      SET http_status = ?, ttfb_ms = ?, health_error = ?, last_health_at = ?
      WHERE domain = ?
    `)
    .run(
      http_status ?? null,
      ttfb_ms ?? null,
      health_error || '',
      new Date().toISOString(),
      domain
    );
}

export function addSnapshot({ domain, action, asset_type, slug, db_file, archive_file }) {
  const res = getDb()
    .prepare(`
      INSERT INTO snapshots (domain, action, asset_type, slug, db_file, archive_file, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      domain,
      action,
      asset_type || '',
      slug || '',
      db_file || '',
      archive_file || '',
      new Date().toISOString()
    );
  return res.lastInsertRowid;
}

export function listSnapshots(domain) {
  return getDb()
    .prepare('SELECT * FROM snapshots WHERE domain = ? ORDER BY id DESC LIMIT 50')
    .all(domain);
}

export function getSnapshot(id) {
  return getDb().prepare('SELECT * FROM snapshots WHERE id = ?').get(id);
}

export function deleteSnapshot(id) {
  getDb().prepare('DELETE FROM snapshots WHERE id = ?').run(id);
}

export function logAudit({ domain = '', action, status, details = '' }) {
  const d = getDb();
  d.prepare(`
      INSERT INTO audit_log (domain, action, status, details, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(domain, action, status, details, new Date().toISOString());

  // Retention: prune entries older than 90 days and cap at 1000 rows
  const cutoff = new Date(Date.now() - 90 * 86400 * 1000).toISOString();
  d.prepare('DELETE FROM audit_log WHERE created_at < ?').run(cutoff);
  d.prepare('DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT 1000)').run();
}

export function listAuditLog(limit = 100) {
  return getDb()
    .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
    .all(limit);
}

export function listBlueprints(owner = null) {
  const rows =
    owner === null
      ? getDb().prepare('SELECT * FROM blueprints ORDER BY name ASC').all()
      : getDb().prepare('SELECT * FROM blueprints WHERE owner = ? ORDER BY name ASC').all(owner);
  return rows.map((b) => ({
    ...b,
    plugins: JSON.parse(b.plugins_json || '[]'),
    vaultPlugins: JSON.parse(b.vault_plugins_json || '[]'),
  }));
}

export function getBlueprint(id) {
  const b = getDb().prepare('SELECT * FROM blueprints WHERE id = ?').get(id);
  if (!b) return null;
  return {
    ...b,
    plugins: JSON.parse(b.plugins_json || '[]'),
    vaultPlugins: JSON.parse(b.vault_plugins_json || '[]'),
  };
}

export function createBlueprint({ name, owner = '', plugins = [], vaultPlugins = [], vaultTheme = '' }) {
  const res = getDb()
    .prepare(`
      INSERT INTO blueprints (name, owner, plugins_json, vault_plugins_json, vault_theme, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(
      name,
      owner,
      JSON.stringify(plugins),
      JSON.stringify(vaultPlugins),
      vaultTheme,
      new Date().toISOString()
    );
  return res.lastInsertRowid;
}

export function deleteBlueprint(id, owner = null) {
  if (owner === null) {
    getDb().prepare('DELETE FROM blueprints WHERE id = ?').run(id);
  } else {
    getDb().prepare('DELETE FROM blueprints WHERE id = ? AND owner = ?').run(id, owner);
  }
}

export function listUsers() {
  return getDb()
    .prepare('SELECT id, username, role, hestia_user, active, created_at FROM users ORDER BY username ASC')
    .all();
}

export function getUserByUsername(username) {
  return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
}

export function createUser({ username, pass_hash, role, hestia_user = '' }) {
  const res = getDb()
    .prepare(`
      INSERT INTO users (username, pass_hash, role, hestia_user, active, created_at)
      VALUES (?, ?, ?, ?, 1, ?)
    `)
    .run(username, pass_hash, role, hestia_user, new Date().toISOString());
  return res.lastInsertRowid;
}

export function updateUser(id, { pass_hash, active }) {
  const d = getDb();
  if (pass_hash !== undefined) {
    d.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(pass_hash, id);
  }
  if (active !== undefined) {
    d.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  }
}

export function deleteUser(id) {
  getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
}

export function listSitesForUser(hestiaUser) {
  return getDb().prepare('SELECT * FROM sites WHERE user = ? ORDER BY domain ASC').all(hestiaUser);
}

export function getMatrixAssetsForUser(type, hestiaUser) {
  return getDb()
    .prepare(`
      SELECT a.slug, a.name, a.domain, a.status, a.version, a.update_version, s.user, s.site_url
      FROM site_assets a
      JOIN sites s ON s.domain = a.domain
      WHERE a.type = ? AND s.user = ?
      ORDER BY a.slug ASC, a.domain ASC
    `)
    .all(type, hestiaUser);
}

export function listAuditLogForUser(hestiaUser, limit = 100) {
  return getDb()
    .prepare(`
      SELECT a.* FROM audit_log a
      JOIN sites s ON s.domain = a.domain
      WHERE s.user = ?
      ORDER BY a.id DESC LIMIT ?
    `)
    .all(hestiaUser, limit);
}
