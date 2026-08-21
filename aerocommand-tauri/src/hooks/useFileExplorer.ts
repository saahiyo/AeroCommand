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

  const parseFileList = useCallback((output: string) => {
    try {
      const data = JSON.parse(output.replace('[JSON_FILES]', ''));
      const items: FileEntry[] = data.files || [];
      const truncated = data.truncated || false;
      const count = data.count || items.length || 0;

      setFileList(items);
      setFileTruncated(truncated);
      setFileTotalCount(count);
      setFileError('');
    } catch {
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
  }, [currentPath]);

  const setCache = useCallback((path: string, items: FileEntry[], truncated: boolean, count: number) => {
    const key = normPath(path);
    if (dirCacheRef.current.size >= MAX_CACHE) {
      const firstKey = dirCacheRef.current.keys().next().value;
      if (firstKey) dirCacheRef.current.delete(firstKey);
    }
    dirCacheRef.current.set(key, { items, truncated, count });
  }, []);

  // parseFileList that also caches under given path
  const parseAndCache = useCallback((output: string, pathForCache: string) => {
    try {
      const data = JSON.parse(output.replace('[JSON_FILES]', ''));
      const items: FileEntry[] = data.files || [];
      const truncated = !!data.truncated;
      const count = data.count || items.length || 0;
      setFileList(items);
      setFileTruncated(truncated);
      setFileTotalCount(count);
      setFileError('');
      setCache(pathForCache, items, truncated, count);
    } catch {
      parseFileList(output);
    }
  }, [parseFileList, setCache]);

  const listDrives = useCallback(() => {
    executeCommand('ls -a .', true);
    setCurrentPath('System Drives');
    navHistoryRef.current = [];
  }, [executeCommand]);

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
      if (!navHistoryRef.current.includes(normalized)) {
        navHistoryRef.current.push(currentPath);
      }
      return;
    }

    setIsFilesLoading(true);
    setFileError('');
    if (currentPath && normalized !== currentPath) {
      navHistoryRef.current.push(currentPath);
    }
    setCurrentPath(normalized);
    executeCommand(`ls "${path}"`, true);
    browsingIndicatorRef.current = setTimeout(() => setIsFilesLoading(false), 3000);
  }, [currentPath, executeCommand]);

  const goBack = useCallback(() => {
    const history = navHistoryRef.current;
    if (history.length === 0) return;
    const prevPath = history.pop()!;
    const cached = dirCacheRef.current.get(normPath(prevPath));
    if (cached) {
      setFileList(cached.items);
      setFileTruncated(cached.truncated);
      setFileTotalCount(cached.count);
      setFileError('');
    } else {
      browseFolder(prevPath, true);
    }
    setCurrentPath(prevPath);
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
