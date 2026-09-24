import type { IPlatformService, UpdateStatePayload } from "@zcode/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { UpdateStatusDialogController } from "@/UpdateStatusDialogController.js";
import { UpdateReleaseNotesTooltip } from "@/UpdateReleaseNotesTooltip.js";
import { CloudDownload, LoaderCircle } from "lucide-react";
import { formatUpdateReleaseDate, getLocalizedUpdateReleaseNotes } from "@/updateReleaseNotes.js";
import {
  deriveUpdateStatusViewModel,
  resolveUpdateStatusEntryVisualState,
} from "@/updateStatusModel.js";

export function UpdateStatusButton({
  platform,
  version,
  updateState,
  className,
}: {
  platform: IPlatformService;
  version: string | null;
  updateState: UpdateStatePayload | null;
  className?: string;
}) {
  const { intl, locale } = useZCodeIntl();
  const [dialogOpen, setDialogOpen] = useState(false);
  const releaseNotesCacheRef = useRef(
    new Map<
      string,
      {
        releaseDateLabel: string | null;
        releaseNotes: { title: string; markdown: string };
      }
    >(),
  );
  const updateStatusViewModel = deriveUpdateStatusViewModel({
    legacyReadyVersion: version,
    updateState,
  });
  const visualState = resolveUpdateStatusEntryVisualState(updateStatusViewModel);
  const {
    dialogPhase,
    displayVersion,
    progressLabel,
    releaseNotesPayload: updateReleaseNotesPayload,
  } = updateStatusViewModel;
  const localizedUpdateReleaseNotes = getLocalizedUpdateReleaseNotes(
    updateReleaseNotesPayload,
    locale,
  );
  const formattedReleaseDate = formatUpdateReleaseDate(
    updateReleaseNotesPayload?.releaseDate,
    locale,
  );
  const releaseNotesCacheKey = displayVersion ? `${locale}:${displayVersion}` : null;
  useEffect(() => {
    if (!releaseNotesCacheKey || !localizedUpdateReleaseNotes) {
      return;
    }

    // 下载完成事件在部分平台只稳定带 version。入口 hover 继续缓存
    // 刚发现更新时的说明，确保弹窗外移后主入口行为仍和原来一致。
    releaseNotesCacheRef.current.set(releaseNotesCacheKey, {
      releaseDateLabel: formattedReleaseDate,
      releaseNotes: localizedUpdateReleaseNotes,
    });
    if (releaseNotesCacheRef.current.size > 8) {
      const oldestCacheKey = releaseNotesCacheRef.current.keys().next().value;
      if (oldestCacheKey) {
        releaseNotesCacheRef.current.delete(oldestCacheKey);
      }
    }
  }, [formattedReleaseDate, localizedUpdateReleaseNotes, releaseNotesCacheKey]);
  const cachedReleaseNotes = releaseNotesCacheKey
    ? releaseNotesCacheRef.current.get(releaseNotesCacheKey)
    : undefined;
  const restoredUpdateReleaseNotes =
    localizedUpdateReleaseNotes ?? cachedReleaseNotes?.releaseNotes ?? null;
  const restoredReleaseDate = formattedReleaseDate ?? cachedReleaseNotes?.releaseDateLabel ?? null;
  // 用户开始下载后，弹窗主任务已经从“了解版本内容”切换到“观察下载进度”。
  // 继续展示更新日志会挤占进度区域，也会让主按钮 hover 和弹窗在下载中重复露出日志。
  const visibleUpdateReleaseNotes =
    dialogPhase === "downloading" ? null : restoredUpdateReleaseNotes;
  const handleOpenReleaseNotesExternalUrl = useCallback(
    (url: string) => platform.openExternal(url),
    [platform],
  );
  const handleUpdateEntryClick = useCallback(() => {
    if (platform.openUpdateStatusWindow) {
      void platform.openUpdateStatusWindow();
      return;
    }

    setDialogOpen(true);
  }, [platform]);

  if (!displayVersion || !visualState) return null;

  // 更新弹窗和按钮 hover 共用同一个更新日志标题，避免 feed 自带 releaseName 与正文标题重复。
  const releaseNotesTitle = intl.formatMessage(
    { id: "updateReady.releaseNotesTitle" },
    { version: displayVersion },
  );
  const tooltipTitle =
    dialogPhase === "downloading"
      ? progressLabel
        ? intl.formatMessage(
            { id: "desktopMenu.help.downloadingUpdateProgress" },
            { progress: progressLabel },
          )
        : intl.formatMessage(
            { id: "desktopMenu.help.downloadingUpdateVersion" },
            { version: displayVersion },
          )
      : dialogPhase === "downloaded"
        ? intl.formatMessage({ id: "updateReady.tooltip" }, { version: displayVersion })
        : intl.formatMessage({ id: "updateAvailable.tooltip" }, { version: displayVersion });

  const updateEntryButton = (
    <Button
      type="button"
      size="icon-md"
      variant="ghost"
      aria-label={tooltipTitle}
      data-testid="desktop-update-status-entry"
      data-update-status={visualState}
      onClick={handleUpdateEntryClick}
      className={cn(
        // 更新入口与工作区 Header 的其它图标操作共用中性 ghost 视觉；状态含义由图标、
        // Tooltip 和独立更新窗口表达，避免把标题栏重新撑成绿色文字胶囊。
        "text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag] transition-colors",
        className,
      )}
    >
      {visualState === "downloading" ? (
        <LoaderCircle className="size-4 animate-spin" />
      ) : (
        <CloudDownload className="size-4" />
      )}
    </Button>
  );

  const updateButton = visibleUpdateReleaseNotes ? (
    <UpdateReleaseNotesTooltip
      locale={locale}
      onOpenExternalUrl={handleOpenReleaseNotesExternalUrl}
      releaseDateLabel={restoredReleaseDate}
      releaseNotesMarkdown={visibleUpdateReleaseNotes.markdown}
      releaseNotesTitle={releaseNotesTitle}
    >
      {updateEntryButton}
    </UpdateReleaseNotesTooltip>
  ) : (
    <ControlHintTooltip title={tooltipTitle} side="bottom">
      {updateEntryButton}
    </ControlHintTooltip>
  );

  return (
    <>
      {updateButton}
      <UpdateStatusDialogController
        platform={platform}
        version={version}
        updateState={updateState}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </>
  );
}
