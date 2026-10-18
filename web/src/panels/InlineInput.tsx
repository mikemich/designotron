import { useEffect, useRef, useState } from "react";

/**
 * Text field that commits on Enter or blur and reverts on Escape. `onCommit` returns false
 * when the value was rejected, which restores the previous text.
 */
export function InlineInput(props: {
  value: string;
  onCommit: (v: string) => boolean | void;
  title?: string;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  label?: string;
}) {
  const { value, onCommit } = props;
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);
  const skip = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!focused) setText(value);
  }, [value, focused]);
  useEffect(() => {
    if (props.autoFocus) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, []);
  return (
    <label className={"field wf-inline" + (props.className ? " " + props.className : "")} title={props.title} onClick={(e) => e.stopPropagation()}>
      {props.label && <span className="lbl wf-lbl">{props.label}</span>}
      <input
        ref={ref}
        value={text}
        placeholder={props.placeholder}
        aria-label={props.title ?? props.label}
        onFocus={() => setFocused(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          setFocused(false);
          if (skip.current) {
            skip.current = false;
            setText(value);
            return;
          }
          if (text.trim() === value) return setText(value);
          if (onCommit(text) === false) setText(value);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "Escape") {
            skip.current = true;
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </label>
  );
}
