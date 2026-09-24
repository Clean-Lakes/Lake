import type { SVGProps } from "react";

/** 河狸的装饰性头像；继承文字颜色，名称由相邻文本表达。 */
export function BeaverIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      data-testid="beaver-icon"
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M5.7 8.7a2 2 0 0 0-3 2.6l2.1 1.2M18.3 8.7a2 2 0 0 1 3 2.6l-2.1 1.2" />
      <path d="M5 10.3c0-3.6 2.9-5.8 7-5.8s7 2.2 7 5.8v3.1c0 3.5-2.8 5.9-7 5.9s-7-2.4-7-5.9v-3.1Z" />
      <circle cx="9.2" cy="11.4" r=".7" fill="currentColor" stroke="none" />
      <circle cx="14.8" cy="11.4" r=".7" fill="currentColor" stroke="none" />
      <path d="m10.8 13.6 1.2 1.1 1.2-1.1c-.7-.5-1.7-.5-2.4 0Z" fill="currentColor" stroke="none" />
      <path d="M12 14.7c-.3 1-1.1 1.5-2 1.5M12 14.7c.3 1 1.1 1.5 2 1.5" />
      <path d="M10.2 17.3v3.2h3.6v-3.2M12 17.3v3.2" />
    </svg>
  );
}
