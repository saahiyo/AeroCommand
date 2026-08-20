import React from 'react';
import {
  Monitor, RefreshCw, FolderOpen, Terminal, Cpu, ArrowUpRight,
  TrendingUp
} from 'lucide-react';
import type { Client, CommandLog } from '../types';

interface DashboardProps {
  clients: Client[];
  logs: CommandLog[];
  selectedClientId: string;
  setSelectedClientId: (id: string) => void;
  setActiveTab: (tab: 'dashboard' | 'endpoints' | 'terminal' | 'files' | 'processes' | 'clipboard' | 'database' | 'settings') => void;
  formatActivityLog: (log: CommandLog) => {
    category: string;
    badge: string;
    badgeClass: string;
    title: string;
    detail: string;
    icon: React.ReactNode;
    meta?: string;
  };
  executeCommand: (cmd: string, silent?: boolean) => void;
  onRefreshClients: () => void;
}

export default function Dashboard({
  clients, logs, selectedClientId, setSelectedClientId,
  setActiveTab, formatActivityLog, executeCommand, onRefreshClients
}: DashboardProps) {
  const [activityFilter, setActivityFilter] = React.useState<'all' | 'files' | 'processes' | 'commands'>('all');

  return (
    <div className="space-y-5">
      {/* ROW 1: Welcome + Fleet Mini Cards */}
      <div className="grid grid-cols-12 gap-4">
        {/* Welcome Banner */}
        <div className="col-span-5 bg-c2card border border-c2border rounded-xl p-5 shadow-card">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-lg bg-c2accent/10 border border-c2accent/20 flex items-center justify-center">
              <TrendingUp className="w-5 h-5 text-c2accent" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">Endpoint Fleet Overview</h2>
              <p className="text-[11px] text-slate-400 mt-0.5">
                {clients.length === 0
                  ? 'No endpoints connected'
                  : `${clients.length} endpoint${clients.length !== 1 ? 's' : ''} active — ${clients.filter(c => c.admin).length} with admin privileges`}
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-center space-x-3">
            <div className="flex items-center space-x-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[10px] text-slate-400 font-semibold">FLEET ONLINE</span>
            </div>
            <span className="text-slate-700">|</span>
            <span className="text-[10px] text-slate-400 font-mono">AeroCommand C2 v3.5</span>
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
                const isTarget = selectedClientId ? selectedClientId === c.id : idx === 0;
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

      {/* ROW 2: Active Remote Endpoints Table */}
      <div className="bg-c2card border border-c2border rounded-xl p-4 shadow-card space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-xs font-bold text-white uppercase tracking-wider">Active Remote Endpoints</h3>
            <p className="text-[11px] text-slate-400">Select an active machine to target commands & browse filesystem</p>
          </div>
          <button
            onClick={onRefreshClients}
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
                const isTarget = selectedClientId ? selectedClientId === c.id : i === 0;
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

      {/* ROW 3: Recent C2 Activity + Quick Actions */}
      <div className="grid grid-cols-12 gap-4">

        {/* Recent Activity Table */}
        <div className="col-span-8 bg-c2card border border-c2border rounded-xl p-4 shadow-card flex flex-col justify-between">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-xs font-bold text-white uppercase tracking-wider">Recent C2 Activity</h3>
              <p className="text-[11px] text-slate-400">Chronological telemetry transactions</p>
            </div>
            <div className="flex items-center space-x-1 bg-c2pill p-0.5 rounded-md border border-c2border">
              {(['all', 'files', 'processes', 'commands'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setActivityFilter(f)}
                  className={`px-2.5 py-0.5 rounded text-[10px] font-semibold transition-colors ${
                    activityFilter === f
                      ? 'bg-c2accent text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {f === 'all' ? 'All' : f === 'files' ? 'Files' : f === 'processes' ? 'Procs' : 'Shell'}
                </button>
              ))}
            </div>
          </div>

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

        {/* Quick Actions Card */}
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
                { label: 'Remote File Explorer', icon: FolderOpen, color: 'text-amber-400', tab: 'files' as const, action: () => setActiveTab('files') },
                { label: 'Capture Screen', icon: Monitor, color: 'text-cyan-400', tab: 'files' as const, action: () => { executeCommand('screenshot'); setActiveTab('files'); } },
                { label: 'Process Manager', icon: Cpu, color: 'text-violet-400', tab: 'processes' as const, action: () => setActiveTab('processes') },
                { label: 'Command Center', icon: Terminal, color: 'text-blue-400', tab: 'terminal' as const, action: () => setActiveTab('terminal') },
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
            <span className="text-emerald-400 font-semibold">Port 9540</span>
          </div>
        </div>
      </div>
    </div>
  );
}
