#!/bin/bash
# Run this INSIDE the CT113 template to make cloned containers reachable by the
# MCP server over SSH. The server has no console/CLI access to Proxmox — it can
# only reach containers via SSH as root — so this must be baked into the template.
#
# On the Proxmox host (pve2):
#     pct set 113 --template 0
#     pct start 113
#     pct push 113 fix-template-ssh.sh /root/fix-template-ssh.sh
#     pct exec 113 -- bash /root/fix-template-ssh.sh
#     pct exec 113 -- rm /root/fix-template-ssh.sh
#     pct stop 113
#     pct template 113
#
# Idempotent — safe to re-run.
set -euo pipefail

MCPPROX_PUBKEY='ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDHORh/kPEoNVfmdeqYsbFkStwovAyLusyFfJ069UioxoqsZynfj4QYeVIehbMcal023jNMyY0qBoskWlrkjGuZ+KGi1pDasLnCC9XcPFIr2K5O6hG0FPQaNj/NkM/M5hUKYHe6P2ynNAco2PqGlgI/eEGFgMG1ZK57iYxKE1c7R54FwEtcaN3Dv5qUBMZ7TKLwMNCEUtdKHQCfTj3xd7NmVsgiYakmnuBMzNWxrsmjbtAmXYds8J1CULE2HLhs9zHgVvFNKlAQGcTSUb+u28LFYm4Jf2R0JiPxmMzo1lqKkndtvj7zYl6j5Enk6N/nVy6WO7GdLmuU3PDLHoBJTscP mcpProx-ephemeral-vm-mcp'

echo "[1/4] installing + enabling openssh-server"
if ! dpkg -s openssh-server >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq openssh-server
fi
# Debian 13 ships socket-activated ssh; enable BOTH so a booted clone always listens.
systemctl enable ssh 2>/dev/null || true
systemctl enable ssh.socket 2>/dev/null || true
# Make sure it is not the socket-only unit that stays cold until first connect:
systemctl disable ssh.socket 2>/dev/null || true
systemctl enable ssh.service 2>/dev/null || true

echo "[2/4] first-boot host-key + machine-id regen service"
cat >/usr/local/sbin/firstboot-regen.sh <<'EOS'
#!/bin/bash
MARKER=/etc/.firstboot-done
if [ ! -f "$MARKER" ]; then
    rm -f /etc/ssh/ssh_host_*
    ssh-keygen -A
    : > /etc/machine-id
    rm -f /var/lib/dbus/machine-id
    systemd-machine-id-setup
    ln -sf /etc/machine-id /var/lib/dbus/machine-id
    systemctl try-restart ssh.service 2>/dev/null || true
    touch "$MARKER"
fi
EOS
chmod +x /usr/local/sbin/firstboot-regen.sh
cat >/etc/systemd/system/firstboot-regen.service <<'EOS'
[Unit]
Description=Regenerate SSH host keys and machine-id on first boot
Before=ssh.service
DefaultDependencies=no
After=local-fs.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/firstboot-regen.sh
RemainAfterExit=yes
[Install]
WantedBy=sysinit.target
EOS
systemctl enable firstboot-regen.service

echo "[3/4] authorizing the mcpProx key for root"
install -d -m 700 /root/.ssh
touch /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
grep -qF "${MCPPROX_PUBKEY%% *} $(echo "$MCPPROX_PUBKEY" | awk '{print $2}')" /root/.ssh/authorized_keys \
  || echo "$MCPPROX_PUBKEY" >> /root/.ssh/authorized_keys

echo "[4/4] clearing the first-boot marker so keys regenerate in each clone"
rm -f /etc/.firstboot-done

echo "done. Verify after re-templating + cloning: 'ss -ltnp | grep :22' inside a clone."
