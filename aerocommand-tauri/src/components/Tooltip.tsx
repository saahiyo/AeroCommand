import React from 'react';

interface TooltipProps {
  children: React.ReactNode;
  text: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
}

const posClasses = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
  left: 'right-full top-1/2 -translate-y-1/2 mr-2',
  right: 'left-full top-1/2 -translate-y-1/2 ml-2'
};

const arrowClasses = {
  top: 'bottom-[-5px] left-1/2 -translate-x-1/2 border-r border-b border-slate-700',
  bottom: 'top-[-5px] left-1/2 -translate-x-1/2 border-l border-t border-slate-700',
  left: 'right-[-5px] top-1/2 -translate-y-1/2 border-r border-t border-slate-700',
  right: 'left-[-5px] top-1/2 -translate-y-1/2 border-l border-b border-slate-700'
};

export default function Tooltip({ children, text, position = 'top' }: TooltipProps) {
  return (
    <div className="group relative flex items-center">
      {children}
      <div className={`absolute z-50 invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-all duration-200 pointer-events-none whitespace-nowrap bg-slate-800 text-slate-100 text-[10px] px-2 py-1 rounded border border-c2border shadow-xl ${posClasses[position]}`}>
        {text}
        <div className={`absolute w-2 h-2 bg-slate-800 transform rotate-45 ${arrowClasses[position]}`}></div>
      </div>
    </div>
  );
}
