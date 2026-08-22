import { Suspense } from 'react';
import { Cpu, RefreshCw, Search } from 'lucide-react';
import type { ProcessEntry } from '../types';
import { TableSkeleton } from './Skeleton';

interface ProcessManagerProps {
  processList: ProcessEntry[];
  isProcessesLoading: boolean;
  processSearch: string;
  setProcessSearch: (v: string) => void;
  fetchProcesses: (silent?: boolean) => void;
  killProcess: (pidOrName: string) => void;
}

export default function ProcessManager({
  processList, isProcessesLoading, processSearch, setProcessSearch, fetchProcesses, killProcess
}: ProcessManagerProps) {
  return (
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

      <Suspense fallback={<TableSkeleton rows={8} cols={6} />}>
        <div className="flex-1 bg-c2card border border-c2border rounded overflow-hidden flex flex-col">
          <div className="overflow-y-auto flex-1">
            {isProcessesLoading && processList.length === 0 ? (
              <TableSkeleton rows={8} cols={6} />
            ) : (
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
                  {processList
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
                    ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </Suspense>
    </div>
  );
}
