import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { addSnapshot, deleteSnapshot, getSnapshot, listSnapshots } from './db.js';
import { getConfig, runHelper, spawnWpRaw } from './wpcli.js';
import { assertAssetType, assertSlug } from './validate.js';

function getBackupRoot() {
  return process.env.BACKUP_DIR || '/var/backups/wp-fleet';
}

function getRetentionDays() {
  const n = Number(process.env.SNAPSHOT_RETENTION_DAYS || 14);
  return Number.isFinite(n) && n > 0 ? n : 14;
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export async function createPreUpdateSnapshot(site, { action, assetType = '', slug = '' }, onLine) {
  const dir = path.join(getBackupRoot(), site.domain);
  fs.mkdirSync(dir, { recursive: true });
  const ts = timestampSlug();
  const tag = slug ? assertSlug(slug) : action;

  const dbFile = path.join(dir, `${ts}_pre-${tag}.sql.gz`);
  if (onLine) onLine(`Exporting database snapshot -> ${path.basename(dbFile)}...`);

  await exportDbGzip(site, dbFile);

  let archiveFile = '';
  if (assetType === 'wp-content') {
    archiveFile = path.join(dir, `${ts}_pre-${tag}-wp-content.tar.gz`);
    if (onLine) onLine(`Archiving wp-content -> ${path.basename(archiveFile)}...`);
    if (getConfig().mode === 'hestia') {
      await runHelper(['archive-content', site.user, site.domain, archiveFile], { onLine });
    } else {
      await new Promise((resolve, reject) => {
        const child = spawn(
          'tar',
          ['-czf', archiveFile, '--exclude=wp-content/cache', '--exclude=wp-content/upgrade', '-C', site.path, 'wp-content'],
          { shell: false }
        );
        let err = '';
        child.stderr.on('data', (c) => (err += c.toString('utf8')));
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `tar exited ${code}`))));
      });
    }
  } else if (assetType && slug) {
    assertAssetType(assetType);
    assertSlug(slug);
    archiveFile = path.join(dir, `${ts}_${assetType}-${slug}.tar.gz`);
    if (onLine) onLine(`Archiving ${assetType} '${slug}' -> ${path.basename(archiveFile)}...`);
    await archiveAsset(site, assetType, slug, archiveFile, onLine);
  }

  const id = addSnapshot({
    domain: site.domain,
    action,
    asset_type: assetType,
    slug,
    db_file: dbFile,
    archive_file: archiveFile,
  });

  await pruneOldSnapshots(site.domain, onLine);
  return id;
}

async function exportDbGzip(site, destFile) {
  const child = spawnWpRaw(site, ['db', 'export', '-'], ['ignore', 'pipe', 'pipe']);
  let stderr = '';
  child.stderr.on('data', (c) => {
    stderr += c.toString('utf8');
  });

  const gzip = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(destFile, { mode: 0o640 });

  const exitPromise = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `wp db export exited with ${code}`));
    });
  });

  await Promise.all([pipeline(child.stdout, gzip, out), exitPromise]);
}

async function importDbGzip(site, srcFile) {
  const child = spawnWpRaw(site, ['db', 'import', '-'], ['pipe', 'pipe', 'pipe']);
  let stderr = '';
  child.stderr.on('data', (c) => {
    stderr += c.toString('utf8');
  });

  const gunzip = zlib.createGunzip();
  const inp = fs.createReadStream(srcFile);

  const exitPromise = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `wp db import exited with ${code}`));
    });
  });

  await Promise.all([pipeline(inp, gunzip, child.stdin), exitPromise]);
}

async function archiveAsset(site, assetType, slug, destTarGz, onLine) {
  const { mode } = getConfig();
  if (mode === 'hestia') {
    await runHelper(['archive', site.user, site.domain, assetType, slug, destTarGz], { onLine });
    return;
  }

  const folder = assetType === 'plugin' ? 'plugins' : 'themes';
  const parentDir = path.join(site.path, 'wp-content', folder);
  if (!fs.existsSync(path.join(parentDir, slug))) {
    throw new Error(`Target folder not found: ${path.join(parentDir, slug)}`);
  }

  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-czf', destTarGz, '-C', parentDir, slug], { shell: false });
    let err = '';
    child.stderr.on('data', (c) => (err += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `tar exited ${code}`))));
  });
}

async function restoreAssetArchive(site, assetType, slug, srcTarGz, onLine) {
  const { mode } = getConfig();
  if (mode === 'hestia') {
    await runHelper(['restore-archive', site.user, site.domain, assetType, slug, srcTarGz], { onLine });
    return;
  }

  const folder = assetType === 'plugin' ? 'plugins' : 'themes';
  const parentDir = path.join(site.path, 'wp-content', folder);
  const targetDir = path.join(parentDir, slug);
  fs.rmSync(targetDir, { recursive: true, force: true });

  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', srcTarGz, '-C', parentDir], { shell: false });
    let err = '';
    child.stderr.on('data', (c) => (err += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `tar exited ${code}`))));
  });
}

export async function createManualSnapshot(site, { includeContent = true } = {}, onLine) {
  const dir = path.join(getBackupRoot(), site.domain);
  fs.mkdirSync(dir, { recursive: true });
  const ts = timestampSlug();

  const dbFile = path.join(dir, `${ts}_manual-db.sql.gz`);
  if (onLine) onLine(`Exporting database -> ${path.basename(dbFile)}...`);
  await exportDbGzip(site, dbFile);

  let archiveFile = '';
  if (includeContent) {
    archiveFile = path.join(dir, `${ts}_manual-wp-content.tar.gz`);
    if (onLine) onLine(`Archiving wp-content -> ${path.basename(archiveFile)}...`);
    if (getConfig().mode === 'hestia') {
      await runHelper(['archive-content', site.user, site.domain, archiveFile], { onLine });
    } else {
      await new Promise((resolve, reject) => {
        const child = spawn(
          'tar',
          ['-czf', archiveFile, '--exclude=wp-content/cache', '--exclude=wp-content/upgrade', '-C', site.path, 'wp-content'],
          { shell: false }
        );
        let err = '';
        child.stderr.on('data', (c) => (err += c.toString('utf8')));
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `tar exited ${code}`))));
      });
    }
  }

  const id = addSnapshot({
    domain: site.domain,
    action: 'manual-snapshot',
    asset_type: includeContent ? 'wp-content' : '',
    slug: includeContent ? 'wp-content' : '',
    db_file: dbFile,
    archive_file: archiveFile,
  });

  await pruneOldSnapshots(site.domain, onLine);
  return id;
}

export function removeSnapshotById(site, snapshotId) {
  const snap = getSnapshot(snapshotId);
  if (!snap || snap.domain !== site.domain) {
    const err = new Error('Snapshot not found for this domain');
    err.statusCode = 404;
    throw err;
  }
  if (snap.db_file && fs.existsSync(snap.db_file)) fs.rmSync(snap.db_file, { force: true });
  if (snap.archive_file && fs.existsSync(snap.archive_file)) fs.rmSync(snap.archive_file, { force: true });
  deleteSnapshot(snap.id);
}

export async function restoreSnapshot(site, snapshotId, { restoreDb = true, restoreFiles = true } = {}, onLine) {
  const snap = getSnapshot(snapshotId);
  if (!snap || snap.domain !== site.domain) {
    const err = new Error('Snapshot not found for this domain');
    err.statusCode = 404;
    throw err;
  }

  if (restoreFiles && snap.archive_file && fs.existsSync(snap.archive_file)) {
    if (snap.asset_type === 'wp-content') {
      if (onLine) onLine('Restoring wp-content files...');
      if (getConfig().mode === 'hestia') {
        await runHelper(['restore-content', site.user, site.domain, snap.archive_file], { onLine });
      } else {
        await new Promise((resolve, reject) => {
          const child = spawn('tar', ['-xzf', snap.archive_file, '-C', site.path], { shell: false });
          let err = '';
          child.stderr.on('data', (c) => (err += c.toString('utf8')));
          child.on('error', reject);
          child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `tar exited ${code}`))));
        });
      }
    } else {
      if (onLine) onLine(`Restoring ${snap.asset_type} '${snap.slug}' files...`);
      await restoreAssetArchive(site, snap.asset_type, snap.slug, snap.archive_file, onLine);
    }
  }

  if (restoreDb && snap.db_file && fs.existsSync(snap.db_file)) {
    if (onLine) onLine(`Restoring database from ${path.basename(snap.db_file)}...`);
    await importDbGzip(site, snap.db_file);
  }
}

export async function pruneOldSnapshots(domain, onLine) {
  const cutoff = Date.now() - getRetentionDays() * 86400 * 1000;
  const rows = listSnapshots(domain);
  let removed = 0;

  for (const row of rows) {
    if (new Date(row.created_at).getTime() < cutoff) {
      if (row.db_file && fs.existsSync(row.db_file)) fs.rmSync(row.db_file, { force: true });
      if (row.archive_file && fs.existsSync(row.archive_file)) fs.rmSync(row.archive_file, { force: true });
      deleteSnapshot(row.id);
      removed++;
    }
  }

  if (removed > 0 && onLine) {
    onLine(`Pruned ${removed} snapshot(s) older than ${getRetentionDays()} days.`);
  }
  return removed;
}
