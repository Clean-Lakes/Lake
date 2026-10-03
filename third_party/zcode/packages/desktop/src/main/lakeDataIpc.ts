import { app, BrowserWindow, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { lakeDataRequestSchema, lakeDataResultSchema, LAKE_DATA_IPC_CHANNEL, type LakeDataRequest, type LakeDataResult } from '@zcode/shared';

export function runLakeDataRequest(input: LakeDataRequest): Promise<LakeDataResult> {
  const runtime = process.env.LAKE_ZCODE_DIR || (app.isPackaged ? join(process.resourcesPath, 'lake-runtime') : resolve(app.getAppPath(), '../../../../bin/zcode'));
  return new Promise((resolveRequest, reject) => {
    const child = spawn(join(runtime, process.platform === 'win32' ? 'node.exe' : 'node'), ['--disable-warning=ExperimentalWarning', join(runtime, 'lake-data.cjs'), '--rpc'], {
      env: { ...process.env, LAKE_HOME: process.env.LAKE_HOME || join(homedir(), '.lake') }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    let output = '', settled = false;
    const finish = (error?: Error, result?: LakeDataResult) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) reject(error); else resolveRequest(result!);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('LAKE 数据请求超时')); }, 15000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; if (Buffer.byteLength(output) > 8 * 1024 * 1024) { child.kill(); finish(new Error('LAKE 数据响应过大')); } });
    child.on('error', () => finish(new Error('无法启动 LAKE 数据服务')));
    child.stdin.on('error', () => finish(new Error('LAKE 数据服务输入失败')));
    child.on('close', code => {
      try {
        if (code !== 0) throw new Error('LAKE 数据服务退出');
        const response = JSON.parse(output.trim()) as { id: number; result?: LakeDataResult; error?: string };
        if (response.id !== 1 || response.error || response.result === undefined) throw new Error('LAKE 数据请求失败，请检查湖、目录和参数');
        finish(undefined, lakeDataResultSchema.parse(response.result));
      } catch { finish(new Error('LAKE 数据请求失败，请检查湖、目录和参数')); }
    });
    child.stdin.end(JSON.stringify({ id: 1, params: input }) + '\n');
  });
}

export function registerLakeDataIpc(): void {
  ipcMain.handle(LAKE_DATA_IPC_CHANNEL, (event, input: unknown) => {
    if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('LAKE 数据仅允许客户端主页面访问');
    return runLakeDataRequest(lakeDataRequestSchema.parse(input));
  });
}
