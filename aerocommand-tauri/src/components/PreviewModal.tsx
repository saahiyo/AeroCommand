import { X, Eye, AlertCircle, Download } from 'lucide-react';
import type { PreviewData } from '../types';

interface PreviewModalProps {
  previewOpen: boolean;
  previewData: PreviewData | null;
  isPreviewLoading: boolean;
  setPreviewOpen: (v: boolean) => void;
}

function saveImage(data: PreviewData) {
  if (!data.data) return;
  const link = document.createElement('a');
  link.href = `data:${data.mime || 'image/png'};base64,${data.data}`;
  link.download = data.name || 'preview.png';
  link.click();
}

export default function PreviewModal({
  previewOpen, previewData, isPreviewLoading, setPreviewOpen
}: PreviewModalProps) {
  if (!previewOpen) return null;

  const failed = previewData?.status === 'error';
  const unsupported = previewData?.status === 'unsupported';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={() => setPreviewOpen(false)}
    >
      <div
        className="bg-c2card border border-c2border rounded-2xl shadow-2xl flex flex-col w-[720px] max-w-[92vw] max-h-[85vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-c2border flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2.5 min-w-0">
            <Eye className="w-4 h-4 text-c2cyan shrink-0" />
            <span className="text-xs font-bold text-white truncate">{previewData?.name || 'Preview'}</span>
            {previewData?.size && (
              <span className="text-[10px] font-mono text-slate-500 shrink-0">{previewData.size}</span>
            )}
          </div>
          <div className="flex items-center space-x-1 shrink-0">
            {previewData?.type === 'image' && previewData.data && (
              <button
                onClick={() => saveImage(previewData)}
                title="Save image"
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-c2pill transition-colors"
              >
                <Download className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={() => setPreviewOpen(false)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-red-500/20 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 bg-c2bg/60">
          {isPreviewLoading ? (
            <div className="h-full flex flex-col items-center justify-center space-y-3 text-slate-400">
              <RefreshSpinner />
              <span className="text-xs font-semibold uppercase tracking-wider">Fetching from target...</span>
            </div>
          ) : failed || unsupported ? (
            <div className="h-full flex flex-col items-center justify-center space-y-2 px-10 text-center">
              <AlertCircle className={`w-8 h-8 ${failed ? 'text-red-400' : 'text-slate-500'}`} />
              <div className="text-xs font-bold uppercase tracking-wider text-slate-200">
                {failed ? 'Preview failed' : 'Cannot preview this file'}
              </div>
              <div className="text-[11px] text-slate-400">{previewData?.message}</div>
              {unsupported && (
                <div className="text-[11px] text-c2cyan mt-1">Try the Download button instead</div>
              )}
            </div>
          ) : previewData?.status === 'ok' && previewData.type === 'image' && previewData.data ? (
            <div className="h-full overflow-auto flex items-center justify-center p-6">
              <img
                src={`data:${previewData.mime || 'image/png'};base64,${previewData.data}`}
                alt={previewData.name}
                className="max-w-full max-h-full object-contain rounded-xl border border-c2border shadow-2xl"
              />
            </div>
          ) : previewData?.status === 'ok' && previewData.content ? (
            <pre className="h-full overflow-auto text-[11px] font-mono text-slate-300 p-4 whitespace-pre-wrap leading-relaxed">
              {previewData.content}
            </pre>
          ) : (
            <div className="h-full flex flex-col items-center justify-center space-y-2 text-slate-500">
              <Eye className="w-8 h-8 opacity-20" />
              <span className="text-xs">No preview data</span>
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-c2border text-[10px] font-mono text-slate-500 shrink-0">
          ESC to close
        </div>
      </div>
    </div>
  );
}

function RefreshSpinner() {
  return <div className="w-8 h-8 border-2 border-c2accent border-t-transparent rounded-full animate-spin" />;
}
