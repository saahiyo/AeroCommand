import { Search, Settings } from 'lucide-react';
import { useC2 } from '../context/C2Context';

interface HeaderProps {
  activeTab: string;
  setActiveTab: (tab: any) => void;
  termInput: string;
  handleInputChange: (val: string) => void;
  executeCommand: (cmd: string, silent?: boolean) => void;
}

export default function Header({ activeTab, setActiveTab, termInput, handleInputChange, executeCommand }: HeaderProps) {
  const { clients, selectedClientId, setSelectedClientId } = useC2();

  return (
    <header className="h-12 px-5 flex items-center justify-between border-b border-c2border bg-c2sidebar/60 shrink-0">
      <div className="flex items-center space-x-1 bg-c2card border border-c2border rounded-md p-0.5">
        {[
          { label: 'Overview', tab: 'dashboard' },
          { label: 'Endpoints', tab: 'endpoints' },
          { label: 'Files', tab: 'files' },
          { label: 'Terminal', tab: 'terminal' },
        ].map((pill) => (
          <button
            key={pill.tab}
            onClick={() => setActiveTab(pill.tab as any)}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${activeTab === pill.tab ? 'bg-c2accent text-white font-semibold shadow-sm' : 'text-slate-300 hover:text-white'}`}
          >
            {pill.label}
          </button>
        ))}
      </div>
      <div className="flex items-center space-x-2 bg-c2pill border border-c2border rounded-md px-3 py-1.5 w-72 text-xs text-slate-300">
        <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
        <input
          type="text"
          placeholder="Search endpoints or run command..."
          value={termInput}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { executeCommand(termInput); setActiveTab('terminal'); } }}
          className="bg-transparent text-xs text-white placeholder:text-slate-500 outline-none w-full font-sans"
        />
      </div>
      <div className="flex items-center space-x-2">
        {clients.length > 1 ? (
          <select
            value={selectedClientId}
            onChange={(e) => setSelectedClientId(e.target.value)}
            className="bg-c2card border border-c2border text-xs text-slate-300 rounded px-2 py-1.5 outline-none focus:border-c2accent"
          >
            {clients.map(c => (<option key={c.id} value={c.id}>{c.host} ({c.ip})</option>))}
          </select>
        ) : null}
        <button onClick={() => setActiveTab('settings')} className="p-2 hover:bg-c2card rounded text-slate-400 hover:text-white transition-colors" title="Settings">
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
