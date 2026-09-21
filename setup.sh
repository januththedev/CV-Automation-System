#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")" && pwd)"
cd "$repo_root"
case "${1:-}" in
  --start) start=1 ;;
  '') start=0 ;;
  *) printf 'Usage: bash setup.sh [--start]\n' >&2; exit 2 ;;
esac
command -v node >/dev/null || { printf 'Install Node.js 20 or later first.\n' >&2; exit 1; }
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" \
  || { printf "Node.js 20 or later is required (found $(node -v)).\n" >&2; exit 1; }
command -v docker >/dev/null || { printf 'Docker is required. Install docker.io and docker compose first.\n' >&2; exit 1; }
docker info >/dev/null || { printf 'docker daemon not reachable\n' >&2; exit 1; }
docker compose version >/dev/null
if [ ! -f data/cv-auto/config/runtime.env ]; then
  if [ -z "${CV_ADMIN_NUMBER:-}" ]; then
    printf 'WhatsApp number that receives system notices (telemetry), e.g. 9477XXXXXXX: '
    read -r CV_ADMIN_NUMBER
    while ! printf '%s' "$CV_ADMIN_NUMBER" | grep -qE '^\+?[0-9]{7,15}$'; do
      printf 'Enter a valid number (digits only, optional leading +): '
      read -r CV_ADMIN_NUMBER
    done
    export CV_ADMIN_NUMBER
  fi
  node scripts/configure.mjs
fi
docker compose config --quiet
docker compose build
if [ "$start" != 1 ]; then
  printf 'Images built; no services started. Use bash setup.sh --start when ready.\n'
  printf 'Private dashboard: http://127.0.0.1:3001/admin/dashboard\n'
  exit 0
fi

docker compose up -d

# Persist the operator-chosen notification number in the appliance database
# so every notice (online, failures, reviews) follows it — independent of
# container environment overrides.
notify_number="${CV_ADMIN_NUMBER:-}"
if [ -n "$notify_number" ]; then
  docker compose exec -T api node /app/scripts/db-set-setting.mjs notification_number "$notify_number"
fi

# Display fields only — the SSH host key FINGERPRINT is public information,
# never key material, and the message/console output never contains it.
ip_addr="$(hostname -I 2>/dev/null | awk '{print $1}')"
ip_addr="${ip_addr:-127.0.0.1}"
ssh_user="${CV_SSH_USER:-$(whoami)}"
fingerprint=""
for keyfile in /etc/ssh/ssh_host_ed25519_key.pub /etc/ssh/ssh_host_rsa_key.pub; do
  if [ -f "$keyfile" ] && command -v ssh-keygen >/dev/null 2>&1; then
    fingerprint="$(ssh-keygen -lf "$keyfile" 2>/dev/null | awk '{print $2}')"
    [ -n "$fingerprint" ] && break
  fi
done

# Send the "CV AUTOMATION ONLINE" WhatsApp message with the SSH connection,
# the loopback dashboard tunnel and the fingerprint. Best-effort: the stack
# stays up even if provider delivery fails.
node scripts/verify-integrations.mjs notify-online \
  --ip "$ip_addr" --ssh-user "$ssh_user" \
  --dashboard-url "http://127.0.0.1:3001/admin/dashboard" \
  ${fingerprint:+--fingerprint "$fingerprint"} || true

cat <<EOF

================================================================
    CV AUTOMATION IS ONLINE
----------------------------------------------------------------
    Device:    ${CV_DEVICE_NAME:-CV-AUTO-01}
    Notices:   ${notify_number:-<from environment>}
    SSH:       ssh ${ssh_user}@${ip_addr}
    Tunnel:    ssh -L 3001:127.0.0.1:3001 ${ssh_user}@${ip_addr}
               then open http://127.0.0.1:3001/admin/dashboard
    Display:   dashboard kiosk on the appliance screen (when enabled)
    Status:    docker compose ps
    Logs:      docker compose logs -f
${fingerprint:+    Key:       $fingerprint
}
    An "online" message with these connection details was sent to
    the notification number shown above (${notify_number:-when configured}).
================================================================
EOF
