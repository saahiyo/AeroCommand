import { History } from 'lucide-react';
import type { CommandLog } from '../types';

interface DatabaseViewProps {
  logs: CommandLog[];
}

export default function DatabaseView({ logs }: DatabaseViewProps) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">Command Logs</h2>
      <div className="bg-c2card border border-c2border rounded-xl overflow-hidden flex flex-col min-h-[420px]">
        {logs.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center space-y-2 text-slate-500 py-16">
            <History className="w-10 h-10 opacity-20" />
            <span className="text-xs font-semibold text-slate-400">No command logs yet</span>
            <span className="text-[11px] text-slate-500">Run a command from Terminal or Files to see history here</span>
          </div>
        ) : (
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
        )}
      </div>
    </div>
  );
}
