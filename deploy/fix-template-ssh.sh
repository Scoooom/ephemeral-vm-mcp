#!/bin/bash
# Reference: the SSH fix that was applied to the CT113 template on 2026-09-08 so
# that cloned containers come up with sshd listening. Kept for the record / for
# rebuilding the template from scratch. The MCP server reaches containers only
# over SSH as root, so this must be baked into the template.
#
# Applied by editing the base volume filesystem directly (container stopped):
#     zfs snapshot media/basevol-113-disk-0@safety-pre-sshfix   # backup first
#     zfs destroy  media/basevol-113-disk-0@__base__
#     zfs set mountpoint=/media/basevol-113-disk-0 media/basevol-113-disk-0
#     zfs mount media/basevol-113-disk-0
#     bash fix-template-ssh.sh /media/basevol-113-disk-0
#     umount /media/basevol-113-disk-0
#     zfs snapshot media/basevol-113-disk-0@__base__            # clones read this
#
# Or, with the container booted: run the body against "/" via `pct exec 113 --`.
set -euo pipefail
R="${1:-/}"

# mcpProx's SSH public key (ssh-keygen -y -f ~/.ssh/id_rsa on mcpProx).
MCPPROX_PUBKEY='ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDHORh/kPEoNVfmdeqYsbFkStwovAyLusyFfJ069UioxoqsZynfj4QYeVIehbMcal023jNMyY0qBoskWlrkjGuZ+KGi1pDasLnCC9XcPFIr2K5O6hG0FPQaNj/NkM/M5hUKYHe6P2ynNAco2PqGlgI/eEGFgMG1ZK57iYxKE1c7R54FwEtcaN3Dv5qUBMZ7TKLwMNCEUtdKHQCfTj3xd7NmVsgiYakmnuBMzNWxrsmjbtAmXYds8J1CULE2HLhs9zHgVvFNKlAQGcTSUb+u28LFYm4Jf2R0JiPxmMzo1lqKkndtvj7zYl6j5Enk6N/nVy6WO7GdLmuU3PDLHoBJTscP mcpProx-ephemeral-vm-mcp'

echo "[1/3] deadlock-free first-boot regen script"
cat > "$R/usr/local/sbin/firstboot-regen.sh" <<'EOS'
#!/bin/bash
# Regenerate SSH host keys + machine-id once, on the first boot of each clone.
# MUST NOT touch systemctl for ssh here: this unit is ordered Before= the ssh
# units, so calling `systemctl restart ssh.*` deadlocks against that ordering.
MARKER=/etc/.firstboot-done
if [ ! -f "$MARKER" ]; then
    rm -f /etc/ssh/ssh_host_*
    ssh-keygen -A
    : > /etc/machine-id
    rm -f /var/lib/dbus/machine-id
    systemd-machine-id-setup
    ln -sf /etc/machine-id /var/lib/dbus/machine-id
    touch "$MARKER"
fi
EOS
chmod +x "$R/usr/local/sbin/firstboot-regen.sh"

echo "[2/3] unit ordered before BOTH ssh units (this is the fix)"
cat > "$R/etc/systemd/system/firstboot-regen.service" <<'EOS'
[Unit]
Description=Regenerate SSH host keys and machine-id on first boot
Before=ssh.service ssh.socket
DefaultDependencies=no
After=local-fs.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/firstboot-regen.sh
RemainAfterExit=yes
[Install]
WantedBy=sysinit.target
EOS
mkdir -p "$R/etc/systemd/system/sysinit.target.wants"
ln -sf /etc/systemd/system/firstboot-regen.service \
  "$R/etc/systemd/system/sysinit.target.wants/firstboot-regen.service"

echo "[3/3] authorize the mcpProx key + reset template state"
install -d -m 700 "$R/root/.ssh"
touch "$R/root/.ssh/authorized_keys"
chmod 600 "$R/root/.ssh/authorized_keys"
grep -qF "$(awk '{print $2}' <<<"$MCPPROX_PUBKEY")" "$R/root/.ssh/authorized_keys" \
  || echo "$MCPPROX_PUBKEY" >> "$R/root/.ssh/authorized_keys"
# safety-net host keys in the image (regen replaces them per-clone)
ssh-keygen -A -f "$R" 2>/dev/null || true
rm -f "$R/etc/.firstboot-done"
: > "$R/etc/machine-id"
rm -f "$R/var/lib/dbus/machine-id"

echo "done."
