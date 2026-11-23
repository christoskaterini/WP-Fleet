#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/wp-fleet"
REPO_DIR="/opt/wp-repo"
BACKUP_DIR="/var/backups/wp-fleet"
HELPER_DST="/usr/local/sbin/wp-fleet-helper"
SUDOERS_DST="/etc/sudoers.d/wp-fleet"
SERVICE_DST="/etc/systemd/system/wp-fleet.service"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash setup/install.sh"
  exit 1
fi

echo "==> 1. Creating wp-fleet system user..."
if ! id -u wp-fleet >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin wp-fleet
fi

echo "==> 2. Creating directories..."
mkdir -p "$APP_DIR/data" "$REPO_DIR/plugins" "$REPO_DIR/themes" "$BACKUP_DIR"
chown -R wp-fleet:wp-fleet "$APP_DIR" "$REPO_DIR" "$BACKUP_DIR"
chmod 755 "$REPO_DIR" "$REPO_DIR/plugins" "$REPO_DIR/themes"
chmod 750 "$BACKUP_DIR"

echo "==> 3. Installing wp-fleet-helper..."
cp "$APP_DIR/setup/wp-fleet-helper" "$HELPER_DST"
sed -i 's/\r$//' "$HELPER_DST"
chown root:root "$HELPER_DST"
chmod 750 "$HELPER_DST"

echo "==> 4. Configuring sudoers..."
cat > "$SUDOERS_DST" <<'EOF'
# Allow wp-fleet to run WP-CLI as non-root Hestia users only
wp-fleet ALL=(ALL, !root, !www-data, !mysql) NOPASSWD: /usr/local/bin/wp *
# Allow wp-fleet to run the restricted root helper
wp-fleet ALL=(root) NOPASSWD: /usr/local/sbin/wp-fleet-helper *
EOF
chmod 440 "$SUDOERS_DST"
visudo -c -f "$SUDOERS_DST"

echo "==> 5. Installing Node.js dependencies..."
cd "$APP_DIR"
sudo -u wp-fleet npm ci --omit=dev

if [[ ! -f "$APP_DIR/.env" ]]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  chown wp-fleet:wp-fleet "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "Created $APP_DIR/.env — set COOKIE_SECRET and ADMIN_PASS_HASH before starting!"
fi

echo "==> 6. Installing systemd unit..."
cp "$APP_DIR/setup/wp-fleet.service" "$SERVICE_DST"
systemctl daemon-reload
systemctl enable wp-fleet.service

echo "Done. Start with: systemctl restart wp-fleet"
