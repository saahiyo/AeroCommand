import { X, ZoomIn, ZoomOut, Eye } from 'lucide-react';
import Tooltip from './Tooltip';
import type { PreviewData } from '../types';

interface PreviewModalProps {
  previewOpen: boolean;
  previewData: PreviewData | null;
  isPreviewLoading: boolean;
  previewZoom: number;
  setPreviewZoom: (z: number) => void;
  copiedPath: boolean;
  setCopiedPath: (v: boolean) => void;
  setPreviewOpen: (v: boolean) => void;
}

export default function PreviewModal({
  previewOpen, previewData, isPreviewLoading,
  previewZoom, setPreviewZoom, copiedPath, setCopiedPath, setPreviewOpen
}: PreviewModalProps) {
  if (!previewOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={() => setPreviewOpen(false)}
    >
      <div
        className="relative bg-c2card border border-c2border rounded-xl shadow-2xl flex flex-col w-[680px] max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="px-5 py-3 border-b border-c2border flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2.5">
            <Eye className="w-4 h-4 text-c2cyan" />
            <span className="text-xs font-bold text-white uppercase tracking-wider">
              {previewData?.name || 'Preview'}
            </span>
            {previewData?.path && (
              <span className="text-[10px] text-slate-500 font-mono truncate max-w-[260px]">
                {previewData.path}
              </span>
            )}
          </div>
          <div className="flex items-center space-x-1.5">
            {/* Zoom controls */}
            <Tooltip text="Zoom out" position="bottom">
              <button
                onClick={() => setPreviewZoom(Math.max(0.25, previewZoom - 0.25))}
                className="p-1.5 hover:bg-slate-700 rounded text-slate-400 hover:text-white transition-colors"
              >
                <ZoomOut className="w-4 h-4" />
              </button>
            </Tooltip>
            <span className="text-[10px] text-slate-400 font-mono w-12 text-center">
              {Math.round(previewZoom * 100)}%
            </span>
            <Tooltip text="Zoom in" position="bottom">
              <button
                onClick={() => setPreviewZoom(previewZoom + 0.25)}
                className="p-1.5 hover:bg-slate-700 rounded text-slate-400 hover:text-white transition-colors"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
            </Tooltip>

            <div className="w-px h-4 bg-c2border mx-1" />

            {/* Copy path */}
            <Tooltip text={copiedPath ? 'Copied!' : 'Copy path'} position="bottom">
              <button
                onClick={() => {
                  if (previewData?.path) {
                    navigator.clipboard.writeText(previewData.path);
                    setCopiedPath(true);
                    setTimeout(() => setCopiedPath(false), 1500);
                  }
                }}
                className="p-1.5 hover:bg-slate-700 rounded text-slate-400 hover:text-white transition-colors"
              >
                {copiedPath ? (
                  <span className="text-[10px] text-emerald-400 font-bold">OK</span>
                ) : (
                  <span className="text-[10px] font-bold">CP</span>
                )}
              </button>
            </Tooltip>

            {/* Close */}
            <Tooltip text="Close (ESC)" position="bottom">
              <button
                onClick={() => setPreviewOpen(false)}
                className="p-1.5 hover:bg-red-500/20 hover:text-red-400 rounded text-slate-400 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </Tooltip>
          </div>
        </div>

        {/* Modal Content */}
        <div className="flex-1 overflow-hidden min-h-0">
          {isPreviewLoading ? (
            <div className="flex flex-col items-center justify-center h-full space-y-3 text-slate-400">
              <div className="w-8 h-8 border-2 border-c2accent border-t-transparent rounded-full animate-spin" />
              <span className="text-xs font-bold uppercase tracking-widest">Fetching preview...</span>
            </div>
          ) : previewData?.status === 'ok' ? (
            <div className="h-full overflow-auto flex items-center justify-center p-6 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-slate-900 to-slate-950">
              {previewData.type === 'image' && previewData.data ? (
                <img
                  src={`data:${previewData.mime || 'image/png'};base64,${previewData.data}`}
                  alt={previewData.name}
                  style={{ transform: `scale(${previewZoom})`, transformOrigin: 'center' }}
                  className="max-w-full max-h-full object-contain rounded-lg border border-c2border shadow-2xl transition-transform"
                />
              ) : previewData.content ? (
                <div className="w-full h-full bg-slate-900 rounded-lg border border-c2border overflow-hidden flex flex-col">
                  <div className="px-4 py-2 bg-slate-800/50 border-b border-c2border text-[9px] font-mono text-slate-500 uppercase tracking-widest flex items-center justify-between">
                    <span>{previewData.name}</span>
                    {previewData.size && <span>{previewData.size}</span>}
                  </div>
                  <pre
                    className="flex-1 text-[11px] font-mono text-slate-300 p-4 overflow-auto whitespace-pre-wrap leading-relaxed"
                    style={{ transform: `scale(${previewZoom})`, transformOrigin: 'top left' }}
                  >
                    {previewData.content}
                  </pre>
                </div>
              ) : (
                <div className="text-slate-500 text-xs italic">No preview data available</div>
              )}
            </div>
          ) : previewData?.status === 'error' ? (
            <div className="flex flex-col items-center justify-center h-full space-y-3 text-red-400">
              <div className="text-xs font-bold uppercase tracking-widest">Preview Error</div>
              <div className="text-[11px] text-slate-400">{previewData?.message || 'Failed to load preview'}</div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full space-y-3 text-slate-500">
              <Eye className="w-10 h-10 opacity-20" />
              <div className="text-xs italic">No preview data</div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-5 py-2.5 border-t border-c2border bg-slate-900/40 text-[10px] text-slate-500 flex items-center justify-between shrink-0">
          <span>Press <kbd className="px-1.5 py-0.5 bg-slate-800 border border-c2border rounded font-mono text-slate-300">ESC</kbd> to close</span>
          <span>AeroCommand Live Stream Engine</span>
        </div>
      </div>
    </div>
  );
}
