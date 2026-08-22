import { LayoutDashboard, Monitor, Terminal as TerminalIcon, FolderOpen, Clipboard, Database, Settings, LayoutGrid, Keyboard } from 'lucide-react';
import Tooltip from './Tooltip';
import { useC2 } from '../context/C2Context';

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: any) => void;
}

export default function Sidebar({ activeTab, setActiveTab }: SidebarProps) {
  const { c2Mode, c2ConnectionStatus, c2ServerUrl, serverPort, clients } = useC2();

  return (
    <div className="w-60 bg-c2sidebar border-r border-c2border flex flex-col justify-between p-3 shrink-0">
      <div>
        <div className="flex items-center space-x-2.5 px-2 py-3 mb-2 border-b border-c2border/60">
          <div className="w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center shrink-0">
            <img src="/logo.png" alt="AeroCommand Logo" className="w-full h-full object-contain" />
          </div>
          <div>
            <span className="font-bold text-sm text-white tracking-tight block">AeroCommand</span>
            <span className="text-[10px] text-slate-400 font-semibold block uppercase tracking-wider">C2 Console v3.5</span>
          </div>
        </div>
        <div className="space-y-0.5 mt-2">
          <div className="text-[10px] uppercase font-bold text-slate-500 tracking-wider px-2.5 py-1">Navigation</div>
          {[
            { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, tip: 'Fleet overview and live telemetry' },
            { id: 'endpoints', label: 'Endpoints', icon: Monitor, tip: 'Manage connected remote endpoints' },
            { id: 'terminal', label: 'Command Center', icon: TerminalIcon, tip: 'Interactive command shell' },
            { id: 'processes', label: 'Process Manager', icon: Monitor, tip: 'Process telemetry & termination' },
            { id: 'apps', label: 'Apps Explorer', icon: LayoutGrid, tip: 'Installed applications on target' },
            { id: 'keylogger', label: 'Keystroke Monitor', icon: Keyboard, tip: 'Live keystroke capture feed' },
            { id: 'files', label: 'File & Loot', icon: FolderOpen, tip: 'Remote filesystem & live preview' },
            { id: 'clipboard', label: 'Clipboard Stream', icon: Clipboard, tip: 'Live clipboard monitor' },
            { id: 'database', label: 'History & Logs', icon: Database, tip: 'Historical command executions' },
            { id: 'settings', label: 'Server Config', icon: Settings, tip: 'C2 network & server parameters' },
          ].map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <Tooltip key={item.id} text={item.tip} position="right">
                <button
                  onClick={() => setActiveTab(item.id as any)}
                  className={`w-full flex items-center space-x-2.5 px-2.5 py-2 rounded-md text-xs font-medium transition-colors ${
                    isActive ? 'bg-c2accent text-white font-semibold shadow-sm' : 'text-slate-300 hover:bg-c2card hover:text-white'
                  }`}
                >
                  <Icon className={`w-4 h-4 ${isActive ? 'text-white' : 'text-slate-400'}`} />
                  <span>{item.label}</span>
                </button>
              </Tooltip>
            );
          })}
        </div>
      </div>
      <div className="p-2.5 bg-c2card border border-c2border rounded-lg">
        <div className="flex items-center justify-between text-xs text-slate-300 mb-1">
          <span className="text-[11px] font-semibold">C2 Network</span>
          <span className={`flex items-center text-[10px] font-bold ${c2ConnectionStatus === 'connected' ? 'text-emerald-400' : 'text-amber-400'}`}>
            <span className={`h-1.5 w-1.5 rounded-full mr-1.5 ${c2ConnectionStatus === 'connected' ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`}></span>
            {c2Mode === 'cloud' ? 'RENDER CLOUD' : 'LOCAL'}
          </span>
        </div>
        <div className="text-[10px] text-slate-400 font-mono flex items-center justify-between mt-1">
          <span className="truncate max-w-[110px]" title={c2Mode === 'cloud' ? c2ServerUrl : `Port ${serverPort}`}>
            {c2Mode === 'cloud' ? 'onrender.com' : `Port ${serverPort}`}
          </span>
          <span className="text-c2cyan font-bold">{clients.length} Client{clients.length === 1 ? '' : 's'}</span>
        </div>
      </div>
    </div>
  );
}
