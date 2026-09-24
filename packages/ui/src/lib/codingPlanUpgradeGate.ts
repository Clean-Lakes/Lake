import type { CodingPlanEntryInventory } from "@/hooks/useCodingPlanEntryPlanList.js";

/**
 * 本地定制，见 specs/remove-coding-plan-upgrade.md。
 *
 * 升级套餐页是厂家官网（Z.ai / BigModel）`/coding-plan` 的 webview 购买页，本产品不接
 * 厂家账号，整页下线：`settings/CodingPlanUpgradeDialogProvider.tsx` 据此不挂载套餐查询、
 * 不渲染升级页。改成 `true` 可恢复上游行为（三处入口的渲染需要同时恢复）。
 */
export function shouldEnableCodingPlanUpgrade(): boolean {
  return false;
}

/**
 * 下线期间交给入口按钮的查询态。
 *
 * `ready` 表示“入口可点击”，避免剩余入口被显示成「重试」；`openCodingPlanUpgrade` 在下线
 * 期间恒返回 `false`，因此点击不会打开任何页面（见 specs 的验收场景 4）。
 */
export function createDisabledCodingPlanEntryInventory(): CodingPlanEntryInventory {
  return {
    entryPlanList: "",
    status: "ready",
    retry: () => {},
  };
}
