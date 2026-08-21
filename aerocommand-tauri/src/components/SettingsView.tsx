interface SettingsViewProps {
  c2Mode: 'cloud' | 'local';
  setC2Mode: (m: 'cloud' | 'local') => void;
  c2ServerUrl: string;
  setC2ServerUrl: (v: string) => void;
  c2OperatorToken: string;
  setC2OperatorToken: (v: string) => void;
  c2ConnectionStatus: 'connected' | 'connecting' | 'error';
  setC2ConnectionStatus: (s: 'connected' | 'connecting' | 'error') => void;
  showToast: (msg: string) => void;
}

export default function SettingsView({
  c2Mode, setC2Mode, c2ServerUrl, setC2ServerUrl,
  c2OperatorToken, setC2OperatorToken, c2ConnectionStatus, setC2ConnectionStatus, showToast
}: SettingsViewProps) {
  return (
    <div className="space-y-5 max-w-2xl">
      <div>
        <h2 className="text-sm font-bold text-white uppercase tracking-wider">C2 Server Configuration</h2>
        <p className="text-[11px] text-slate-400 mt-0.5">Manage your remote cloud C2 connection or switch to local standalone mode</p>
      </div>

      <div className="bg-c2card border border-c2border rounded-xl p-5 shadow-card space-y-4">
        <div>
          <label className="text-xs font-bold text-white uppercase tracking-wider block mb-2">Connection Mode</label>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => { setC2Mode('cloud'); }}
              className={`p-3.5 rounded-lg border text-left transition-all ${
                c2Mode === 'cloud'
                  ? 'bg-[#1A2235] border-c2accent shadow-sm'
                  : 'bg-c2pill/50 border-c2border hover:border-c2borderlight text-slate-400'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold text-white">☁️ Render Cloud Remote</span>
                {c2Mode === 'cloud' && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-c2accent text-white">ACTIVE</span>}
              </div>
              <p className="text-[11px] text-slate-400">Connect to your live HTTPS server on Render to manage remote fleet anywhere.</p>
            </button>

            <button
              onClick={() => { setC2Mode('local'); }}
              className={`p-3.5 rounded-lg border text-left transition-all ${
                c2Mode === 'local'
                  ? 'bg-[#1A2235] border-c2accent shadow-sm'
                  : 'bg-c2pill/50 border-c2border hover:border-c2borderlight text-slate-400'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold text-white">💻 Local Standalone</span>
                {c2Mode === 'local' && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-c2accent text-white">ACTIVE</span>}
              </div>
              <p className="text-[11px] text-slate-400">Run embedded C2 listener directly on your machine on port 443.</p>
            </button>
          </div>
        </div>

        {c2Mode === 'cloud' && (
          <div className="space-y-3 pt-3 border-t border-c2border/60">
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1.5">Render Cloud C2 Endpoint URL</label>
              <div className="flex items-center space-x-2">
                <input
                  type="text"
                  value={c2ServerUrl}
                  onChange={(e) => setC2ServerUrl(e.target.value)}
                  placeholder="https://your-c2-service.onrender.com"
                  className="flex-1 bg-c2bg border border-c2border focus:border-c2accent rounded-md px-3 py-2 text-xs font-mono text-white outline-none transition-colors"
                />
                <button
                  onClick={() => {
                    const trimmed = c2ServerUrl.trim();
                    setC2ServerUrl(trimmed);
                    showToast('Server URL saved! Testing connection...');
                    setC2ConnectionStatus('connecting');
                  }}
                  className="px-3.5 py-2 bg-c2accent hover:bg-blue-600 text-white rounded-md text-xs font-bold transition-colors shadow-sm"
                >
                  Save & Connect
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1.5">Operator Token</label>
              <div className="flex items-center space-x-2">
                <input
                  type="password"
                  value={c2OperatorToken}
                  onChange={(e) => setC2OperatorToken(e.target.value)}
                  placeholder="Enter your OPERATOR_TOKEN from .env"
                  className="flex-1 bg-c2bg border border-c2border focus:border-c2accent rounded-md px-3 py-2 text-xs font-mono text-white outline-none transition-colors"
                />
                <button
                  onClick={() => {
                    const trimmed = c2OperatorToken.trim();
                    setC2OperatorToken(trimmed);
                    showToast('Operator token saved! Testing connection...');
                    setC2ConnectionStatus('connecting');
                  }}
                  className="px-3.5 py-2 bg-c2accent hover:bg-blue-600 text-white rounded-md text-xs font-bold transition-colors shadow-sm"
                >
                  Save Token
                </button>
              </div>
            </div>

            <div className="flex items-center space-x-2 text-xs">
              <span className="text-slate-400">Connection Status:</span>
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold flex items-center space-x-1.5 ${
                c2ConnectionStatus === 'connected'
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                  : c2ConnectionStatus === 'error'
                    ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                    : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
              }`}>
                <span className={`h-1.5 w-1.5 rounded-full ${
                  c2ConnectionStatus === 'connected' ? 'bg-emerald-400' :
                  c2ConnectionStatus === 'error' ? 'bg-red-400' : 'bg-amber-400 animate-pulse'
                }`} />
                {c2ConnectionStatus === 'connected' ? 'CONNECTED' :
                 c2ConnectionStatus === 'error' ? 'ERROR' : 'CONNECTING...'}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
