# WP Fleet Manager

Self-hosted, single-server WordPress Fleet Manager for HestiaCP. Manages WordPress core, plugins, themes, staging copies, pre-update snapshots, health checks, and one-time admin logins directly via WP-CLI without child plugins or HTTP callbacks.

## Architecture

- **Backend:** Node.js 24 (or 22+) with Fastify v5, bound to `127.0.0.1:3100`.
- **Database:** Built-in `node:sqlite` (`data/fleet.db`). No external database server (no PostgreSQL or MySQL setup) is required for WP Fleet itself.
- **Frontend:** Vanilla JS and CSS served directly by Fastify.
- **Privilege Model:** Runs as unprivileged user `wp-fleet`. All WP-CLI commands drop privileges to the owning HestiaCP user (`sudo -n -u <user> /usr/local/bin/wp`). Privileged filesystem/cache tasks run through `/usr/local/sbin/wp-fleet-helper` with strict input validation.

## Requirements

- Ubuntu 24.04 LTS with HestiaCP (or Nginx + PHP-FPM + MariaDB + Redis)
- Node.js 22.x or 24.x
- WP-CLI installed at `/usr/local/bin/wp`
- `git`, `tar`, `gzip`, `rsync`, `sudo`

## Installation (HestiaCP / Ubuntu)

1. Clone the repository to `/opt/wp-fleet`:

```bash
git clone https://github.com/christoskaterini/WP-Fleet.git /opt/wp-fleet
cd /opt/wp-fleet
```

2. Run the idempotent installer as `root`:

```bash
bash setup/install.sh
```

This creates:
- System user `wp-fleet`
- `/opt/wp-repo/plugins` and `/opt/wp-repo/themes` (Pro ZIP Vault)
- `/var/backups/wp-fleet` (pre-update snapshots, 14-day retention)
- `/usr/local/sbin/wp-fleet-helper` (`chmod 750`, owned by `root:root`)
- `/etc/sudoers.d/wp-fleet` (validated with `visudo -c`)
- `/etc/systemd/system/wp-fleet.service`

3. Configure `/opt/wp-fleet/.env`:

Generate a bcrypt password hash for the Master Admin account:

```bash
cd /opt/wp-fleet
npm run hash-password -- "YourStrongPassword"
```

Generate a cookie secret:

```bash
openssl rand -hex 32
```

Edit `/opt/wp-fleet/.env`:

```ini
PORT=3100
HOST=127.0.0.1
FLEET_MODE=hestia

COOKIE_SECRET=<generated-64-char-hex>
ADMIN_USER=admin
ADMIN_PASS_HASH=<generated-bcrypt-hash>
COOKIE_SECURE=true

DATA_DIR=./data
REPO_DIR=/opt/wp-repo
BACKUP_DIR=/var/backups/wp-fleet
WP_CLI_BIN=/usr/local/bin/wp
HELPER_BIN=/usr/local/sbin/wp-fleet-helper

JOB_CONCURRENCY=2
SNAPSHOT_RETENTION_DAYS=14
GITHUB_REPO=christoskaterini/WP-Fleet
```

4. Configure the HestiaCP Nginx reverse proxy (do not edit generated vhost files directly):

```bash
cp /opt/wp-fleet/setup/nginx.conf_wpfleet /home/<hestia_user>/conf/web/<domain>/nginx.conf_wpfleet
v-rebuild-web-domain <hestia_user> <domain>
```

5. Start the service:

```bash
systemctl restart wp-fleet
```

## Post-Deployment Verification

```bash
visudo -c
systemctl status wp-fleet
nginx -t
curl -I http://127.0.0.1:3100/api/healthz
```

## Features

- **Site Overview & Health:** Auto-discovers `/home/*/web/*/public_html/wp-config.php`, checks HTTP status and TTFB, and tracks pending core/plugin/theme updates.
- **One-Time Magic Login:** Generates a 60-second single-use token via WP transients and a self-cleaning temporary mu-plugin.
- **Plugin & Theme Management:** Update, activate, deactivate, delete, or install from WordPress.org (with icons/thumbnails) or the Pro ZIP Vault.
- **Cross-Site Matrix:** View any plugin or theme across all hosted sites and bulk-update outdated instances.
- **Blueprints:** Save reusable bundles of WordPress.org plugins (and Pro Vault items for admins) and apply them to multiple sites.
- **Staging:** Clones live sites to a staging subdomain with separate DB, `WP_CACHE = false`, and a unique `WP_CACHE_KEY_SALT`. Supports **Files Only** push (preserves live WooCommerce orders/users) and **Full** push.
- **Snapshots & Rollback:** Exports gzipped DB dumps and `.tar.gz` file archives before updates or manually, with download and one-click restore.
- **Diagnostics:** Core checksum verification, `WP_DEBUG` and maintenance mode toggles, `debug.log` tailing, and Redis/Nginx microcache flushing.
- **Multi-User Isolation:** Master Admin can create client accounts scoped strictly to a single HestiaCP user (`403` enforced on all other sites and admin routes).

## Updating

When `GITHUB_REPO` is set in `.env`, the top bar displays an update badge whenever `package.json` on `main` has a higher version. Admins can trigger a manual update from the UI, or update via SSH:

```bash
cd /opt/wp-fleet
sudo -u wp-fleet git pull --ff-only
sudo -u wp-fleet npm ci --omit=dev
systemctl restart wp-fleet
```

## Tests

Run the built-in security and input validation suite (uses `node:test`, no extra dependencies):

```bash
npm test
```
