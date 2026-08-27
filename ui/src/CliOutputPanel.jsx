import { useEffect, useRef } from 'react';
import { Button } from '@headlessui/react';

/**
 * Bottom-left anchored console dump (e.g. xi title menu save output).
 * `log`: { title, text } | null
 * `autoClose` + `autoCloseMs` — dismiss after a countdown with a progress bar.
 */
export function CliOutputPanel({
  log,
  onClose,
  autoClose = false,
  autoCloseMs = 10000,
}) {
  const bodyRef = useRef(null);
  const barRef = useRef(null);
  const logKey = log ? `${log.title ?? ''}\n${log.text ?? ''}` : '';

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [log?.text, log?.title]);

  useEffect(() => {
    if (!autoClose || !logKey || !onClose) return undefined;
    const ms = Math.max(500, autoCloseMs || 10000);
    const t = window.setTimeout(() => onClose(), ms);
    return () => window.clearTimeout(t);
  }, [autoClose, autoCloseMs, logKey, onClose]);

  // Restart CSS countdown animation whenever a new log arrives.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || !autoClose || !logKey) return;
    bar.style.animation = 'none';
    // force reflow so the animation restarts
    void bar.offsetWidth;
    bar.style.animation = '';
    bar.style.animationDuration = `${Math.max(500, autoCloseMs || 10000)}ms`;
  }, [autoClose, autoCloseMs, logKey]);

  if (!log?.text && !log?.title) return null;

  const lines = String(log.text || '').split('\n');

  return (
    <div id="cliOutput" className="panel mono" role="log" aria-live="polite">
      <div className="cli-output-head">
        <span className="icon">terminal</span>
        <span className="cli-output-title">{log.title || 'Output'}</span>
        <Button type="button" className="icon-btn cli-output-close" onClick={onClose} aria-label="Close">
          <span className="icon">close</span>
        </Button>
      </div>
      {autoClose && (
        <div className="cli-output-timer" aria-hidden="true">
          <div
            ref={barRef}
            className="cli-output-timer-bar"
            style={{ animationDuration: `${Math.max(500, autoCloseMs || 10000)}ms` }}
          />
        </div>
      )}
      <div className="cli-output-body" ref={bodyRef}>
        {lines.map((line, i) => {
          const isCmd = line.startsWith('$') || line.startsWith('#');
          return (
            <div
              key={i}
              className={line.startsWith('$') ? 'cli-line cli-cmd' : line.startsWith('#') ? 'cli-line cli-meta' : 'cli-line'}
            >
              {line || '\u00a0'}
            </div>
          );
        })}
      </div>
    </div>
  );
}
