import type { ProxmoxClient } from "./client.js";
import type {
  PveLxcConfig,
  PveLxcInterface,
  PveLxcListItem,
  PveLxcStatus,
  PveSnapshot,
} from "./types.js";

export interface CloneOptions {
  newid: number;
  hostname: string;
  full: boolean;
  pool?: string;
  storage?: string;
  description?: string;
}

export interface ConfigureOptions {
  cores?: number;
  memory?: number;
  swap?: number;
  hostname?: string;
  net0?: string;
  tags?: string;
  nameserver?: string;
  onboot?: boolean;
  description?: string;
}

/**
 * All LXC (`/nodes/{node}/lxc/...`) REST operations for a single node.
 *
 * Mutating methods return the raw UPID string — the caller passes it to
 * `execProxmoxTask` to wait for completion. Read methods return parsed data.
 */
export class LxcApi {
  constructor(
    private readonly client: ProxmoxClient,
    private readonly node: string,
  ) {}

  private base(vmid: number | string = ""): string {
    return `/nodes/${this.node}/lxc${vmid === "" ? "" : `/${vmid}`}`;
  }

  // ---- read ----------------------------------------------------------

  list(): Promise<PveLxcListItem[]> {
    return this.client.get<PveLxcListItem[]>(this.base());
  }

  getConfig(vmid: number): Promise<PveLxcConfig> {
    return this.client.get<PveLxcConfig>(`${this.base(vmid)}/config`);
  }

  getStatus(vmid: number): Promise<PveLxcStatus> {
    return this.client.get<PveLxcStatus>(`${this.base(vmid)}/status/current`);
  }

  getInterfaces(vmid: number): Promise<PveLxcInterface[]> {
    return this.client.get<PveLxcInterface[]>(`${this.base(vmid)}/interfaces`);
  }

  listSnapshots(vmid: number): Promise<PveSnapshot[]> {
    return this.client.get<PveSnapshot[]>(`${this.base(vmid)}/snapshot`);
  }

  // ---- mutate (return UPID) ----------------------------------------

  clone(sourceVmid: number, opts: CloneOptions): Promise<string> {
    return this.client.post<string>(`${this.base(sourceVmid)}/clone`, {
      newid: opts.newid,
      hostname: opts.hostname,
      full: opts.full,
      pool: opts.pool,
      storage: opts.storage,
      description: opts.description,
    });
  }

  /** Config changes are synchronous — returns null, not a UPID. */
  configure(vmid: number, opts: ConfigureOptions): Promise<null> {
    return this.client.put<null>(`${this.base(vmid)}/config`, {
      cores: opts.cores,
      memory: opts.memory,
      swap: opts.swap,
      hostname: opts.hostname,
      net0: opts.net0,
      tags: opts.tags,
      nameserver: opts.nameserver,
      onboot: opts.onboot,
      description: opts.description,
    });
  }

  /**
   * Grow the container's root disk to an absolute size (e.g. `size: "8G"`).
   * Proxmox only supports growing via this endpoint — a `size` smaller than
   * the disk's current size is rejected (or silently ignored, backend-
   * dependent). Returns the UPID of the (usually fast) resize task.
   */
  resize(vmid: number, disk: string, size: string): Promise<string> {
    return this.client.put<string>(`${this.base(vmid)}/resize`, { disk, size });
  }

  start(vmid: number): Promise<string> {
    return this.client.post<string>(`${this.base(vmid)}/status/start`);
  }

  stop(vmid: number): Promise<string> {
    return this.client.post<string>(`${this.base(vmid)}/status/stop`);
  }

  shutdown(vmid: number, timeout = 30): Promise<string> {
    return this.client.post<string>(`${this.base(vmid)}/status/shutdown`, {
      timeout,
      forceStop: true,
    });
  }

  reboot(vmid: number, timeout = 30): Promise<string> {
    return this.client.post<string>(`${this.base(vmid)}/status/reboot`, { timeout });
  }

  destroy(vmid: number): Promise<string> {
    return this.client.del<string>(this.base(vmid), { purge: 1, force: 1 });
  }

  createSnapshot(vmid: number, snapname: string, description?: string): Promise<string> {
    return this.client.post<string>(`${this.base(vmid)}/snapshot`, {
      snapname,
      description,
    });
  }

  rollbackSnapshot(vmid: number, snapname: string): Promise<string> {
    return this.client.post<string>(
      `${this.base(vmid)}/snapshot/${encodeURIComponent(snapname)}/rollback`,
      { start: false },
    );
  }

  deleteSnapshot(vmid: number, snapname: string): Promise<string> {
    return this.client.del<string>(
      `${this.base(vmid)}/snapshot/${encodeURIComponent(snapname)}`,
    );
  }
}

/** Extract the `ip=` value (without the /CIDR suffix) from a `net0` config line. */
export function ipFromNetConfig(net?: string): string | null {
  if (!net) return null;
  const m = /(?:^|,)ip=([^,]+)/.exec(net);
  if (!m || m[1] === "dhcp") return null;
  return m[1].split("/")[0];
}
