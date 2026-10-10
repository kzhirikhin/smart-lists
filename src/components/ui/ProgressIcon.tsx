import type { ComponentProps } from "react";

/** Статическая отметка начатой работы, общая для чекбокса, меню и шапки списка. */
export default function ProgressIcon(props: ComponentProps<"svg">) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" fill="none" {...props}>
      <path d="M8 3a5 5 0 1 0 5 5" stroke="currentColor" strokeWidth={props.strokeWidth ?? 2} strokeLinecap="round" />
    </svg>
  );
}
