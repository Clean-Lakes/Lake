export function ModelStatus({ model, online }: { model?: string; online: boolean }) {
  return <><i className={online ? 'online' : 'offline'} /><span>{model || '未记录模型'}</span></>
}
