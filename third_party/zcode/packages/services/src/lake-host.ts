/** Native host capabilities consumed by Lake's existing frontend. */
export { createFileService } from "./file/fileService.js";
export { createGitService } from "./git/gitService.js";
export { createTerminalService } from "./terminal/terminalService.js";
export type { IFileService } from "./file/file.js";
export type { IGitService } from "./git/git.js";
export type { ITerminalService } from "./terminal/terminal.js";
export { appSettingsSchema } from "@zcode/shared";
