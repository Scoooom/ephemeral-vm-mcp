import type { ProxmoxClient } from "./client.js";
import type { LxcApi } from "./lxc.js";
import type { PveNode, PveStorage, PveVersion } from "./types.js";

export class Discovery {
  constructor(
    private readonly client: ProxmoxClient,
    private readonly lxc: LxcApi,
    private readonly node: string,
  ) {}

  version(): Promise<PveVersion> {
    return this.client.get<PveVersion>("/version");
  }

  nodes(): Promise<PveNode[]> {
    return this.client.get<PveNode[]>("/nodes");
  }

  storage(node?: string): Promise<PveStorage[]> {
    return this.client.get<PveStorage[]>(`/nodes/${node ?? this.node}/storage`);
  }

  async templates(): Promise<{ vmid: number; name: string; node: string }[]> {
    const list = await this.lxc.list();
    return list
      .filter((c) => c.template === 1)
      .map((c) => ({ vmid: c.vmid, name: c.name ?? `ct${c.vmid}`, node: this.node }));
  }

  /** Next free VMID, as reported by the cluster (returned as a string by the API). */
  async nextId(): Promise<number> {
    const raw = await this.client.get<string>("/cluster/nextid");
    return Number(raw);
  }
}
