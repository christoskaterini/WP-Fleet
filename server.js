import 'dotenv/config';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import bcrypt from 'bcryptjs';

import {
  assertKnownSite,
  createBlueprint,
  createUser,
  deleteBlueprint,
  deleteUser,
  getBlueprint,
  getDb,
  getMatrixAssets,
  getMatrixAssetsForUser,
  getSiteAssets,
  getSnapshot,
  getUserByUsername,
  initDb,
  listAuditLog,
  listAuditLogForUser,
  listBlueprints,
  listSites,
  listSitesForUser,
  listSnapshots,
  listStagingFor,
  listUsers,
  setSiteStagingOf,
  updateSiteUrlAndPath,
  updateUser,
} from './lib/db.js';
import {
  assertAssetType,
  assertDomainFormat,
  assertHestiaUser,
  assertSlug,
  assertZipFilename,
} from './lib/validate.js';
import { getConfig, runHelper, runWp, spawnWpRaw } from './lib/wpcli.js';
import { refreshSiteMetadata, scanAllSites, scanSitesForUser } from './lib/discovery.js';
import { checkSiteHealth } from './lib/health.js';
import {
  createManualSnapshot,
  createPreUpdateSnapshot,
  removeSnapshotById,
  restoreSnapshot,
} from './lib/backup.js';
import { enqueueJob, jobBus, listJobs } from './lib/jobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
const PORT = Number(process.env.PORT || 3100);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(__dirname, process.env.DATA_DIR || './data');
const REPO_DIR = process.env.REPO_DIR || '/opt/wp-repo';
const COOKIE_SECRET = process.env.COOKIE_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const SESSION_COOKIE = 'wpfleet_session';

// Ensure Vault subdirectories exist
fs.mkdirSync(path.join(REPO_DIR, 'plugins'), { recursive: true });
fs.mkdirSync(path.join(REPO_DIR, 'themes'), { recursive: true });

initDb(DATA_DIR);

const app = Fastify({ logger: true });

await app.register(fastifyCookie);
await app.register(fastifyRateLimit, { global: false });
await app.register(fastifyMultipart, {
  limits: {
    fileSize: 150 * 1024 * 1024, // 150 MB
    files: 1,
  },
});
await app.register(fastifyStatic, {
  root: path.join(__dirname, 'public'),
  prefix: '/',
});

// --- Session Token Helpers ---
function signSession({ username, role, hestiaUser = '' }) {
  const payload = Buffer.from(
    JSON.stringify({ u: username, role, h: hestiaUser, exp: Date.now() + 7 * 86400 * 1000 })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', COOKIE_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', COOKIE_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function assertAdmin(req) {
  if (req.user?.role !== 'admin') {
    const err = new Error('Forbidden: Master Admin access required');
    err.statusCode = 403;
    throw err;
  }
}

function assertSiteAccess(req, domain) {
  const site = assertKnownSite(domain);
  if (req.user?.role !== 'admin' && site.user !== req.user?.hestiaUser) {
    const err = new Error('Forbidden: you do not have access to this site');
    err.statusCode = 403;
    throw err;
  }
  return site;
}

// --- Auth Guard for /api/* ---
app.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/api/')) return;
  if (req.url === '/api/auth/login' || req.url === '/api/healthz') return;

  const session = verifySession(req.cookies?.[SESSION_COOKIE]);
  if (!session) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  req.user = {
    username: session.u,
    role: session.role || 'admin',
    hestiaUser: session.h || '',
  };
});

app.addHook('onSend', async (_req, reply) => {
  reply.header('X-Robots-Tag', 'noindex, nofollow');
});

app.get('/api/healthz', async () => ({ ok: true, version: APP_VERSION, mode: getConfig().mode }));

let versionCache = { checkedAt: 0, latest: APP_VERSION };

function compareSemver(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

app.get('/api/system/version', async (req) => {
  const repo = String(process.env.GITHUB_REPO || '').trim();
  if (repo && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo) && Date.now() - versionCache.checkedAt > 900000) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${repo}/main/package.json`, {
        headers: { 'User-Agent': 'wp-fleet-updater/1.0' },
      });
      if (res.ok) {
        const pkg = await res.json();
        if (pkg.version) versionCache = { checkedAt: Date.now(), latest: pkg.version };
      }
    } catch {
      // ignore offline/network errors
    }
  }
  const updateAvailable = compareSemver(versionCache.latest, APP_VERSION) > 0;
  return {
    current: APP_VERSION,
    latest: versionCache.latest,
    updateAvailable: req.user.role === 'admin' ? updateAvailable : false,
    repo,
  };
});

app.post('/api/system/update', async (req) => {
  assertAdmin(req);
  if (!fs.existsSync(path.join(__dirname, '.git'))) {
    const err = new Error('Not a git checkout — clone from GitHub to enable 1-click self-update');
    err.statusCode = 400;
    throw err;
  }
  const runCmd = (cmd, args) =>
    new Promise((resolve, reject) => {
      const c = spawn(cmd, args, { cwd: __dirname, shell: false });
      let out = '';
      c.stdout.on('data', (d) => (out += d.toString()));
      c.stderr.on('data', (d) => (out += d.toString()));
      c.on('error', reject);
      c.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(out.trim() || `${cmd} exited ${code}`))));
    });

  const gitOut = await runCmd('git', ['pull', '--ff-only']);
  await runCmd('npm', ['ci', '--omit=dev']);
  setTimeout(() => process.exit(0), 1000).unref();
  return { ok: true, output: gitOut, restarting: true };
});

app.post(
  '/api/auth/login',
  {
    config: {
      rateLimit: {
        max: 8,
        timeWindow: '1 minute',
      },
    },
  },
  async (req, reply) => {
    const { username, password } = req.body || {};
    const cleanUser = String(username || '').trim();
    if (!cleanUser || typeof password !== 'string') {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    // 1. Check DB users first
    const dbUser = getUserByUsername(cleanUser);
    let authUser = null;
    if (dbUser) {
      if (!dbUser.active) {
        return reply.code(403).send({ error: 'Account disabled' });
      }
      if (await bcrypt.compare(password, dbUser.pass_hash)) {
        authUser = {
          username: dbUser.username,
          role: dbUser.role,
          hestiaUser: dbUser.hestia_user || '',
        };
      }
    } else {
      // 2. Fallback to .env bootstrap Master Admin
      const expectedUser = process.env.ADMIN_USER || 'admin';
      const expectedHash = process.env.ADMIN_PASS_HASH || '';
      if (!expectedHash) {
        return reply.code(500).send({ error: 'ADMIN_PASS_HASH is not configured in .env' });
      }
      if (cleanUser === expectedUser && (await bcrypt.compare(password, expectedHash))) {
        authUser = { username: expectedUser, role: 'admin', hestiaUser: '' };
      }
    }

    if (!authUser) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    const token = signSession(authUser);
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: COOKIE_SECURE,
      maxAge: 7 * 86400,
    });
    return { ok: true, ...authUser };
  }
);

app.post('/api/auth/logout', async (_req, reply) => {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  return { ok: true };
});

function assertStrongPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8 || !/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) {
    const err = new Error('Password must be at least 8 characters with letters and numbers');
    err.statusCode = 400;
    throw err;
  }
}

app.get('/api/auth/me', async (req) => ({
  user: req.user.username,
  role: req.user.role,
  hestiaUser: req.user.hestiaUser,
  mode: getConfig().mode,
}));

app.post('/api/auth/change-password', async (req, reply) => {
  const { currentPassword, newPassword } = req.body || {};
  assertStrongPassword(newPassword);

  const dbUser = getUserByUsername(req.user.username);
  if (dbUser) {
    if (typeof currentPassword !== 'string' || !(await bcrypt.compare(currentPassword, dbUser.pass_hash))) {
      return reply.code(401).send({ error: 'Current password is incorrect' });
    }
    const pass_hash = await bcrypt.hash(newPassword, 10);
    updateUser(dbUser.id, { pass_hash });
    return { ok: true };
  }

  // Bootstrap .env admin: verify against ADMIN_PASS_HASH, then store override in users table
  const expectedHash = process.env.ADMIN_PASS_HASH || '';
  if (!expectedHash || typeof currentPassword !== 'string' || !(await bcrypt.compare(currentPassword, expectedHash))) {
    return reply.code(401).send({ error: 'Current password is incorrect' });
  }
  const pass_hash = await bcrypt.hash(newPassword, 10);
  createUser({ username: req.user.username, pass_hash, role: 'admin', hestia_user: '' });
  return { ok: true };
});

// --- Helper: Flush WP + Redis + Nginx Microcache ---
async function flushSiteCaches(site, onLine) {
  if (onLine) onLine(`Flushing WP/Redis object cache for ${site.domain}...`);
  await runWp(site, ['cache', 'flush'], { onLine }).catch((e) => {
    if (onLine) onLine(`cache flush warning: ${e.message}`, 'stderr');
  });

  if (getConfig().mode === 'hestia') {
    if (onLine) onLine(`Purging Nginx microcache for ${site.domain}...`);
    await runHelper(['purge-cache', site.domain], { onLine }).catch((e) => {
      if (onLine) onLine(`microcache purge warning: ${e.message}`, 'stderr');
    });
  }
}

// --- Sites & Discovery ---
app.get('/api/sites', async (req) => {
  const sites =
    req.user.role === 'admin' ? listSites() : listSitesForUser(req.user.hestiaUser);
  return { sites };
});

app.post('/api/sites/scan', async (req) => {
  const isAdmin = req.user.role === 'admin';
  const hestiaUser = req.user.hestiaUser;
  const jobId = enqueueJob({
    domain: isAdmin ? 'global' : `user:${hestiaUser}`,
    action: 'scan',
    label: isAdmin ? 'Discover & scan all WordPress sites' : `Scan sites for ${hestiaUser}`,
    fn: async (log) => {
      const count = isAdmin ? await scanAllSites(log) : await scanSitesForUser(hestiaUser, log);
      log(`Scan complete: ${count} site(s) indexed.`);
    },
  });
  return { jobId };
});

app.post('/api/sites/health-all', async (req) => {
  const sites =
    req.user.role === 'admin' ? listSites() : listSitesForUser(req.user.hestiaUser);
  const results = await Promise.all(
    sites.map(async (s) => ({
      domain: s.domain,
      ...(await checkSiteHealth(s)),
    }))
  );
  return { results };
});

app.post('/api/sites/:domain/health', async (req) => {
  const domain = assertDomainFormat(req.params.domain);
  const site = assertSiteAccess(req, domain);
  const result = await checkSiteHealth(site);
  return { domain, ...result };
});

app.get('/api/sites/:domain/assets', async (req) => {
  const domain = assertDomainFormat(req.params.domain);
  const site = assertSiteAccess(req, domain);
  const assets = getSiteAssets(domain);
  return { site, assets };
});

// --- Site Info, URL/Path Settings & DB Viewer ---
app.get('/api/sites/:domain/info', async (req) => {
  const domain = assertDomainFormat(req.params.domain);
  const site = assertSiteAccess(req, domain);

  const [dbName, dbUser, dbHost, dbPass, prefix, homeUrl, wpDebugRes, maintRes] = await Promise.all([
    runWp(site, ['config', 'get', 'DB_NAME']).catch(() => ({ stdout: '' })),
    runWp(site, ['config', 'get', 'DB_USER']).catch(() => ({ stdout: '' })),
    runWp(site, ['config', 'get', 'DB_HOST']).catch(() => ({ stdout: '' })),
    runWp(site, ['config', 'get', 'DB_PASSWORD']).catch(() => ({ stdout: '' })),
    runWp(site, ['config', 'get', 'table_prefix']).catch(() => ({ stdout: 'wp_' })),
    runWp(site, ['option', 'get', 'home']).catch(() => ({ stdout: site.site_url })),
    runWp(site, ['config', 'get', 'WP_DEBUG']).catch(() => ({ stdout: '0' })),
    runWp(site, ['maintenance-mode', 'status']).catch(() => ({ stdout: '' })),
  ]);

  const debugVal = wpDebugRes.stdout.trim().toLowerCase();
  const wpDebug = debugVal === '1' || debugVal === 'true';
  const maintenance = maintRes.stdout.toLowerCase().includes('is active');

  return {
    site,
    db: {
      name: dbName.stdout.trim(),
      user: dbUser.stdout.trim(),
      host: dbHost.stdout.trim(),
      password: req.user.role === 'admin' ? dbPass.stdout.trim() : '',
      prefix: prefix.stdout.trim() || 'wp_',
    },
    homeUrl: homeUrl.stdout.trim() || site.site_url,
    wpDebug,
    maintenance,
    stagingSites: listStagingFor(domain),
  };
});

app.post('/api/sites/:domain/update-settings', async (req) => {
  const domain = assertDomainFormat(req.params.domain);
  const site = assertSiteAccess(req, domain);
  const { siteUrl, sitePath, runSearchReplace = false } = req.body || {};

  const cleanUrl = String(siteUrl || site.site_url).trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/.test(cleanUrl)) {
    const err = new Error('Website URL must start with http:// or https://');
    err.statusCode = 400;
    throw err;
  }
  const cleanPath =
    req.user.role === 'admin' ? String(sitePath || site.path).trim() : site.path;
  if (!cleanPath || cleanPath.includes('..')) {
    const err = new Error('Invalid website path');
    err.statusCode = 400;
    throw err;
  }

  const jobId = enqueueJob({
    domain,
    action: 'site:update-settings',
    label: `Update URL/Path for ${domain}`,
    fn: async (log) => {
      const oldUrl = (site.site_url || '').replace(/\/+$/, '');
      if (cleanPath !== site.path) {
        updateSiteUrlAndPath(domain, { site_url: cleanUrl, path: cleanPath });
        site.path = cleanPath;
      }
      if (cleanUrl !== oldUrl) {
        if (runSearchReplace && oldUrl) {
          await runWp(site, ['search-replace', oldUrl, cleanUrl, '--all-tables'], { onLine: log });
        }
        await runWp(site, ['option', 'update', 'siteurl', cleanUrl], { onLine: log });
        await runWp(site, ['option', 'update', 'home', cleanUrl], { onLine: log });
        updateSiteUrlAndPath(domain, { site_url: cleanUrl, path: cleanPath });
      }
      await flushSiteCaches(site, log);
      await refreshSiteMetadata(site, log);
    },
  });
  return { jobId };
});

app.get('/api/sites/:domain/db/tables', async (req) => {
  const domain = assertDomainFormat(req.params.domain);
  const site = assertSiteAccess(req, domain);
  const res = await runWp(site, ['db', 'query', 'SHOW TABLE STATUS;']);
  const lines = (res.stdout || '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return { tables: [] };
  const headers = lines[0].split('\t');
  const idxName = headers.indexOf('Name');
  const idxRows = headers.indexOf('Rows');
  const idxData = headers.indexOf('Data_length');
  const idxIdx = headers.indexOf('Index_length');
  const idxEng = headers.indexOf('Engine');

  const tables = lines.slice(1).map((line) => {
    const cols = line.split('\t');
    const bytes = Number(cols[idxData] || 0) + Number(cols[idxIdx] || 0);
    return {
      name: cols[idxName] || '',
      rows: Number(cols[idxRows] || 0),
      sizeKb: Math.round((bytes / 1024) * 10) / 10,
      engine: cols[idxEng] || '',
    };
  });
  return { tables };
});

app.get('/api/sites/:domain/db/rows', async (req) => {
  const domain = assertDomainFormat(req.params.domain);
  const site = assertSiteAccess(req, domain);
  const table = String(req.query.table || '').trim();
  if (!/^[a-zA-Z0-9_]+$/.test(table)) {
    const err = new Error('Invalid table name');
    err.statusCode = 400;
    throw err;
  }
  const offset = Math.max(0, Math.floor(Number(req.query.offset || 0)) || 0);
  const limit = Math.min(500, Math.max(10, Math.floor(Number(req.query.limit || 100)) || 100));

  const res = await runWp(site, [
    'db',
    'query',
    `SELECT * FROM \`${table}\` LIMIT ${limit + 1} OFFSET ${offset};`,
  ]);
  const lines = (res.stdout || '').split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return { columns: [], rows: [], hasMore: false };
  const columns = lines[0].split('\t');
  const allRows = lines.slice(1).map((line) => line.split('\t'));
  const hasMore = allRows.length > limit;
  const rows = hasMore ? allRows.slice(0, limit) : allRows;
  return { columns, rows, hasMore, nextOffset: offset + rows.length };
});

// --- Staging System ---
async function pipeDbBetweenSites(srcSite, dstSite, log) {
  log(`Cloning database from ${srcSite.domain} -> ${dstSite.domain}...`);
  const exp = spawnWpRaw(srcSite, ['db', 'export', '-'], ['ignore', 'pipe', 'pipe']);
  const imp = spawnWpRaw(dstSite, ['db', 'import', '-'], ['pipe', 'pipe', 'pipe']);
  let expErr = '';
  let impErr = '';
  exp.stderr.on('data', (c) => (expErr += c.toString('utf8')));
  imp.stderr.on('data', (c) => (impErr += c.toString('utf8')));

  exp.stdout.pipe(imp.stdin);

  await Promise.all([
    new Promise((res, rej) => exp.on('close', (c) => (c === 0 ? res() : rej(new Error(expErr || `export ${c}`))))),
    new Promise((res, rej) => imp.on('close', (c) => (c === 0 ? res() : rej(new Error(impErr || `import ${c}`))))),
  ]);
}

app.post('/api/sites/:domain/staging/create', async (req) => {
  const domain = assertDomainFormat(req.params.domain);
  const liveSite = assertSiteAccess(req, domain);
  const stgDomain = assertDomainFormat(req.body?.stagingDomain || `staging.${domain}`);

  if (stgDomain === domain) {
    const err = new Error('Staging domain must differ from live domain');
    err.statusCode = 400;
    throw err;
  }

  const jobId = enqueueJob({
    domain,
    action: 'staging:create',
    label: `Create staging ${stgDomain} from ${domain}`,
    fn: async (log) => {
      const slug = stgDomain.replace(/[^a-zA-Z0-9]/g, '').slice(0, 14);
      const dbName = `${liveSite.user.slice(0, 8)}_stg_${slug}`.slice(0, 32);
      const dbUser = dbName.slice(0, 16);
      const dbPass = crypto.randomBytes(12).toString('hex');

      log(`Provisioning staging ${stgDomain} (DB: ${dbName})...`);
      await runHelper(['create-staging', liveSite.user, domain, stgDomain, dbName, dbUser, dbPass], { onLine: log });

      const stgPath = `/home/${liveSite.user}/web/${stgDomain}/public_html`;
      const stgSite = { user: liveSite.user, domain: stgDomain, path: stgPath, php_version: liveSite.php_version };

      await runWp(stgSite, ['config', 'set', 'DB_NAME', dbName], { onLine: log });
      await runWp(stgSite, ['config', 'set', 'DB_USER', dbUser], { onLine: log });
      await runWp(stgSite, ['config', 'set', 'DB_PASSWORD', dbPass], { onLine: log });
      await runWp(stgSite, ['config', 'set', 'DB_HOST', '127.0.0.1'], { onLine: log });
      await runWp(stgSite, ['config', 'set', 'WP_CACHE', 'false', '--raw'], { onLine: log }).catch(() => {});
      await runWp(stgSite, ['config', 'set', 'WP_CACHE_KEY_SALT', `stg_${slug}_${crypto.randomBytes(4).toString('hex')}`], { onLine: log }).catch(() => {});

      await pipeDbBetweenSites(liveSite, stgSite, log);

      const liveUrl = (liveSite.site_url || `https://${domain}`).replace(/\/+$/, '');
      const proto = liveUrl.startsWith('https://') && getConfig().mode === 'hestia' ? 'http://' : liveUrl.match(/^https?:\/\//)?.[0] || 'http://';
      const stgUrl = `${proto}${stgDomain}`;

      await runWp(stgSite, ['search-replace', liveUrl, stgUrl, '--all-tables'], { onLine: log });
      await runWp(stgSite, ['option', 'update', 'blog_public', '0'], { onLine: log }).catch(() => {});
      await runWp(stgSite, ['cache', 'flush'], { onLine: log }).catch(() => {});

      await refreshSiteMetadata(stgSite, log);
      setSiteStagingOf(stgDomain, domain);
      await checkSiteHealth({ ...stgSite, site_url: stgUrl });
      log(`Staging ready: ${stgUrl}`);
    },
  });

  return { jobId };
});

app.post('/api/sites/:domain/staging/push', async (req) => {
  const stgDomain = assertDomainFormat(req.params.domain);
  const stgSite = assertSiteAccess(req, stgDomain);
  if (!stgSite.staging_of) {
    const err = new Error('This site is not marked as a staging site');
    err.statusCode = 400;
    throw err;
  }
  const liveSite = assertKnownSite(stgSite.staging_of);
  const mode = req.body?.mode === 'full' ? 'full' : 'files';

  const jobId = enqueueJob({
    domain: liveSite.domain,
    action: `staging:push:${mode}`,
    label: `Push staging ${stgDomain} (${mode}) → live ${liveSite.domain}`,
    fn: async (log) => {
      await createPreUpdateSnapshot(
        liveSite,
        { action: `pre-staging-push-${mode}`, assetType: 'wp-content' },
        log
      );
      await runWp(liveSite, ['maintenance-mode', 'activate'], { onLine: log }).catch(() => {});
      try {
        log(`Syncing files from ${stgDomain} -> ${liveSite.domain}...`);
        await runHelper(['push-staging', liveSite.user, stgDomain, liveSite.domain], { onLine: log });

        if (mode === 'full') {
          await pipeDbBetweenSites(stgSite, liveSite, log);
          const stgUrl = (stgSite.site_url || `http://${stgDomain}`).replace(/\/+$/, '');
          const liveUrl = (liveSite.site_url || `https://${liveSite.domain}`).replace(/\/+$/, '');
          await runWp(liveSite, ['search-replace', stgUrl, liveUrl, '--all-tables'], { onLine: log });
          await runWp(liveSite, ['option', 'update', 'blog_public', '1'], { onLine: log }).catch(() => {});
        }
      } finally {
        await runWp(liveSite, ['maintenance-mode', 'deactivate'], { onLine: log }).catch(() => {});
      }

      await flushSiteCaches(liveSite, log);
      await refreshSiteMetadata(liveSite, log);
      const health = await checkSiteHealth(liveSite);
      log(`Live site health: HTTP ${health.http_status} (${health.ttfb_ms} ms)`);
    },
  });
  return { jobId };
});

app.delete('/api/sites/:domain/staging', async (req) => {
  const stgDomain = assertDomainFormat(req.params.domain);
  const stgSite = assertSiteAccess(req, stgDomain);
  if (!stgSite.staging_of) {
    const err = new Error('Only staging sites can be deleted here');
    err.statusCode = 400;
    throw err;
  }

  const dbRes = await runWp(stgSite, ['config', 'get', 'DB_NAME']).catch(() => ({ stdout: '' }));
  const dbName = dbRes.stdout.trim() || 'none';
  await runHelper(['delete-staging', stgSite.user, stgDomain, dbName]);
  getDb().prepare('DELETE FROM sites WHERE domain = ?').run(stgDomain);
  return { ok: true };
});

// --- Self-Cleaning One-Time Magic Login ---
app.post('/api/sites/:domain/magic-login', async (req) => {
  const domain = assertDomainFormat(req.params.domain);
  const site = assertSiteAccess(req, domain);

  let adminId = req.body?.userId ? String(req.body.userId).trim() : '';
  if (adminId) {
    if (!/^\d+$/.test(adminId)) {
      const err = new Error('Invalid userId');
      err.statusCode = 400;
      throw err;
    }
  } else {
    const userRes = await runWp(site, [
      'user',
      'list',
      '--role=administrator',
      '--field=ID',
      '--orderby=ID',
      '--order=ASC',
    ]);
    adminId = (userRes.stdout || '').split(/\r?\n/)[0]?.trim();
  }
  if (!adminId || !/^\d+$/.test(adminId)) {
    const err = new Error('No administrator user found on this site');
    err.statusCode = 404;
    throw err;
  }

  const token = crypto.randomBytes(24).toString('hex');
  const transientKey = `wpfleet_sso_${token}`;
  await runWp(site, ['transient', 'set', transientKey, adminId, '60']);

  const muFilename = `wpfleet-sso-${token.slice(0, 12)}.php`;
  const phpCode = `<?php
if (!defined('ABSPATH')) exit;
add_action('init', function () {
  if (empty($_GET['wpfleet_sso'])) return;
  $tok = preg_replace('/[^a-f0-9]/', '', (string) $_GET['wpfleet_sso']);
  if ($tok !== '${token}') return;
  $key = 'wpfleet_sso_' . $tok;
  $uid = get_transient($key);
  delete_transient($key);
  @unlink(__FILE__);
  if ($uid && is_numeric($uid)) {
    wp_set_current_user((int) $uid);
    wp_set_auth_cookie((int) $uid, false);
    wp_safe_redirect(admin_url());
    exit;
  }
}, 1);
`;

  const { mode } = getConfig();
  if (mode === 'hestia') {
    const b64 = Buffer.from(phpCode, 'utf8').toString('base64');
    await runHelper(['write-sso', site.user, site.domain, muFilename, b64]);
  } else {
    const muDir = path.join(site.path, 'wp-content', 'mu-plugins');
    fs.mkdirSync(muDir, { recursive: true });
    fs.writeFileSync(path.join(muDir, muFilename), phpCode, 'utf8');
  }

  // Fallback cleanup after 65s if the user never opens the tab
  setTimeout(() => {
    if (mode === 'hestia') {
      runHelper(['delete-sso', site.user, site.domain, muFilename]).catch(() => {});
    } else {
      fs.rmSync(path.join(site.path, 'wp-content', 'mu-plugins', muFilename), { force: true });
    }
  }, 65000).unref();

  const base = (site.site_url || `https://${site.domain}`).replace(/\/+$/, '');
  return { url: `${base}/?wpfleet_sso=${token}` };
});

// --- Updates (with Pre-Update Snapshot + Cache Purge + Health Check) ---
app.post('/api/sites/:domain/update', async (req) => {
  const domain = assertDomainFormat(req.params.domain);
  const site = assertSiteAccess(req, domain);
  const { target, slug } = req.body || {};

  if (!['core', 'plugin', 'theme', 'all-plugins', 'all-themes'].includes(target)) {
    const err = new Error('Invalid update target');
    err.statusCode = 400;
    throw err;
  }

  const safeSlug = slug ? assertSlug(slug) : '';
  const jobId = enqueueJob({
    domain,
    action: `update:${target}`,
    label: safeSlug ? `Update ${target} ${safeSlug} on ${domain}` : `Update ${target} on ${domain}`,
    fn: async (log) => {
      await createPreUpdateSnapshot(
        site,
        {
          action: `pre-update-${target}`,
          assetType:
            target === 'plugin' || target === 'theme'
              ? target
              : target === 'all-plugins' || target === 'all-themes'
                ? 'wp-content'
                : '',
          slug: safeSlug,
        },
        log
      );

      if (target === 'core') {
        await runWp(site, ['core', 'update'], { onLine: log });
        await runWp(site, ['core', 'update-db'], { onLine: log }).catch(() => {});
      } else if (target === 'plugin') {
        await runWp(site, ['plugin', 'update', safeSlug], { onLine: log });
      } else if (target === 'theme') {
        await runWp(site, ['theme', 'update', safeSlug], { onLine: log });
      } else if (target === 'all-plugins') {
        await runWp(site, ['plugin', 'update', '--all'], { onLine: log });
      } else if (target === 'all-themes') {
        await runWp(site, ['theme', 'update', '--all'], { onLine: log });
      }

      await flushSiteCaches(site, log);
      await refreshSiteMetadata(site, log);
      const health = await checkSiteHealth(site);
      log(`Health check: HTTP ${health.http_status} (${health.ttfb_ms} ms)`);
    },
  });

  return { jobId };
});

// --- Plugin & Theme Actions ---
app.post('/api/sites/:domain/plugin-action', async (req) => {
  const domain = assertDomainFormat(req.params.domain);
  const site = assertSiteAccess(req, domain);
  const { action, slug } = req.body || {};
  const safeSlug = assertSlug(slug);

  if (!['activate', 'deactivate', 'delete', 'install'].includes(action)) {
    const err = new Error('Invalid plugin action');
    err.statusCode = 400;
    throw err;
  }

  const jobId = enqueueJob({
    domain,
    action: `plugin:${action}`,
    label: `${action} plugin ${safeSlug} on ${domain}`,
    fn: async (log) => {
      const args =
        action === 'install'
          ? ['plugin', 'install', safeSlug, '--activate']
          : ['plugin', action, safeSlug];
      await runWp(site, args, { onLine: log });
      await flushSiteCaches(site, log);
      await refreshSiteMetadata(site, log);
    },
  });

  return { jobId };
});

app.post('/api/sites/:domain/theme-action', async (req) => {
  const domain = assertDomainFormat(req.params.domain);
  const site = assertSiteAccess(req, domain);
  const { action, slug } = req.body || {};
  const safeSlug = assertSlug(slug);

  if (!['activate', 'delete', 'install'].includes(action)) {
    const err = new Error('Invalid theme action');
    err.statusCode = 400;
    throw err;
  }

  const jobId = enqueueJob({
    domain,
    action: `theme:${action}`,
    label: `${action} theme ${safeSlug} on ${domain}`,
    fn: async (log) => {
      const args =
        action === 'install'
          ? ['theme', 'install', safeSlug, '--activate']
          : ['theme', action, safeSlug];
      await runWp(site, args, { onLine: log });
      await flushSiteCaches(site, log);
      await refreshSiteMetadata(site, log);
    },
  });

  return { jobId };
});

async function searchWpOrgRepo(type, q) {
  const endpoint =
    type === 'plugin'
      ? `https://api.wordpress.org/plugins/info/1.2/?action=query_plugins&request[search]=${encodeURIComponent(q)}&request[per_page]=12&request[fields][icons]=1&request[fields][short_description]=1`
      : `https://api.wordpress.org/themes/info/1.2/?action=query_themes&request[search]=${encodeURIComponent(q)}&request[per_page]=12&request[fields][screenshot_url]=1&request[fields][short_description]=1`;

  const res = await fetch(endpoint, { headers: { 'User-Agent': 'wp-fleet/1.0' } });
  if (!res.ok) throw new Error(`WordPress.org API returned HTTP ${res.status}`);
  const data = await res.json();
  const raw = type === 'plugin' ? data.plugins : data.themes;
  return (Array.isArray(raw) ? raw : []).map((i) => ({
    name: i.name,
    slug: i.slug,
    version: i.version || '',
    icon:
      type === 'plugin'
        ? i.icons?.['1x'] || i.icons?.['2x'] || i.icons?.svg || i.icons?.default || ''
        : i.screenshot_url || '',
    description: i.short_description || '',
  }));
}

app.get('/api/search-repo', async (req) => {
  const type = assertAssetType(req.query.type || 'plugin');
  const q = String(req.query.q || '').trim().slice(0, 64);
  if (!q) return { items: [] };
  return { items: await searchWpOrgRepo(type, q) };
});

const pluginIconCache = new Map();

async function getPluginIcon(slug) {
  if (pluginIconCache.has(slug)) return pluginIconCache.get(slug);
  try {
    const res = await fetch(
      `https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request[slug]=${encodeURIComponent(slug)}&request[fields][icons]=1`,
      { headers: { 'User-Agent': 'wp-fleet/1.0' } }
    );
    if (!res.ok) {
      pluginIconCache.set(slug, '');
      return '';
    }
    const data = await res.json();
    const icon = data.icons?.['1x'] || data.icons?.['2x'] || data.icons?.svg || data.icons?.default || '';
    pluginIconCache.set(slug, icon);
    return icon;
  } catch {
    return '';
  }
}

app.get('/api/known-plugins', async (req) => {
  const rows =
    req.user.role === 'admin'
      ? getMatrixAssets('plugin')
      : getMatrixAssetsForUser('plugin', req.user.hestiaUser);
  const seen = new Map();
  for (const r of rows) {
    if (!seen.has(r.slug)) seen.set(r.slug, { slug: r.slug, name: r.name });
  }
  const items = await Promise.all(
    Array.from(seen.values()).map(async (p) => ({
      ...p,
      icon: await getPluginIcon(p.slug),
    }))
  );
  return { items };
});

app.get('/api/sites/:domain/search-repo', async (req) => {
  const domain = assertDomainFormat(req.params.domain);
  assertSiteAccess(req, domain);
  const type = assertAssetType(req.query.type || 'plugin');
  const q = String(req.query.q || '').trim().slice(0, 64);
  if (!q) return { items: [] };
  return { items: await searchWpOrgRepo(type, q) };
});

// --- Cross-Site Matrix ---
app.get('/api/matrix', async (req) => {
  const type = assertAssetType(req.query.type || 'plugin');
  const rows =
    req.user.role === 'admin'
      ? getMatrixAssets(type)
      : getMatrixAssetsForUser(type, req.user.hestiaUser);
  const grouped = new Map();

  for (const r of rows) {
    if (!grouped.has(r.slug)) {
      grouped.set(r.slug, {
        slug: r.slug,
        name: r.name,
        sites: [],
        updatesAvailable: 0,
      });
    }
    const g = grouped.get(r.slug);
    g.sites.push({
      domain: r.domain,
      user: r.user,
      status: r.status,
      version: r.version,
      update_version: r.update_version,
    });
    if (r.update_version) g.updatesAvailable++;
  }

  return { items: Array.from(grouped.values()) };
});

app.post('/api/matrix/bulk-update', async (req) => {
  const { type, slug, domains } = req.body || {};
  const safeType = assertAssetType(type);
  const safeSlug = assertSlug(slug);
  if (!Array.isArray(domains) || domains.length === 0) {
    const err = new Error('Select at least one domain');
    err.statusCode = 400;
    throw err;
  }

  const jobIds = [];
  for (const rawDomain of domains) {
    const domain = assertDomainFormat(rawDomain);
    const site = assertSiteAccess(req, domain);
    const jobId = enqueueJob({
      domain,
      action: `bulk-update:${safeType}`,
      label: `Bulk update ${safeType} ${safeSlug} on ${domain}`,
      fn: async (log) => {
        await createPreUpdateSnapshot(
          site,
          { action: `pre-bulk-${safeType}`, assetType: safeType, slug: safeSlug },
          log
        );
        await runWp(site, [safeType, 'update', safeSlug], { onLine: log });
        await flushSiteCaches(site, log);
        await refreshSiteMetadata(site, log);
        const health = await checkSiteHealth(site);
        log(`Health check: HTTP ${health.http_status} (${health.ttfb_ms} ms)`);
      },
    });
    jobIds.push(jobId);
  }
  return { jobIds };
});

// --- Pro ZIP Vault (2 separate folders: plugins & themes) ---
function listVaultFolder(type) {
  const folder = type === 'plugin' ? 'plugins' : 'themes';
  const dir = path.join(REPO_DIR, folder);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.zip'))
    .map((d) => {
      const stat = fs.statSync(path.join(dir, d.name));
      return {
        filename: d.name,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => a.filename.localeCompare(b.filename));
}

app.get('/api/vault', async (req) => {
  assertAdmin(req);
  return {
    plugins: listVaultFolder('plugin'),
    themes: listVaultFolder('theme'),
  };
});

app.post('/api/vault/upload', async (req, reply) => {
  assertAdmin(req);
  const type = assertAssetType(req.query.type);
  const file = await req.file();
  if (!file) {
    return reply.code(400).send({ error: 'No file uploaded' });
  }

  const safeName = assertZipFilename(path.basename(file.filename));
  const buf = await file.toBuffer();
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    return reply.code(400).send({ error: 'Invalid ZIP file (missing PK header)' });
  }

  const folder = type === 'plugin' ? 'plugins' : 'themes';
  const dest = path.join(REPO_DIR, folder, safeName);
  fs.writeFileSync(dest, buf, { mode: 0o644 });
  return { ok: true, type, filename: safeName, size: buf.length };
});

app.delete('/api/vault/:type/:filename', async (req) => {
  assertAdmin(req);
  const type = assertAssetType(req.params.type);
  const filename = assertZipFilename(req.params.filename);
  const folder = type === 'plugin' ? 'plugins' : 'themes';
  const target = path.join(REPO_DIR, folder, filename);
  fs.rmSync(target, { force: true });
  return { ok: true };
});

app.post('/api/vault/deploy', async (req) => {
  assertAdmin(req);
  const { type, filename, domains } = req.body || {};
  const safeType = assertAssetType(type);
  const safeName = assertZipFilename(filename);
  const folder = safeType === 'plugin' ? 'plugins' : 'themes';
  const zipPath = path.join(REPO_DIR, folder, safeName);

  if (!fs.existsSync(zipPath)) {
    const err = new Error(`ZIP not found: ${safeName}`);
    err.statusCode = 404;
    throw err;
  }
  if (!Array.isArray(domains) || domains.length === 0) {
    const err = new Error('Select at least one domain');
    err.statusCode = 400;
    throw err;
  }

  const jobIds = [];
  for (const rawDomain of domains) {
    const domain = assertDomainFormat(rawDomain);
    const site = assertSiteAccess(req, domain);
    const jobId = enqueueJob({
      domain,
      action: `vault-deploy:${safeType}`,
      label: `Deploy ${safeName} (${safeType}) to ${domain}`,
      fn: async (log) => {
        await runWp(site, [safeType, 'install', zipPath, '--activate', '--force'], {
          onLine: log,
        });
        await flushSiteCaches(site, log);
        await refreshSiteMetadata(site, log);
        const health = await checkSiteHealth(site);
        log(`Health check: HTTP ${health.http_status} (${health.ttfb_ms} ms)`);
      },
    });
    jobIds.push(jobId);
  }
  return { jobIds };
});

// --- Blueprints (Plugin & Theme Bundles) ---
app.get('/api/blueprints', async (req) => {
  const owner = req.user.role === 'admin' ? null : req.user.username;
  return { blueprints: listBlueprints(owner) };
});

app.post('/api/blueprints', async (req) => {
  const isAdmin = req.user.role === 'admin';
  const { name, plugins = [], vaultPlugins = [], vaultTheme = '' } = req.body || {};
  const cleanName = String(name || '').trim().slice(0, 80);
  if (!cleanName) {
    const err = new Error('Blueprint name is required');
    err.statusCode = 400;
    throw err;
  }
  const safePlugins = (Array.isArray(plugins) ? plugins : [])
    .map((s) => String(s).trim())
    .filter(Boolean)
    .map(assertSlug);
  const safeVaultPlugins = isAdmin
    ? (Array.isArray(vaultPlugins) ? vaultPlugins : [])
        .map((s) => String(s).trim())
        .filter(Boolean)
        .map(assertZipFilename)
    : [];
  const safeVaultTheme =
    isAdmin && vaultTheme ? assertZipFilename(String(vaultTheme).trim()) : '';

  const id = createBlueprint({
    name: cleanName,
    owner: isAdmin ? '' : req.user.username,
    plugins: safePlugins,
    vaultPlugins: safeVaultPlugins,
    vaultTheme: safeVaultTheme,
  });
  return { id };
});

app.delete('/api/blueprints/:id', async (req) => {
  const owner = req.user.role === 'admin' ? null : req.user.username;
  deleteBlueprint(Number(req.params.id), owner);
  return { ok: true };
});

app.post('/api/blueprints/:id/apply', async (req) => {
  const bp = getBlueprint(Number(req.params.id));
  if (!bp || (req.user.role !== 'admin' && bp.owner !== req.user.username)) {
    const err = new Error('Blueprint not found');
    err.statusCode = 404;
    throw err;
  }
  const { domains } = req.body || {};
  if (!Array.isArray(domains) || domains.length === 0) {
    const err = new Error('Select at least one domain');
    err.statusCode = 400;
    throw err;
  }

  const jobIds = [];
  for (const rawDomain of domains) {
    const domain = assertDomainFormat(rawDomain);
    const site = assertSiteAccess(req, domain);
    const jobId = enqueueJob({
      domain,
      action: 'blueprint:apply',
      label: `Apply blueprint "${bp.name}" to ${domain}`,
      fn: async (log) => {
        if (bp.plugins.length > 0) {
          await runWp(site, ['plugin', 'install', ...bp.plugins, '--activate'], { onLine: log });
        }
        for (const zip of bp.vaultPlugins) {
          const zipPath = path.join(REPO_DIR, 'plugins', zip);
          if (fs.existsSync(zipPath)) {
            await runWp(site, ['plugin', 'install', zipPath, '--activate', '--force'], { onLine: log });
          } else {
            log(`Warning: Vault plugin ZIP missing: ${zip}`, 'stderr');
          }
        }
        if (bp.vaultTheme) {
          const themePath = path.join(REPO_DIR, 'themes', bp.vaultTheme);
          if (fs.existsSync(themePath)) {
            await runWp(site, ['theme', 'install', themePath, '--activate', '--force'], { onLine: log });
          } else {
            log(`Warning: Vault theme ZIP missing: ${bp.vaultTheme}`, 'stderr');
          }
        }
        await flushSiteCaches(site, log);
        await refreshSiteMetadata(site, log);
        const health = await checkSiteHealth(site);
        log(`Health check: HTTP ${health.http_status} (${health.ttfb_ms} ms)`);
      },
    });
    jobIds.push(jobId);
  }
  return { jobIds };
});

// --- Snapshots & Rollback ---
app.get('/api/sites/:domain/snapshots', async (req) => {
  const domain = assertDomainFormat(req.params.domain);
  assertKnownSite(domain);
  return { snapshots: listSnapshots(domain) };
});

app.post('/api/sites/:domain/snapshots', async (req) => {
  const domain = assertDomainFormat(req.params.domain);
  const site = assertSiteAccess(req, domain);
  const includeContent = req.body?.includeContent !== false;

  const jobId = enqueueJob({
    domain,
    action: 'snapshot:create',
    label: `Create ${includeContent ? 'full' : 'DB'} snapshot for ${domain}`,
    fn: async (log) => {
      await createManualSnapshot(site, { includeContent }, log);
      log(`Snapshot saved under /var/backups/wp-fleet/${domain}/`);
    },
  });
  return { jobId };
});

app.get('/api/sites/:domain/snapshots/:id/download', async (req, reply) => {
  const domain = assertDomainFormat(req.params.domain);
  assertKnownSite(domain);
  const snapId = Number(req.params.id);
  const part = req.query.part === 'files' ? 'files' : 'db';

  const snap = getSnapshot(snapId);
  if (!snap || snap.domain !== domain) {
    return reply.code(404).send({ error: 'Snapshot not found' });
  }

  const filePath = part === 'files' ? snap.archive_file : snap.db_file;
  if (!filePath || !fs.existsSync(filePath)) {
    return reply.code(404).send({ error: 'Snapshot file not found on disk' });
  }

  const filename = path.basename(filePath);
  reply.header('Content-Disposition', `attachment; filename="${filename}"`);
  reply.header('Content-Type', 'application/gzip');
  return reply.send(fs.createReadStream(filePath));
});

app.delete('/api/sites/:domain/snapshots/:id', async (req) => {
  const domain = assertDomainFormat(req.params.domain);
  const site = assertSiteAccess(req, domain);
  const snapId = Number(req.params.id);
  removeSnapshotById(site, snapId);
  return { ok: true };
});

app.post('/api/sites/:domain/snapshots/restore', async (req) => {
  const domain = assertDomainFormat(req.params.domain);
  const site = assertSiteAccess(req, domain);
  const { id, restoreDb = true, restoreFiles = true } = req.body || {};
  const snapId = Number(id);
  if (!Number.isInteger(snapId) || snapId <= 0) {
    const err = new Error('Invalid snapshot id');
    err.statusCode = 400;
    throw err;
  }

  const jobId = enqueueJob({
    domain,
    action: 'snapshot:restore',
    label: `Restore snapshot #${snapId} on ${domain}`,
    fn: async (log) => {
      await restoreSnapshot(site, snapId, { restoreDb, restoreFiles }, log);
      await flushSiteCaches(site, log);
      await refreshSiteMetadata(site, log);
      const health = await checkSiteHealth(site);
      log(`Post-rollback health: HTTP ${health.http_status} (${health.ttfb_ms} ms)`);
    },
  });
  return { jobId };
});

// --- Diagnostics, Cache & Toggles ---
app.post('/api/sites/:domain/cache-flush', async (req) => {
  const domain = assertDomainFormat(req.params.domain);
  const site = assertSiteAccess(req, domain);
  const jobId = enqueueJob({
    domain,
    action: 'cache:flush',
    label: `Flush WP & Nginx cache on ${domain}`,
    fn: async (log) => {
      await flushSiteCaches(site, log);
    },
  });
  return { jobId };
});

app.post('/api/sites/:domain/verify-checksums', async (req) => {
  const domain = assertDomainFormat(req.params.domain);
  const site = assertSiteAccess(req, domain);
  const jobId = enqueueJob({
    domain,
    action: 'core:verify-checksums',
    label: `Verify core checksums on ${domain}`,
    fn: async (log) => {
      await runWp(site, ['core', 'verify-checksums'], { onLine: log });
    },
  });
  return { jobId };
});

app.get('/api/sites/:domain/debug-log', async (req) => {
  const domain = assertDomainFormat(req.params.domain);
  const site = assertSiteAccess(req, domain);
  const logPath = path.join(site.path, 'wp-content', 'debug.log');

  if (getConfig().mode === 'hestia') {
    const res = await runHelper(['tail-debug', site.user, site.domain]).catch(() => ({
      stdout: '',
    }));
    return { lines: res.stdout };
  }

  if (!fs.existsSync(logPath)) return { lines: '(debug.log not found)' };
  const content = fs.readFileSync(logPath, 'utf8');
  const last200 = content.split(/\r?\n/).slice(-200).join('\n');
  return { lines: last200 };
});

app.post('/api/sites/:domain/toggles', async (req) => {
  const domain = assertDomainFormat(req.params.domain);
  const site = assertSiteAccess(req, domain);
  const { action } = req.body || {};

  if (!['debug-on', 'debug-off', 'maintenance-on', 'maintenance-off'].includes(action)) {
    const err = new Error('Invalid toggle action');
    err.statusCode = 400;
    throw err;
  }

  const jobId = enqueueJob({
    domain,
    action: `toggle:${action}`,
    label: `${action} on ${domain}`,
    fn: async (log) => {
      if (action === 'debug-on') {
        await runWp(site, ['config', 'set', 'WP_DEBUG', 'true', '--raw'], { onLine: log });
        await runWp(site, ['config', 'set', 'WP_DEBUG_LOG', 'true', '--raw'], { onLine: log });
      } else if (action === 'debug-off') {
        await runWp(site, ['config', 'set', 'WP_DEBUG', 'false', '--raw'], { onLine: log });
        await runWp(site, ['config', 'set', 'WP_DEBUG_LOG', 'false', '--raw'], { onLine: log });
      } else if (action === 'maintenance-on') {
        await runWp(site, ['maintenance-mode', 'activate'], { onLine: log });
      } else if (action === 'maintenance-off') {
        await runWp(site, ['maintenance-mode', 'deactivate'], { onLine: log });
      }
    },
  });
  return { jobId };
});

// --- Site WordPress Users ---
const WP_ROLES = new Set(['administrator', 'editor', 'author', 'contributor', 'subscriber']);

app.get('/api/sites/:domain/wp-users', async (req) => {
  const domain = assertDomainFormat(req.params.domain);
  const site = assertSiteAccess(req, domain);
  const res = await runWp(site, [
    'user',
    'list',
    '--fields=ID,user_login,user_email,display_name,roles',
    '--format=json',
  ]);
  return { users: JSON.parse(res.stdout || '[]') };
});

app.post('/api/sites/:domain/wp-users', async (req) => {
  const domain = assertDomainFormat(req.params.domain);
  const site = assertSiteAccess(req, domain);
  const { login, email, password, role = 'administrator' } = req.body || {};

  if (!login || !/^[a-zA-Z0-9._-]{2,60}$/.test(login)) {
    const err = new Error('Invalid username');
    err.statusCode = 400;
    throw err;
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const err = new Error('Invalid email');
    err.statusCode = 400;
    throw err;
  }
  if (!WP_ROLES.has(role)) {
    const err = new Error('Invalid role');
    err.statusCode = 400;
    throw err;
  }
  const pass = String(password || crypto.randomBytes(12).toString('base64url'));
  await runWp(site, ['user', 'create', login, email, `--role=${role}`, `--user_pass=${pass}`]);
  return { ok: true };
});

app.patch('/api/sites/:domain/wp-users/:id', async (req) => {
  const domain = assertDomainFormat(req.params.domain);
  const site = assertSiteAccess(req, domain);
  const id = String(req.params.id || '');
  if (!/^\d+$/.test(id)) {
    const err = new Error('Invalid user ID');
    err.statusCode = 400;
    throw err;
  }
  const { role, password } = req.body || {};
  const args = ['user', 'update', id];
  if (role) {
    if (!WP_ROLES.has(role)) {
      const err = new Error('Invalid role');
      err.statusCode = 400;
      throw err;
    }
    args.push(`--role=${role}`);
  }
  if (password) {
    args.push(`--user_pass=${String(password)}`);
  }
  if (args.length === 3) return { ok: true };
  await runWp(site, args);
  return { ok: true };
});

app.delete('/api/sites/:domain/wp-users/:id', async (req) => {
  const domain = assertDomainFormat(req.params.domain);
  const site = assertSiteAccess(req, domain);
  const id = String(req.params.id || '');
  if (!/^\d+$/.test(id)) {
    const err = new Error('Invalid user ID');
    err.statusCode = 400;
    throw err;
  }
  await runWp(site, ['user', 'delete', id, '--yes']);
  return { ok: true };
});

// --- Fleet Users (Master Admin Only) ---
app.get('/api/users', async (req) => {
  assertAdmin(req);
  const hestiaUsers = Array.from(new Set(listSites().map((s) => s.user))).sort();
  return { users: listUsers(), hestiaUsers };
});

app.post('/api/users', async (req) => {
  assertAdmin(req);
  const { username, password, role = 'client', hestiaUser = '' } = req.body || {};
  const cleanUser = String(username || '').trim();
  if (!/^[a-zA-Z0-9._-]{2,32}$/.test(cleanUser)) {
    const err = new Error('Username must be 2-32 chars (letters, digits, . _ -)');
    err.statusCode = 400;
    throw err;
  }
  assertStrongPassword(password);
  if (role !== 'admin' && role !== 'client') {
    const err = new Error('Invalid role');
    err.statusCode = 400;
    throw err;
  }
  const cleanHestia = role === 'client' ? assertHestiaUser(hestiaUser) : '';
  const pass_hash = await bcrypt.hash(password, 10);
  const id = createUser({
    username: cleanUser,
    pass_hash,
    role,
    hestia_user: cleanHestia,
  });
  return { id };
});

app.patch('/api/users/:id', async (req) => {
  assertAdmin(req);
  const id = Number(req.params.id);
  const { active, password } = req.body || {};
  let pass_hash;
  if (password !== undefined && password !== '') {
    assertStrongPassword(password);
    pass_hash = await bcrypt.hash(password, 10);
  }
  updateUser(id, { pass_hash, active });
  return { ok: true };
});

app.delete('/api/users/:id', async (req) => {
  assertAdmin(req);
  deleteUser(Number(req.params.id));
  return { ok: true };
});

// --- Jobs, Audit & Live SSE Terminal ---
app.get('/api/jobs', async (req) => {
  const all = listJobs();
  if (req.user.role === 'admin') return { jobs: all };
  const allowed = new Set(listSitesForUser(req.user.hestiaUser).map((s) => s.domain));
  return { jobs: all.filter((j) => allowed.has(j.domain)) };
});

app.get('/api/audit', async (req) => {
  const logs =
    req.user.role === 'admin'
      ? listAuditLog(100)
      : listAuditLogForUser(req.user.hestiaUser, 100);
  return { logs };
});

app.get('/api/events', async (req, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.write('event: ready\ndata: {}\n\n');

  const onEvent = (evt) => {
    if (req.user.role !== 'admin') {
      const dom = evt?.payload?.domain;
      if (!dom || dom === 'global') return;
      if (dom !== `user:${req.user.hestiaUser}`) {
        const allowed = new Set(listSitesForUser(req.user.hestiaUser).map((s) => s.domain));
        if (!allowed.has(dom)) return;
      }
    }
    reply.raw.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
  };
  jobBus.on('sse', onEvent);

  const heartbeat = setInterval(() => {
    reply.raw.write(': keepalive\n\n');
  }, 25000);

  req.raw.on('close', () => {
    clearInterval(heartbeat);
    jobBus.off('sse', onEvent);
  });

  return reply;
});

app.listen({ port: PORT, host: HOST }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
