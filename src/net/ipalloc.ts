import type { NetworkConfig } from "../config.js";
import type { Repo } from "../db/repo.js";

export class IpPoolExhausted extends Error {
  constructor(net: NetworkConfig) {
    super(
      `No free IP in ${net.subnet}/${net.cidrBits} range .${net.rangeStart}-.${net.rangeEnd}`,
    );
    this.name = "IpPoolExhausted";
  }
}

/** `10.10.30` from a `10.10.30.0` subnet address. */
function prefix(net: NetworkConfig): string {
  return net.subnet.split(".").slice(0, 3).join(".");
}

/**
 * Pick the lowest free last-octet CID in the ephemeral subnet.
 *
 * Callers MUST run this inside the same `repo.transaction` that inserts the
 * `vms` row claiming the returned IP, so two concurrent clones can't be handed
 * the same octet.
 */
export function allocateIp(repo: Repo, net: NetworkConfig): { ip: string; octet: number } {
  const used = new Set<number>([...repo.usedOctets(), ...net.reserved]);
  for (let octet = net.rangeStart; octet <= net.rangeEnd; octet++) {
    if (!used.has(octet)) {
      return { ip: `${prefix(net)}.${octet}`, octet };
    }
  }
  throw new IpPoolExhausted(net);
}

/** Build a Proxmox `net0` config line for a static-IP container on the ephemeral bridge. */
export function buildNet0(ip: string, net: NetworkConfig): string {
  return [
    "name=eth0",
    `bridge=${net.bridge}`,
    "firewall=0",
    `ip=${ip}/${net.cidrBits}`,
    `gw=${net.gateway}`,
  ].join(",");
}
