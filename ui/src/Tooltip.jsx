import Tippy from '@tippyjs/react';
import 'tippy.js/dist/tippy.css';

const DEFAULTS = {
  delay: [0, 0],
  duration: [120, 80],
  arrow: true,
  offset: [0, 8],
  placement: 'bottom',
  animation: 'fade',
  theme: 'xi',
  touch: ['hold', 400],
};

/**
 * Tippy.js tooltip. Wraps a single element child (must accept a ref).
 * Pass `content` / `title` for the label; empty content → no tippy.
 */
export function Tooltip({
  content,
  title,
  children,
  placement,
  delay,
  disabled,
  ...rest
}) {
  const label = content ?? title;
  if (!label || disabled) return children;
  return (
    <Tippy
      content={label}
      placement={placement ?? DEFAULTS.placement}
      delay={delay ?? DEFAULTS.delay}
      duration={DEFAULTS.duration}
      arrow={DEFAULTS.arrow}
      offset={DEFAULTS.offset}
      animation={DEFAULTS.animation}
      theme={DEFAULTS.theme}
      touch={DEFAULTS.touch}
      {...rest}
    >
      {children}
    </Tippy>
  );
}
