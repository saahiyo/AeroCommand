import { Suspense, useState, useMemo, useEffect, useRef } from 'react';
import { RefreshCw, Search, X, Copy, Check, Package } from 'lucide-react';
import type { InstalledApp } from '../types';
import { GridSkeleton } from './Skeleton';

interface AppsExplorerProps {
  appsList: InstalledApp[];
  isAppsLoading: boolean;
  appIcons: Record<string, string>;
  executeCommand: (cmd: string, silent?: boolean) => void;
}

type SortField = 'name' | 'size' | 'date' | 'publisher';

// Deterministic tile color per app name
const TILE_COLORS = [
  'bg-blue-500/15 text-blue-300 border-blue-500/30',
  'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  'bg-violet-500/15 text-violet-300 border-violet-500/30',
  'bg-amber-500/15 text-amber-300 border-amber-500/30',
  'bg-rose-500/15 text-rose-300 border-rose-500/30',
  'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
];

function tileColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return TILE_COLORS[h % TILE_COLORS.length];
}

function initials(name: string): string {
  const words = name.replace(/[^a-zA-Z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function parseSizeBytes(sizeStr: string): number {
  const units: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
  const m = sizeStr.trim().match(/^([\d.]+)\s*(B|KB|MB|GB)$/i);
  if (m) return parseFloat(m[1]) * units[m[2].toUpperCase()];
  return -1;
}

export default function AppsExplorer({
  appsList, isAppsLoading, appIcons, executeCommand,
}: AppsExplorerProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<SortField>('name');
  const [copiedApp, setCopiedApp] = useState<string | null>(null);
  const requestedRef = useRef(false);
  const iconsRequestedRef = useRef(false);

  // Auto-scan when the tab opens with a fresh target
  useEffect(() => {
    if (!requestedRef.current && appsList.length === 0 && !isAppsLoading) {
      requestedRef.current = true;
      executeCommand('apps', true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch icons once the app list arrives
  useEffect(() => {
    if (!iconsRequestedRef.current && appsList.length > 0) {
      iconsRequestedRef.current = true;
      executeCommand('appicons', true);
    }
  }, [appsList.length, executeCommand]);

  const filteredApps = useMemo(() => {
    let result = [...appsList];
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(a =>
        a.name.toLowerCase().includes(q) ||
        a.publisher.toLowerCase().includes(q)
      );
    }
    result.sort((a, b) => {
      if (sortField === 'name') return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      if (sortField === 'publisher') return (a.publisher || '~').localeCompare(b.publisher || '~');
      if (sortField === 'size') return parseSizeBytes(b.size) - parseSizeBytes(a.size);
      return (b.date || '').localeCompare(a.date || '');
    });
    return result;
  }, [appsList, searchQuery, sortField]);

  const copyLocation = (app: InstalledApp) => {
    navigator.clipboard.writeText(app.location || app.uninstall || app.name);
    setCopiedApp(app.name);
    setTimeout(() => setCopiedApp(null), 1500);
  };

  const refresh = () => {
    iconsRequestedRef.current = false;
    executeCommand('apps', true);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h2 className="text-sm font-bold text-white">Apps Explorer</h2>
          <p className="text-[11px] text-slate-400">Installed applications on the targeted endpoint</p>
        </div>
        <button
          onClick={refresh}
          className="px-3 py-1.5 bg-c2accent hover:bg-c2accenthover text-white rounded-lg text-xs font-bold flex items-center space-x-1.5 transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isAppsLoading ? 'animate-spin' : ''}`} />
          <span>Scan Apps</span>
        </button>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 shrink-0 flex-wrap">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={`Search ${appsList.length} installed apps...`}
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

        <select
          value={sortField}
          onChange={(e) => setSortField(e.target.value as SortField)}
          className="bg-c2pill border border-c2border rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-c2accent cursor-pointer"
        >
          <option value="name">Sort: Name</option>
          <option value="size">Sort: Size</option>
          <option value="date">Sort: Newest</option>
          <option value="publisher">Sort: Publisher</option>
        </select>

        <span className="text-[11px] font-mono text-slate-400 ml-auto">
          {filteredApps.length === appsList.length
            ? `${appsList.length} apps`
            : `${filteredApps.length} of ${appsList.length}`}
        </span>
      </div>

      {/* Grid */}
      <Suspense fallback={<GridSkeleton cards={8} />}>
        <div className="flex-1 overflow-y-auto min-h-0 pr-1">
          {isAppsLoading && appsList.length === 0 ? (
            <GridSkeleton cards={8} />
          ) : appsList.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center space-y-2 text-slate-500">
            <Package className="w-10 h-10 opacity-20" />
            <span className="text-xs font-semibold text-slate-400">No apps listed</span>
            <span className="text-[11px]">Click "Scan Apps" to enumerate installed software on the target</span>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 pb-2">
            {filteredApps.map((app) => {
              const icon = appIcons[app.name];
              return (
                <div
                  key={app.name}
                  className="p-3 bg-c2card border border-c2border hover:border-c2borderlight rounded-xl transition-colors group flex flex-col"
                >
                  <div className="flex items-start space-x-3">
                    {/* Icon tile */}
                    <div className={`w-10 h-10 rounded-lg border flex items-center justify-center shrink-0 font-bold text-sm ${tileColor(app.name)} overflow-hidden`}>
                      {icon ? (
                        <img src={icon} alt="" className="w-full h-full object-contain p-1" />
                      ) : (
                        initials(app.name)
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-bold text-white truncate" title={app.name}>
                        {app.name}
                      </div>
                      <div className="text-[10px] text-slate-500 truncate mt-0.5" title={app.publisher}>
                        {app.publisher || 'Unknown publisher'}
                      </div>
                    </div>
                  </div>

                  <div className="mt-2.5 pt-2 border-t border-c2border/50 flex items-center justify-between text-[10px] font-mono text-slate-500">
                    <span className="truncate">{app.version || '—'}</span>
                    <div className="flex items-center space-x-2 shrink-0">
                      {app.size && <span>{app.size}</span>}
                      {app.date && <span>{app.date}</span>}
                    </div>
                  </div>

                  {(app.location || app.uninstall) && (
                    <button
                      onClick={() => copyLocation(app)}
                      className="mt-2 w-full py-1 rounded-md bg-c2pill/60 border border-c2border/60 text-[10px] font-medium text-slate-400 hover:text-white hover:border-c2accent/40 flex items-center justify-center space-x-1 opacity-70 group-hover:opacity-100 transition-all"
                      title={app.location || app.uninstall}
                    >
                      {copiedApp === app.name ? (
                        <>
                          <Check className="w-3 h-3 text-emerald-400" />
                          <span className="text-emerald-400">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          <span>Copy path</span>
                        </>
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          )}
        </div>
      </Suspense>
    </div>
  );
}
