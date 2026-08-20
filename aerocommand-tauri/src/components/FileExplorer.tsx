import React from 'react';
import {
  FolderOpen, HardDrive, RefreshCw, Monitor, Database as DatabaseIcon,
  ShieldCheck, Eye, Download
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

function formatFileSize(sizeStr: string): string {
  try {
    const bytes = parseInt(sizeStr, 10);
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  } catch {
    return sizeStr;
  }
}

export default function FileExplorer({
  fileSubTab, setFileSubTab,
  currentPath,
  fileList,
  isFilesLoading, fileError, fileTruncated, fileTotalCount,
  navHistoryRef,
  browseFolder, goBack, listDrives,
  renderBreadcrumbs, getFileMeta,
  requestPreview, executeCommand,
  lootFiles, selectedLoot,
  lootContent, viewLoot,
}: FileExplorerProps) {
  return (
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

      <div className="flex-1 min-h-0">
        {fileSubTab === 'explorer' ? (
          <div className="h-full bg-c2card border border-c2border rounded flex flex-col overflow-hidden shadow-lg">
            {/* Explorer toolbar */}
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
                  title="Go back"
                >
                  <span>←</span><span>BACK</span>
                </button>
                <button
                  onClick={listDrives}
                  className="px-3 py-1.5 bg-slate-800 border border-c2border rounded text-[10px] font-bold hover:bg-slate-700 transition-colors flex items-center space-x-1.5"
                >
                  <HardDrive className="w-3 h-3" /><span>DRIVES</span>
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
                    { label: 'Documents', icon: <DatabaseIcon className="w-3 h-3" />, path: 'SPECIAL:Documents' },
                    { label: 'Downloads', icon: <HardDrive className="w-3 h-3" />, path: 'SPECIAL:Downloads' },
                    { label: 'Pictures', icon: <ShieldCheck className="w-3 h-3" />, path: 'SPECIAL:Pictures' },
                    { label: 'Videos', icon: <Monitor className="w-3 h-3" />, path: 'SPECIAL:Videos' },
                    { label: 'Music', icon: <RefreshCw className="w-3 h-3" />, path: 'SPECIAL:Music' },
                    { label: 'Favorites', icon: <ShieldCheck className="w-3 h-3" />, path: 'SPECIAL:Favorites' },
                    { label: 'OneDrive', icon: <DatabaseIcon className="w-3 h-3" />, path: 'SPECIAL:OneDrive' },
                    { label: 'AppData', icon: <DatabaseIcon className="w-3 h-3" />, path: 'SPECIAL:AppData' },
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

              {/* File listing */}
              <div className="flex-1 overflow-y-auto">
                {fileError && (
                  <div className="m-4 p-3 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-xs flex items-center space-x-2">
                    <ShieldCheck className="w-4 h-4 shrink-0" />
                    <span>{fileError}</span>
                  </div>
                )}
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
                      {/* Parent directory row */}
                      {currentPath && currentPath !== 'System Drives' && (
                        <tr
                          className="hover:bg-slate-800/30 cursor-pointer transition-colors group"
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
                          <td className="p-4 text-right" />
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
                            <td className="p-4 font-mono text-slate-400">{file.is_dir ? '--' : formatFileSize(file.size)}</td>
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
                                      <Download className="w-4 h-4" />
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
          /* ===== LOOT GALLERY ===== */
          <div className="h-full bg-c2card border border-c2border rounded overflow-hidden flex shadow-lg">
            {/* Loot list sidebar */}
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

            {/* Loot preview pane */}
            <div className="flex-1 bg-slate-950 flex flex-col relative">
              {selectedLoot ? (
                <>
                  <div className="p-4 border-b border-c2border bg-slate-900/40 flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      <div className="text-[11px] font-mono text-c2accent bg-c2accent/10 px-2 py-1 rounded">{selectedLoot.name}</div>
                      <div className="text-[10px] text-slate-500 uppercase tracking-widest">
                        {Math.round(selectedLoot.size / 1024)} KB
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        const link = document.createElement('a');
                        link.href = `data:application/octet-stream;base64,${lootContent}`;
                        link.download = selectedLoot.name;
                        link.click();
                      }}
                      className="p-2 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition-colors"
                    >
                      <Download className="w-4 h-4" />
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
                        <div className="p-2 bg-slate-800/50 border-b border-c2border text-[9px] font-mono text-slate-500 uppercase tracking-widest px-4">
                          Raw File Content
                        </div>
                        <pre className="flex-1 text-[10px] font-mono text-slate-400 p-6 overflow-auto whitespace-pre-wrap leading-relaxed">
                          {lootContent ? (() => {
                            try {
                              const decoded = atob(lootContent);
                              const hasNonPrintable = /[\x00-\x08\x0E-\x1F]/.test(decoded);
                              if (hasNonPrintable) return '[Binary content — not text]';
                              return decoded;
                            } catch {
                              return '[Unable to decode content]';
                            }
                          })() : 'Loading content...'}
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
  );
}
