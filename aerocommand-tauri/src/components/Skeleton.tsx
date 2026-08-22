export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse bg-c2pill border border-c2border/60 rounded ${className}`} />;
}

export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  // Mirrors actual table header + row layout — full-width, not left-clumped
  const colWidths = ['w-[28%]', 'w-[10%]', 'w-[14%]', 'w-[14%]', 'w-[22%]', 'w-[12%]'];
  return (
    <div className="w-full">
      <div className="flex gap-2 px-3 py-3 border-b border-c2border bg-slate-900/30">
        {Array.from({ length: cols }).map((_, j) => (
          <Skeleton key={j} className={`h-3 rounded ${colWidths[j % colWidths.length]} opacity-60`} />
        ))}
      </div>
      <div className="divide-y divide-c2border/30">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-2 px-3 py-3" style={{ opacity: 0.9 - i * 0.07 }}>
            {Array.from({ length: cols }).map((__, j) => (
              <Skeleton key={j} className={`h-3.5 rounded ${colWidths[j % colWidths.length]} ${j === 0 ? 'h-4' : ''}`} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function GridSkeleton({ cards = 8 }: { cards?: number }) {
  return (
    <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
      {Array.from({ length: cards }).map((_, i) => (
        <div key={i} className="p-3 bg-c2card border border-c2border rounded-xl space-y-3">
          <div className="flex gap-3">
            <Skeleton className="w-10 h-10 rounded-lg shrink-0" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-2 w-1/2" />
            </div>
          </div>
          <Skeleton className="h-2 w-full" />
          <Skeleton className="h-6 w-full rounded-md" />
        </div>
      ))}
    </div>
  );
}

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="divide-y divide-c2border/50">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="p-3 flex items-center gap-3">
          <Skeleton className="w-4 h-4 rounded" />
          <Skeleton className="w-8 h-8 rounded-lg" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-2 w-24" />
          </div>
          <Skeleton className="h-6 w-16 rounded" />
        </div>
      ))}
    </div>
  );
}
