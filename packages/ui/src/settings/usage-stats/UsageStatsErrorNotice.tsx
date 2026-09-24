import { AlertTriangle, InfoIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatUsageErrorMessage,
  isUsageCredentialError,
  isUsageTeamPlanBusinessError,
} from "@/lib/usageErrorCopy.js";

export function UsageStatsErrorNotice({ error }: { error: string }) {
  const { intl } = useZCodeIntl();
  // 团队套餐业务错误（如"您当前暂无有效的团队套餐授权记录…"）含"授权"字样，
  // 直接 isUsageCredentialError 会误判成凭据问题（影响提示的图标与配色），业务错误优先。
  // 模型设置页已下线（specs/remove-model-settings-page.md），这里不再提供跳转按钮。
  const usageErrorIsTeamPlanBusiness = isUsageTeamPlanBusinessError(error);
  const usageErrorIsCredential = !usageErrorIsTeamPlanBusiness && isUsageCredentialError(error);

  return (
    // 参考 Plan Card teamUnavailable 的内联展示（InfoIcon + warning 文字），
    // 不加边框/背景容器，避免把业务状态提示渲染成独立错误条。
    <div className="flex w-fit min-w-0 items-center gap-1.5 text-ui-base">
      {usageErrorIsTeamPlanBusiness ? (
        <InfoIcon className="size-3 shrink-0 text-warning" aria-hidden="true" />
      ) : (
        <AlertTriangle
          className={
            usageErrorIsCredential
              ? "size-3 shrink-0 text-warning"
              : "size-3 shrink-0 text-destructive"
          }
        />
      )}
      <span
        className={
          usageErrorIsTeamPlanBusiness
            ? "min-w-0 truncate text-warning"
            : usageErrorIsCredential
              ? "min-w-0 truncate whitespace-nowrap text-foreground"
              : "min-w-0 truncate whitespace-nowrap text-destructive"
        }
      >
        {formatUsageErrorMessage(intl, "stats", error)}
      </span>
    </div>
  );
}
