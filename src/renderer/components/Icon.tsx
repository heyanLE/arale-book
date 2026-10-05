export function Icon({kind}: {kind: 'pen'|'eraser'|'text'|'sidebar'|'back'|'grid'|'list'|'folder'|'plus'|'settings'|'theme'|'mouse'|'select'|'system'|'exit'}): JSX.Element {
  return <svg className="reader-tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind==='pen' && <><path d="m14 5 5 5M4 20l4-1 12-12a2.1 2.1 0 0 0-3-3L5 16l-1 4Z"/><path d="m5 16 3 3"/></>}
    {kind==='eraser' && <><path d="m15 4 6 6-10 10H7l-4-4L15 4Z"/><path d="m8 11 6 6M11 20h10"/></>}
    {kind==='text' && <path d="M4 6V4h16v2M12 4v16M8 20h8"/>}
    {kind==='mouse' && <><rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 3v6M6 10h12"/></>}
    {kind==='select' && <path d="m5 3 14 10-7 1-3 7L5 3Z"/>}
    {kind==='system' && <><rect x="3" y="4" width="18" height="15" rx="2"/><path d="M3 15h18M8 22h8M12 19v3"/></>}
    {kind==='exit' && <path d="M9 3v6H3M15 3v6h6M3 15h6v6M21 15h-6v6"/>}
    {kind==='sidebar' && <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></>}
    {kind==='back' && <path d="m10 5-7 7 7 7M3 12h18"/>}
    {kind==='grid' && <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>}
    {kind==='list' && <path d="M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01"/>}
    {kind==='folder' && <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>}
    {kind==='plus' && <path d="M12 4v16M4 12h16"/>}
    {kind==='settings' && <><path d="m10 3-1 3-3 1-3 3 2 2-1 4 4 1 2 4 3-2 4 1 1-4 3-2-2-3 1-4-4-1-2-3Z"/><circle cx="12" cy="12" r="3"/></>}
    {kind==='theme' && <><circle cx="12" cy="12" r="8"/><path d="M12 4v16"/></>}
  </svg>;
}
