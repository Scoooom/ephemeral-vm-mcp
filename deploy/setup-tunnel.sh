#!/bin/bash
# One-time Cloudflare tunnel setup for the MCP server's HTTP transport.
# Run on mcpProx. The Cloudflare account is already logged in
# (~/.cloudflared/cert.pem). mcpprox.scooom.com already exists as a proxied
# record with Cloudflare Access in front (returns 401 unauthenticated) — step 2
# rewrites it to point at this tunnel.
#
# NOT run automatically: it modifies the mcpprox.scooom.com DNS record and
# assumes you want Access to keep gating it (add a service token for the MCP
# client under Zero Trust > Access > Service Auth, then send it as
# CF-Access-Client-Id / CF-Access-Client-Secret headers alongside the server's
# own Authorization: Bearer <MCP_AUTH_TOKEN>).
#
# The same tunnel also fronts the web dashboard on proxweb.scooom.com. The
# dashboard enforces its own passkey auth, so Cloudflare Access on that hostname
# is optional; if you do add an Access policy, use an interactive (not
# service-token) policy since a human browses it.
#
# Already ran this once? To add just the dashboard hostname to the live tunnel:
#   cloudflared tunnel route dns ephemeral-vm-mcp proxweb.scooom.com
#   # add the proxweb ingress rule to /etc/cloudflared/config.yml (see below)
#   cloudflared tunnel ingress validate && systemctl restart cloudflared
set -euo pipefail

NAME=ephemeral-vm-mcp
HOSTNAME=mcpprox.scooom.com
PORT=8788
DASH_HOSTNAME=proxweb.scooom.com
DASH_PORT=8789

cloudflared tunnel create "$NAME"
TID=$(cloudflared tunnel list --output json | python3 -c "import sys,json;print(next(t['id'] for t in json.load(sys.stdin) if t['name']=='$NAME'))")
echo "tunnel id: $TID"

cloudflared tunnel route dns --overwrite-dns "$NAME" "$HOSTNAME"
cloudflared tunnel route dns --overwrite-dns "$NAME" "$DASH_HOSTNAME"

install -d -m 755 /etc/cloudflared
cat > /etc/cloudflared/config.yml <<EOF
tunnel: $TID
credentials-file: /root/.cloudflared/$TID.json
ingress:
  - hostname: $HOSTNAME
    service: http://127.0.0.1:$PORT
  - hostname: $DASH_HOSTNAME
    service: http://127.0.0.1:$DASH_PORT
  - service: http_status:404
EOF

cloudflared tunnel ingress validate
cloudflared service install
systemctl enable --now cloudflared

echo "done."
echo "  MCP:       curl -H 'Authorization: Bearer <MCP_AUTH_TOKEN>' https://$HOSTNAME/healthz"
echo "  dashboard: open https://$DASH_HOSTNAME/  (register a passkey on first visit)"
