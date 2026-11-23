#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/wp-fleet"
REPO_DIR="/opt/wp-repo"
BACKUP_DIR="/var/backups/wp-fleet"
HELPER_DST="/usr/local/sbin/wp-fleet-helper"
SUDOERS_DST="/etc/sudoers.d/wp-fleet"
SERVICE_DST="/etc/systemd/system/wp-fleet.service"
HESTIA_TPL_DIR="/usr/local/hestia/data/templates/web/nginx"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash setup/install.sh"
  exit 1
fi

echo "==> 1. Checking base tools (curl, git, tar, gzip, rsync, sudo, unzip)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git tar gzip rsync sudo unzip >/dev/null

echo "==> 2. Checking Node.js (>= 22)..."
NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | sed -E 's/^v([0-9]+).*/\1/')
fi
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "Installing Node.js 24.x..."
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

echo "==> 3. Checking WP-CLI (/usr/local/bin/wp) & PHP CLI..."
if [[ ! -x /usr/local/bin/wp ]]; then
  echo "Installing WP-CLI..."
  curl -fsSL https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar -o /usr/local/bin/wp
  chmod +x /usr/local/bin/wp
fi
for cli_conf_d in /etc/php/*/cli/conf.d; do
  if [[ -d "$cli_conf_d" ]]; then
    echo "disable_functions =" > "${cli_conf_d}/99-wpfleet-cli.ini"
  fi
done
/usr/local/bin/wp --version --allow-root

echo "==> 4. Creating wp-fleet system user..."
if ! id -u wp-fleet >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin wp-fleet
fi

echo "==> 5. Creating directories..."
mkdir -p "$APP_DIR/data" "$REPO_DIR/plugins" "$REPO_DIR/themes" "$BACKUP_DIR"
chown -R wp-fleet:wp-fleet "$APP_DIR" "$REPO_DIR" "$BACKUP_DIR"
chmod 755 "$REPO_DIR" "$REPO_DIR/plugins" "$REPO_DIR/themes"
chmod 750 "$BACKUP_DIR"

echo "==> 6. Installing wp-fleet-helper..."
cp "$APP_DIR/setup/wp-fleet-helper" "$HELPER_DST"
sed -i 's/\r$//' "$HELPER_DST"
chown root:root "$HELPER_DST"
chmod 750 "$HELPER_DST"

echo "==> 7. Configuring sudoers..."
cat > "$SUDOERS_DST" <<'EOF'
# Allow wp-fleet to run WP-CLI as non-root Hestia users only
wp-fleet ALL=(ALL, !root, !www-data, !mysql) NOPASSWD: /usr/local/bin/wp *
# Allow wp-fleet to run the restricted root helper
wp-fleet ALL=(root) NOPASSWD: /usr/local/sbin/wp-fleet-helper *
EOF
chmod 440 "$SUDOERS_DST"
visudo -c -f "$SUDOERS_DST"

echo "==> 8. Installing Node.js dependencies..."
cd "$APP_DIR"
sudo -u wp-fleet npm ci --omit=dev

if [[ ! -f "$APP_DIR/.env" ]]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  chown wp-fleet:wp-fleet "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "Created $APP_DIR/.env — set COOKIE_SECRET and ADMIN_PASS_HASH before starting!"
fi

if [[ -d "$HESTIA_TPL_DIR" ]]; then
  echo "==> 9. Installing HestiaCP Nginx templates (wpfleet.tpl / wpfleet.stpl)..."
  cp "$APP_DIR/setup/wpfleet.tpl" "$HESTIA_TPL_DIR/wpfleet.tpl"
  cp "$APP_DIR/setup/wpfleet.stpl" "$HESTIA_TPL_DIR/wpfleet.stpl"
  chmod 644 "$HESTIA_TPL_DIR/wpfleet.tpl" "$HESTIA_TPL_DIR/wpfleet.stpl"
  if [[ -d "$HESTIA_TPL_DIR/php-fpm" ]]; then
    cp "$APP_DIR/setup/wpfleet.tpl" "$HESTIA_TPL_DIR/php-fpm/wpfleet.tpl"
    cp "$APP_DIR/setup/wpfleet.stpl" "$HESTIA_TPL_DIR/php-fpm/wpfleet.stpl"
    chmod 644 "$HESTIA_TPL_DIR/php-fpm/wpfleet.tpl" "$HESTIA_TPL_DIR/php-fpm/wpfleet.stpl"
  fi
fi

echo "==> 10. Installing systemd unit..."
cp "$APP_DIR/setup/wp-fleet.service" "$SERVICE_DST"
systemctl daemon-reload
systemctl enable wp-fleet.service

echo "Done. Start with: systemctl restart wp-fleet"
