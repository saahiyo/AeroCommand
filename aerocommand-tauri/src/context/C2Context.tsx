import React, { createContext, useContext, useState, useMemo, useCallback } from 'react';
import type { Client } from '../types';

type C2Mode = 'cloud' | 'local';
type ConnStatus = 'connected' | 'connecting' | 'error';

interface C2ContextValue {
  c2Mode: C2Mode;
  setC2Mode: (m: C2Mode) => void;
  c2ServerUrl: string;
  setC2ServerUrl: (v: string) => void;
  c2OperatorToken: string;
  setC2OperatorToken: (v: string) => void;
  c2ConnectionStatus: ConnStatus;
  setC2ConnectionStatus: (s: ConnStatus) => void;
  authHeader: Record<string, string>;
  serverPort: string;
  clients: Client[];
  setClients: React.Dispatch<React.SetStateAction<Client[]>>;
  selectedClientId: string;
  setSelectedClientId: (id: string) => void;
  showToast: (msg: string) => void;
}

const C2Context = createContext<C2ContextValue | null>(null);

function isValidC2Url(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && !(u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return false;
    if (url.includes('javascript:') || url.includes('data:')) return false;
    return !!u.hostname;
  } catch { return false; }
}

function sanitizeToken(t: string): string { return t.trim().slice(0, 256); }

export function C2Provider({ children }: { children: React.ReactNode }) {
  const [c2ServerUrlRaw, setC2ServerUrlRaw] = useState<string>(() => {
    const stored = localStorage.getItem('c2_server_url');
    if (stored && isValidC2Url(stored)) return stored;
    return 'https://your-c2-service.onrender.com';
  });
  const [c2OperatorTokenRaw, setC2OperatorTokenRaw] = useState<string>(() => {
    const stored = localStorage.getItem('c2_operator_token');
    if (stored && stored.length >= 8) return stored;
    return '';
  });
  const [c2ModeRaw, setC2ModeRaw] = useState<C2Mode>(() => {
    const m = localStorage.getItem('c2_mode');
    return m === 'local' || m === 'cloud' ? m : 'cloud';
  });
  const [c2ConnectionStatus, setC2ConnectionStatus] = useState<ConnStatus>('connecting');
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string>('');
  const [serverPort] = useState('443');
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  }, []);

  const authHeader = useMemo(() => ({ 'Authorization': `Bearer ${c2OperatorTokenRaw}` }), [c2OperatorTokenRaw]);

  const setC2ServerUrl = useCallback((v: string) => {
    const trimmed = v.trim();
    if (trimmed && !isValidC2Url(trimmed)) {
      showToast('Invalid C2 URL — must be https://');
      return;
    }
    setC2ServerUrlRaw(trimmed);
    if (trimmed) localStorage.setItem('c2_server_url', trimmed);
    else localStorage.removeItem('c2_server_url');
  }, [showToast]);

  const setC2OperatorToken = useCallback((v: string) => {
    const t = sanitizeToken(v);
    if (t && t.length < 16) {
      showToast('Token too short — use ≥16 chars');
    }
    setC2OperatorTokenRaw(t);
    if (t) {
      // NOTE: plaintext localStorage is not secure; Tauri stronghold/keychain should be used in production
      localStorage.setItem('c2_operator_token', t);
    } else localStorage.removeItem('c2_operator_token');
  }, [showToast]);

  const setC2Mode = useCallback((m: C2Mode) => {
    setC2ModeRaw(m);
    localStorage.setItem('c2_mode', m);
  }, []);

  const value: C2ContextValue = {
    c2Mode: c2ModeRaw, setC2Mode, c2ServerUrl: c2ServerUrlRaw, setC2ServerUrl,
    c2OperatorToken: c2OperatorTokenRaw, setC2OperatorToken,
    c2ConnectionStatus, setC2ConnectionStatus,
    authHeader, serverPort,
    clients, setClients,
    selectedClientId, setSelectedClientId,
    showToast,
  };

  return (
    <C2Context.Provider value={value}>
      {children}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center space-x-2.5 bg-[#1A2235] border border-c2accent text-white px-4 py-3 rounded-xl shadow-2xl animate-fade-in text-xs font-medium">
          <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></div>
          <span>{toastMessage}</span>
        </div>
      )}
    </C2Context.Provider>
  );
}

export function useC2() {
  const ctx = useContext(C2Context);
  if (!ctx) throw new Error('useC2 must be used within C2Provider');
  return ctx;
}
