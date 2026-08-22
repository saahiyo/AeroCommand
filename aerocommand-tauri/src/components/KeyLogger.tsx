import { useEffect, useRef } from 'react';

interface KeyLoggerProps {
  feed: string;
  streaming: boolean;
  hasTarget: boolean;
  onStart: () => void;
  onStop: () => void;
  onClear: () => void;
}

export default function KeyLogger({ feed, streaming, hasTarget, onStart, onStop, onClear }: KeyLoggerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep pinned to the newest keystrokes unless the operator scrolls up
  const pinnedRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [feed]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <div className="flex-1 overflow-hidden flex flex-col p-4 gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Keystroke Monitor</h2>
          <p className="text-xs text-slate-400">
            Live feed from the target's keyboard — starts with <span className="font-mono text-emerald-400">keystart</span>,
            stops with <span className="font-mono text-red-400">keystop</span>. Buffer stays in memory only.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onStart}
            disabled={!hasTarget || streaming}
            className="px-3 py-1.5 text-xs rounded-lg bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-600/30 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Start capture
          </button>
          <button
            onClick={onStop}
            disabled={!hasTarget || !streaming}
            className="px-3 py-1.5 text-xs rounded-lg bg-red-600/20 text-red-300 border border-red-500/30 hover:bg-red-600/30 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Stop
          </button>
          <button
            onClick={onClear}
            className="px-3 py-1.5 text-xs rounded-lg bg-slate-700/40 text-slate-300 border border-slate-600/50 hover:bg-slate-700/60"
          >
            Clear view
          </button>
        </div>
      </div>

      {streaming && (
        <div className="flex items-center gap-2 text-xs text-emerald-400">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </span>
          Live — streaming keystrokes
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto rounded-xl border border-slate-700/60 bg-[#0b1120] p-4 font-mono text-sm text-slate-200 whitespace-pre-wrap break-words"
      >
        {feed || (
          <span className="text-slate-500">
            No keystrokes captured yet. Press "Start capture" to begin monitoring the selected endpoint.
          </span>
        )}
      </div>
    </div>
  );
}
