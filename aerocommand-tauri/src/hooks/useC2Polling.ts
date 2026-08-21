import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Client, CommandLog, LootFile, PreviewData } from '../types';

interface UseC2PollingOpts {
  activeTab: string;
  isFilesLoading: boolean;
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
  parseFileList: (output: string) => void;
  appendTermLog: (lines: string[]) => void;
  setC2ConnectionStatus: (s: 'connected' | 'connecting' | 'error') => void;
  showToast: (msg: string) => void;
}

export function useC2Polling(opts: UseC2PollingOpts) {
  const {
    activeTab, isFilesLoading, c2Mode, c2ServerUrl, authHeader,
    setClients, setLogs, setLootFiles,
    setProcessList, setIsProcessesLoading,
    setPreviewOpen, setPreviewData,
    parseFileList, appendTermLog,
    setC2ConnectionStatus, showToast,
  } = opts;

  const logsRef = useRef<CommandLog[]>([]);
  const printedIdsRef = useRef<Set<number>>(new Set());

  // Cap printedIds to avoid unbounded growth
  const MAX_PRINTED = 1000;

  useEffect(() => {
    const pollInterval = (activeTab === 'files' && isFilesLoading) ? 1000 : 2000;
    let cancelled = false;
    const abortControllers: AbortController[] = [];

    const fetchData = async () => {
      if (cancelled) return;
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
            } else {
              setC2ConnectionStatus('error');
              let errMsg = `Server error: ${clientsRes.status}`;
              try { const body = await clientsRes.json(); if (body.error) errMsg = body.error; } catch {}
              showToast(`Auth failed: ${errMsg}`);
            }
          } catch (e: any) {
            if (e?.name !== 'AbortError') {
              setC2ConnectionStatus('error');
              showToast(`Connection failed: ${e}`);
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

        const newTermLines: string[] = [];
        backendLogs.forEach((log) => {
          if (printedIdsRef.current.has(log.id)) return;
          if (log.output.includes('[JSON_PREVIEW]')) {
            printedIdsRef.current.add(log.id);
            try {
              const jsonStr = log.output.replace('[JSON_PREVIEW]', '');
              const parsed = JSON.parse(jsonStr);
              if (parsed.status === 'ok' && parsed.type === 'image') {
                setPreviewOpen(true);
                setPreviewData(parsed);
              }
            } catch {}
          } else if (log.output.includes('[JSON_PROCS]')) {
            printedIdsRef.current.add(log.id);
            try {
              const jsonStr = log.output.replace('[JSON_PROCS]', '');
              const procs = JSON.parse(jsonStr);
              setProcessList(procs);
              setIsProcessesLoading(false);
            } catch {}
          } else if (log.output.includes('[JSON_FILES]')) {
            // mark as printed to avoid re-trigger? parseFileList handles cache update
            if (!printedIdsRef.current.has(log.id)) {
              printedIdsRef.current.add(log.id);
              parseFileList(log.output);
            }
          } else if (log.status === 'SUCCESS' && log.output && !log.output.startsWith('Queued') && !printedIdsRef.current.has(log.id)) {
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
  }, [activeTab, isFilesLoading, c2Mode, c2ServerUrl, authHeader, setC2ConnectionStatus, showToast, parseFileList, appendTermLog, setClients, setLogs, setLootFiles, setProcessList, setIsProcessesLoading, setPreviewOpen, setPreviewData]);
}
