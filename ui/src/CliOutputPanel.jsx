import { useEffect, useRef, useState } from 'react';
import { Button } from '@headlessui/react';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Bottom-left anchored console dump (e.g. xi title menu save / export stream).
 * `log`: { title, text } | null
 * `autoClose` + `autoCloseMs` — dismiss after a countdown, drawn as the strip draining.
 * `onCancel` — kill in-flight streamed xi (shows Stop while running).
 *
 * One strip under the header carries the whole state: a blue sweep while xi is running,
 * then solid green or red for how it ended — and when auto-close is on, that same solid
 * bar is what drains away as the countdown.
 */
export function CliOutputPanel({
  log,
  onClose,
  onCancel,
  autoClose = false,
  autoCloseMs = 10000,
}) {
  const bodyRef = useRef(null);
  const barRef = useRef(null);
  const panelRef = useRef(null);
  const copiedTimer = useRef(0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // User-chosen size (bottom-left stays anchored, so a drag grows up/right).
  // Either dimension may be null until the user resizes that axis.
  const [size, setSize] = useState(null);
  const [copied, setCopied] = useState(false);

  const text = String(log?.text || '');
  const title = String(log?.title || '');
  const running = !!(text.includes('# running…')
    && !/\n# (done|exit |cancelled)/m.test(text)
    && !/· (ok|failed|cancelled)$/.test(title));
  // How it ended, read the same way `running` is: callers mark the outcome in the title
  // suffix, and a non-zero `# exit` line is the fallback for the ones that don't. A
  // cancelled job counts as failed — it stopped without finishing.
  const failed = /· (failed|cancelled)$/.test(title)
    || /^# exit (?!0\b)\d+/m.test(text)
    || /\n# cancelled/.test(text);
  const status = running ? 'running' : failed ? 'failed' : 'ok';
  const counting = autoClose && !running;

  // Stable key for the finished log — must NOT include live text, or every
  // streamed line / parent re-render would restart the 10s timer forever.
  const finishKey = log && !running ? (title || text.slice(0, 80)) : '';

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [log?.text, log?.title]);

  useEffect(() => {
    if (!autoClose || !finishKey) return undefined;
    const ms = Math.max(500, autoCloseMs || 10000);
    const t = window.setTimeout(() => onCloseRef.current?.(), ms);
    return () => window.clearTimeout(t);
  }, [autoClose, autoCloseMs, finishKey]);

  // Restart CSS countdown only when a finished log session begins.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || !autoClose || !finishKey) return;
    bar.style.animation = 'none';
    void bar.offsetWidth;
    bar.style.animation = '';
    bar.style.animationDuration = `${Math.max(500, autoCloseMs || 10000)}ms`;
  }, [autoClose, autoCloseMs, finishKey]);

  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const handleCopy = async () => {
    const payload = [title, text].filter(Boolean).join('\n');
    if (!payload) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(payload);
      ok = true;
    } catch {
      // Older/insecure contexts: fall back to a throwaway textarea + execCommand.
      try {
        const ta = document.createElement('textarea');
        ta.value = payload;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (!ok) return;
    setCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
  };

  // Drag a top/right edge (or the top-right corner) to resize. The panel is pinned
  // bottom-left, so a rightward drag adds width and an upward drag adds height.
  const startResize = (e, dir) => {
    if (e.button != null && e.button !== 0) return;
    const el = panelRef.current;
    if (!el) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = rect.width;
    const startH = rect.height;
    const wantW = dir.includes('e');
    const wantH = dir.includes('n');
    const minW = 360;
    const minH = 140;
    const maxW = window.innerWidth - 24;
    // Bottom edge sits at 52px; leave a 16px margin at the top of the viewport.
    const maxH = window.innerHeight - 52 - 16;
    let nextW = startW;
    let nextH = startH;
    el.classList.add('is-resizing');

    const onMove = (ev) => {
      if (wantW) {
        nextW = Math.round(clamp(startW + (ev.clientX - startX), minW, maxW));
        el.style.width = `${nextW}px`;
      }
      if (wantH) {
        nextH = Math.round(clamp(startH + (startY - ev.clientY), minH, maxH));
        el.style.height = `${nextH}px`;
        el.style.maxHeight = 'none';
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      el.classList.remove('is-resizing');
      setSize((prev) => ({
        w: wantW ? nextW : prev?.w ?? null,
        h: wantH ? nextH : prev?.h ?? null,
      }));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  if (!log?.text && !log?.title) return null;

  const lines = text.split('\n');
  const sizeStyle = size
    ? {
        ...(size.w != null ? { width: `${size.w}px` } : null),
        ...(size.h != null ? { height: `${size.h}px`, maxHeight: 'none' } : null),
      }
    : undefined;

  return (
    <div id="cliOutput" className="panel mono" role="log" aria-live="polite" ref={panelRef} style={sizeStyle}>
      <div className="cli-output-head">
        <span className="icon">terminal</span>
        <span className="cli-output-title">{log.title || 'Output'}</span>
        {running && onCancel && (
          <Button
            type="button"
            className="cli-output-stop"
            onClick={() => onCancel()}
            aria-label="Stop"
          >
            Stop
          </Button>
        )}
        <Button
          type="button"
          className={`icon-btn cli-output-copy${copied ? ' is-copied' : ''}`}
          onClick={handleCopy}
          aria-label={copied ? 'Copied' : 'Copy output'}
          title={copied ? 'Copied' : 'Copy output'}
        >
          <span className="icon">{copied ? 'check' : 'content_copy'}</span>
        </Button>
        <Button type="button" className="icon-btn cli-output-close" onClick={onClose} aria-label="Close">
          <span className="icon">close</span>
        </Button>
      </div>
      <div className={`cli-output-progress is-${status}`} aria-hidden="true">
        {!running && (
          <div
            ref={barRef}
            className={`cli-output-progress-bar${counting ? ' counting' : ''}`}
            style={counting ? { animationDuration: `${Math.max(500, autoCloseMs || 10000)}ms` } : undefined}
          />
        )}
      </div>
      <div className="cli-output-body" ref={bodyRef}>
        {lines.map((line, i) => (
          <div
            key={i}
            className={line.startsWith('$') ? 'cli-line cli-cmd' : line.startsWith('#') ? 'cli-line cli-meta' : 'cli-line'}
          >
            {line || '\u00a0'}
          </div>
        ))}
      </div>
      <div
        className="cli-resize cli-resize-n"
        onPointerDown={(e) => startResize(e, 'n')}
        aria-hidden="true"
      />
      <div
        className="cli-resize cli-resize-e"
        onPointerDown={(e) => startResize(e, 'e')}
        aria-hidden="true"
      />
      <div
        className="cli-resize cli-resize-ne"
        onPointerDown={(e) => startResize(e, 'ne')}
        aria-hidden="true"
      >
        <span className="cli-resize-grip" />
      </div>
    </div>
  );
}
