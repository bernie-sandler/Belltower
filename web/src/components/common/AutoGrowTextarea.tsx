import { useImperativeHandle, useLayoutEffect, useRef, type ComponentProps } from 'react';

type Props = ComponentProps<'textarea'> & { value: string };

/** A textarea that grows with its content (height set through the CSSOM, so CSP-safe). */
export function AutoGrowTextarea({ ref, value, ...rest }: Props) {
  const inner = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => inner.current as HTMLTextAreaElement, []);

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);

  return <textarea ref={inner} value={value} {...rest} />;
}
