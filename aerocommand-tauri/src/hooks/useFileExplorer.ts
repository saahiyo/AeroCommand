import { useState, useRef, useCallback } from 'react';
import type { FileEntry } from '../types';

const MAX_CACHE = 100;

function normPath(path: string) {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

export function useFileExplorer(executeCommand: (cmd: string, silent?: boolean) => void) {
  const [currentPath, setCurrentPath] = useState<string>('');
  const [fileList, setFileList] = useState<FileEntry[]>([]);
  const [isFilesLoading, setIsFilesLoading] = useState(false);
  const [fileError, setFileError] = useState<string>('');
  const [fileTruncated, setFileTruncated] = useState(false);
  const [fileTotalCount, setFileTotalCount] = useState(0);
  const navHistoryRef = useRef<string[]>([]);
  const browsingIndicatorRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirCacheRef = useRef<Map<string, { items: FileEntry[], truncated: boolean, count: number }>>(new Map());
  // Tracks the most recent navigation request so out-of-order/stale listings
  // can be cached without clobbering the directory the user is currently viewing
  const pendingBrowseRef = useRef<{ key: string; at: number; fulfilled: boolean } | null>(null);
  // When set, the next browseFolder call won't record a history entry (used by goBack refetch)
  const skipHistoryRef = useRef(false);

  const PENDING_WINDOW_MS = 15000;

  const markPendingBrowse = useCallback((path: string) => {
    pendingBrowseRef.current = { key: normPath(path).toLowerCase(), at: Date.now(), fulfilled: false };
  }, []);

  // Decide whether an incoming listing should update the visible view.
  // Returns false when it belongs to a request the user has already moved past.
  const shouldApplyListing = useCallback((resolvedPath: string) => {
    const pending = pendingBrowseRef.current;
    if (!pending) return true;
    if (Date.now() - pending.at > PENDING_WINDOW_MS) {
      pendingBrowseRef.current = null;
      return true;
    }
    const resolvedKey = normPath(resolvedPath).toLowerCase();
    // SPECIAL:* paths resolve server-side to real Windows paths we can't predict,
    // so the first response after such a request is always accepted
    const requestedSpecial = pending.key.startsWith('special:');
    if (!pending.fulfilled && (requestedSpecial || resolvedKey === pending.key)) {
      pending.fulfilled = true;
      return true;
    }
    return false;
  }, []);

  const setCache = useCallback((path: string, items: FileEntry[], truncated: boolean, count: number) => {
    const key = normPath(path);
    if (dirCacheRef.current.size >= MAX_CACHE) {
      const firstKey = dirCacheRef.current.keys().next().value;
      if (firstKey) dirCacheRef.current.delete(firstKey);
    }
    dirCacheRef.current.set(key, { items, truncated, count });
  }, []);

  const parseFileList = useCallback((output: string) => {
    setIsFilesLoading(false);
    if (browsingIndicatorRef.current) clearTimeout(browsingIndicatorRef.current);

    if (output.startsWith('[-]')) {
      setFileError(output.replace('[-]', '').trim());
      setFileList([]);
      return;
    }

    try {
      const data = JSON.parse(output.replace('[JSON_FILES]', ''));
      const items: FileEntry[] = data.items || data.files || [];
      const truncated = data.truncated || false;
      const count = data.count || items.length || 0;

      if (data.path) {
        const resolvedPath = normPath(data.path);
        setCache(resolvedPath, items, truncated, count);
        // Stale listing for a directory the user already left — cache silently
        if (!shouldApplyListing(data.path)) return;
        setCurrentPath(resolvedPath);
      }

      setFileList(items);
      setFileTruncated(truncated);
      setFileTotalCount(count);
      setFileError('');
    } catch {
      // Structured listing that failed to parse (e.g. output cut off mid-JSON) —
      // never fall through to text parsing, it produces a single garbage row
      if (output.includes('[JSON_FILES]')) {
        setFileError('Directory listing was corrupted or truncated in transit — refresh to retry');
        setFileList([]);
        return;
      }
      const lines = output.split('\n');
      const items: FileEntry[] = [];
      lines.forEach(line => {
        if (!line.trim()) return;
        const isDir = line.includes('DIR') || line.includes('DRIVE');
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 4) {
          items.push({
            name: parts[parts.length - 1],
            size: isDir ? '--' : parts.slice(3, -1).join(' ') || '--',
            date: parts.slice(0, 3).join(' '),
            is_dir: isDir,
          });
        }
      });
      setFileList(items);
      setFileError('');
    }
  }, [setCache, shouldApplyListing]);

  // parseFileList that also caches under given path
  const parseAndCache = useCallback((output: string, pathForCache: string) => {
    setIsFilesLoading(false);
    if (browsingIndicatorRef.current) clearTimeout(browsingIndicatorRef.current);

    if (output.startsWith('[-]')) {
      setFileError(output.replace('[-]', '').trim());
      setFileList([]);
      return;
    }

    try {
      const data = JSON.parse(output.replace('[JSON_FILES]', ''));
      const items: FileEntry[] = data.items || data.files || [];
      const truncated = !!data.truncated;
      const count = data.count || items.length || 0;
      
      if (data.path) {
        const resolvedPath = normPath(data.path);
        setCache(resolvedPath, items, truncated, count);
        // Stale listing for a directory the user already left — cache silently
        if (!shouldApplyListing(data.path)) return;
        setCurrentPath(resolvedPath);
      }

      setFileList(items);
      setFileTruncated(truncated);
      setFileTotalCount(count);
      setFileError('');
      setCache(pathForCache, items, truncated, count);
    } catch {
      parseFileList(output);
    }
  }, [parseFileList, setCache, shouldApplyListing]);

  const listDrives = useCallback(() => {
    executeCommand('ls "DRIVES"', true);
    markPendingBrowse('System Drives');
    setCurrentPath('System Drives');
    navHistoryRef.current = [];
  }, [executeCommand, markPendingBrowse]);

  const browseFolder = useCallback((path: string, forceRefresh = false) => {
    // Basic injection guard: reject shell metacharacters
    if (/[;&|`$]/.test(path)) {
      setFileError('Invalid path: shell metacharacters not allowed');
      return;
    }
    if (browsingIndicatorRef.current) clearTimeout(browsingIndicatorRef.current);
    const normalized = normPath(path);
    const cacheKey = normalized;

    if (!forceRefresh && dirCacheRef.current.has(cacheKey)) {
      const cached = dirCacheRef.current.get(cacheKey)!;
      setFileList(cached.items);
      setFileTruncated(cached.truncated);
      setFileTotalCount(cached.count);
      setFileError('');
      setCurrentPath(normalized);
      pendingBrowseRef.current = null;
      if (navHistoryRef.current[navHistoryRef.current.length - 1] !== currentPath) {
        navHistoryRef.current.push(currentPath);
      }
      return;
    }

    setIsFilesLoading(true);
    setFileList([]);
    setFileError('');
    markPendingBrowse(path);
    const recordHistory = !skipHistoryRef.current;
    skipHistoryRef.current = false;
    if (recordHistory && currentPath && normalized !== currentPath && navHistoryRef.current[navHistoryRef.current.length - 1] !== currentPath) {
      navHistoryRef.current.push(currentPath);
    }
    setCurrentPath(normalized);
    executeCommand(`ls "${path}"`, true);
    browsingIndicatorRef.current = setTimeout(() => setIsFilesLoading(false), 5000);
  }, [currentPath, executeCommand, markPendingBrowse]);

  const goBack = useCallback(() => {
    const history = navHistoryRef.current;
    if (history.length === 0) return;
    const prevPath = history.pop()!;
    const cached = dirCacheRef.current.get(normPath(prevPath));
    pendingBrowseRef.current = null;
    if (cached) {
      setFileList(cached.items);
      setFileTruncated(cached.truncated);
      setFileTotalCount(cached.count);
      setFileError('');
      setCurrentPath(prevPath);
    } else {
      // No cached listing — refetch without recording another history entry
      skipHistoryRef.current = true;
      browseFolder(prevPath, true);
    }
  }, [browseFolder]);

  return {
    currentPath, setCurrentPath,
    fileList, setFileList,
    isFilesLoading, setIsFilesLoading,
    fileError, setFileError,
    fileTruncated, setFileTruncated,
    fileTotalCount, setFileTotalCount,
    navHistoryRef, browsingIndicatorRef, dirCacheRef,
    normPath, parseFileList, parseAndCache, listDrives, browseFolder, goBack,
  };
}
