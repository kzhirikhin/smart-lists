import type { ComponentProps } from "react";

/** Пауза обозначает отложенную работу, без анимации и привязки к сроку. */
export default function PauseIcon(props: ComponentProps<"svg">) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" fill="none" {...props}>
      <path d="M5 4v8M11 4v8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
