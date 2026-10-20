import React, { useEffect, useRef, useState } from "react";

export default function ImageViewer({
  src,
  alt = "图片预览",
  onClose,
}: {
  src: string;
  alt?: string;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "+" || e.key === "=") setScale((s) => Math.min(5, s + 0.25));
      if (e.key === "-") setScale((s) => Math.max(0.25, s - 0.25));
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) void rootRef.current?.requestFullscreen?.();
    else void document.exitFullscreen?.();
  };
  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const delta = event.deltaY < 0 ? 0.25 : -0.25;
    setScale((current) => Math.min(5, Math.max(0.25, current + delta)));
  };
  const beginDrag = (event: React.PointerEvent<HTMLImageElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = { x: event.clientX, y: event.clientY, left: position.x, top: position.y };
    setDragging(true);
  };
  const drag = (event: React.PointerEvent<HTMLImageElement>) => {
    if (!dragStart.current) return;
    setPosition({ x: dragStart.current.left + event.clientX - dragStart.current.x, y: dragStart.current.top + event.clientY - dragStart.current.y });
  };
  const endDrag = () => {
    dragStart.current = null;
    setDragging(false);
  };
  return (
    <div className="image-viewer" ref={rootRef} role="dialog" aria-modal="true" aria-label={alt} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="image-viewer-toolbar">
        <button onClick={() => setScale((s) => Math.max(0.25, s - 0.25))} aria-label="缩小">−</button>
        <span>{Math.round(scale * 100)}%</span>
        <button onClick={() => setScale((s) => Math.min(5, s + 0.25))} aria-label="放大">＋</button>
        <button onClick={() => { setScale(1); setPosition({ x: 0, y: 0 }); }}>重置</button>
        <button onClick={toggleFullscreen}>全屏</button>
        <button onClick={onClose} aria-label="关闭">×</button>
      </div>
      <div className="image-viewer-content" onWheel={handleWheel}>
        <img
          src={src}
          alt={alt}
          className={dragging ? "dragging" : ""}
          style={{ transform: `translate(${position.x}px, ${position.y}px) scale(${scale})` }}
          draggable={false}
          onPointerDown={beginDrag}
          onPointerMove={drag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      </div>
    </div>
  );
}
