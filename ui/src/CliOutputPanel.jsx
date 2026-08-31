import { useEffect, useRef } from 'react';
import { Button } from '@headlessui/react';

/**
 * Bottom-left anchored console dump (e.g. xi title menu save / export stream).
 * `log`: { title, text } | null
 * `autoClose` + `autoCloseMs` — dismiss after a countdown with a progress bar
 *   (skipped while a streamed job is still running).
 * `onCancel` — kill in-flight streamed xi (shows Stop while running).
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
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const text = String(log?.text || '');
  const title = String(log?.title || '');
  const running = !!(text.includes('# running…')
    && !/\n# (done|exit |cancelled)/m.test(text)
    && !/· (ok|failed|cancelled)$/.test(title));

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

  if (!log?.text && !log?.title) return null;

  const lines = text.split('\n');

  return (
    <div id="cliOutput" className="panel mono" role="log" aria-live="polite">
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
        <Button type="button" className="icon-btn cli-output-close" onClick={onClose} aria-label="Close">
          <span className="icon">close</span>
        </Button>
      </div>
      {autoClose && !running && (
        <div className="cli-output-timer" aria-hidden="true">
          <div
            ref={barRef}
            className="cli-output-timer-bar"
            style={{ animationDuration: `${Math.max(500, autoCloseMs || 10000)}ms` }}
          />
        </div>
      )}
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
    </div>
  );
}
