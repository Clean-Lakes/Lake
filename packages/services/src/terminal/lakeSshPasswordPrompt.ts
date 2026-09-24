const maxPromptTailLength = 512;

/** 只响应一次明确的 OpenSSH 密码提示；其他交互仍交给用户操作终端。 */
export function createLakeSshPasswordPromptResponder(
  savedPassword: string,
  target: { username: string; host: string },
  write: (data: string) => void,
): { onData(data: string): void; dispose(): void } {
  let password: string | null = savedPassword;
  let promptTail = "";
  const expectedPrompt = `${target.username}@${target.host}'s password:`;

  return {
    onData(data) {
      if (password === null) return;
      promptTail = (promptTail + data).slice(-maxPromptTailLength);
      // 终端可能输出任意远端文本；只接受与本次连接目标完全一致的 OpenSSH 提示，
      // 避免泛化的 Password: 文本把已存密码误送进已登录的远端 shell。
      const currentLine = promptTail
        .split(/[\r\n]/u)
        .at(-1)
        ?.trimEnd();
      if (currentLine !== expectedPrompt) return;
      const response = password;
      password = null;
      promptTail = "";
      write(`${response}\r`);
    },
    dispose() {
      password = null;
      promptTail = "";
    },
  };
}
