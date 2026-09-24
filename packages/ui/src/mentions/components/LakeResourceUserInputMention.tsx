import { Waves } from "lucide-react";

export function LakeResourceUserInputMention({
  label,
  metadata,
  className,
}: {
  label: string;
  metadata: string;
  className: string;
}) {
  return (
    <span
      className={className}
      title={metadata}
      aria-label={metadata}
      data-lake-resource-mention="true"
    >
      <Waves aria-hidden="true" className="size-4 shrink-0" />
      {label}
    </span>
  );
}
