// Shared types across all components

export interface Client {
  id: string;
  host: string;
  ip: string;
  pid: number;
  os: string;
  user: string;
  admin: boolean;
  first_seen: string;
  last_seen: string;
  status: string;
  cpu_usage: number;
  ram_usage: number;
  disk_usage: number;
  net_usage: number;
}

export interface CommandLog {
  id: number;
  client_id: string;
  command: string;
  output: string;
  timestamp: string;
  status: string;
}

export interface FileEntry {
  name: string;
  size: string;
  date: string;
  is_dir: boolean;
}

export interface LootFile {
  name: string;
  path: string;
  size: number;
  timestamp: string;
  client: string;
}

export interface InstalledApp {
  name: string;
  version: string;
  publisher: string;
  location: string;
  date: string;
  size: string;
  uninstall: string;
  icon_path: string;
}

export interface ProcessEntry {
  name: string;
  pid: string;
  mem: string;
  user: string;
  cpu: string;
  title: string;
}

export interface PreviewData {
  status: 'ok' | 'error' | 'unsupported';
  type?: 'image' | 'text' | 'binary';
  name?: string;
  path?: string;
  mime?: string;
  data?: string;
  content?: string;
  size?: string;
  message?: string;
}
