export interface PveVersion {
  release: string;
  repoid: string;
  version: string;
}

export interface PveNode {
  node: string;
  status: "online" | "offline" | "unknown";
  type: string;
  level?: string;
  ssl_fingerprint?: string;
}

export interface PveStorage {
  storage: string;
  type: string;
  content: string;
  active?: number;
  enabled?: number;
  shared?: number;
  avail?: number;
  total?: number;
  used?: number;
  used_fraction?: number;
}

export interface PveLxcListItem {
  vmid: number;
  name?: string;
  status: "running" | "stopped";
  template?: number;
  tags?: string;
  maxmem?: number;
  maxdisk?: number;
  cpus?: number;
  uptime?: number;
}

export interface PveLxcConfig {
  hostname?: string;
  ostype?: string;
  arch?: string;
  cores?: number;
  memory?: number;
  swap?: number;
  rootfs?: string;
  net0?: string;
  nameserver?: string;
  searchdomain?: string;
  features?: string;
  unprivileged?: number;
  template?: number;
  tags?: string;
  description?: string;
  digest?: string;
  [key: string]: unknown;
}

export interface PveLxcStatus {
  status: "running" | "stopped";
  vmid: number;
  name?: string;
  maxmem?: number;
  maxdisk?: number;
  cpus?: number;
  uptime?: number;
  lock?: string;
}

export interface PveLxcInterface {
  name: string;
  hwaddr?: string;
  inet?: string;
  inet6?: string;
}

export interface PveSnapshot {
  name: string;
  description?: string;
  snaptime?: number;
  parent?: string;
  running?: number;
}

export interface PveTaskStatus {
  upid: string;
  node: string;
  pid: number;
  type: string;
  id: string;
  user: string;
  status: "running" | "stopped";
  exitstatus?: string;
  starttime?: number;
}

export interface PveTaskLogLine {
  n: number;
  t: string;
}
