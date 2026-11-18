import {useCallback, useEffect, useRef, useState} from 'react';
import type {GrafanaDelivery, GrafanaDeliveryDetail, GrafanaDeliveryPage, LakeEventSource, LakeEventSourceUpdate} from '../../shared/contracts';
import {api, readableError} from './api';
import {DisclosureSummary} from './DisclosureSummary';
import {Glyph} from './Icons';

function readableTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

function DeliveryPayload({sourceId, deliveryId}: {sourceId: string; deliveryId: string}) {
  const [detail, setDetail] = useState<GrafanaDeliveryDetail>();
  const [error, setError] = useState('');
  useEffect(() => {
    const request = new AbortController();
    void api.eventDelivery(sourceId, deliveryId, request.signal).then(data => {
      if (!request.signal.aborted) setDetail(data);
    }, cause => {
      if (!request.signal.aborted) setError(readableError(cause));
    });
    return () => request.abort();
  }, [sourceId, deliveryId]);
  if (error) return <p className="form-error" role="alert">{error}</p>;
  if (!detail) return <p className="settings-note" role="status">正在读取投递内容…</p>;
  return <pre className="gateway-config gateway-event-payload" tabIndex={0} aria-label="投递 JSON">
    {JSON.stringify(detail.payload, null, 2)}
  </pre>;
}

function DeliveryRow({sourceId, delivery}: {sourceId: string; delivery: GrafanaDelivery}) {
  const [open, setOpen] = useState(false);
  return <details className="gateway-event-delivery" onToggle={event => setOpen(event.currentTarget.open)}>
    <DisclosureSummary>
      <span className="gateway-event-summary">
        <strong>{delivery.title}</strong>
        <span className="gateway-event-meta">
          <span>{delivery.status === 'resolved' ? '恢复通知' : '触发通知'}</span>
          <span>{delivery.alertCount} 条告警</span>
          <time dateTime={delivery.receivedAt}>{readableTime(delivery.receivedAt)}</time>
        </span>
      </span>
    </DisclosureSummary>
    {open && <>
      {!!delivery.truncatedAlerts && <p className="settings-note">Grafana 此次省略了 {delivery.truncatedAlerts} 条告警。</p>}
      <DeliveryPayload sourceId={sourceId} deliveryId={delivery.id}/>
    </>}
  </details>;
}

function EventDeliveries({sourceId, onReceipt}: {sourceId: string; onReceipt: (at: string) => void}) {
  const [page, setPage] = useState<GrafanaDeliveryPage>({deliveries: []});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | undefined>(undefined);
  const hasOlderPages = useRef(false);
  const receipt = useRef(onReceipt);
  receipt.current = onReceipt;

  const load = useCallback(async (cursor?: string, quiet = false) => {
    if (pending.current) return;
    const request = new AbortController();
    pending.current = request;
    if (!quiet) setLoading(true);
    try {
      const result = await api.eventDeliveries(sourceId, cursor, request.signal);
      if (request.signal.aborted) return;
      hasOlderPages.current = !!cursor;
      setPage(previous => cursor ? {...result, deliveries: [...previous.deliveries, ...result.deliveries]} : result);
      if (!cursor && result.deliveries[0]) receipt.current(result.deliveries[0].receivedAt);
      setError('');
    } catch (cause) {
      if (!request.signal.aborted) setError(readableError(cause));
    } finally {
      if (pending.current === request) pending.current = undefined;
      if (!request.signal.aborted) setLoading(false);
    }
  }, [sourceId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden && !hasOlderPages.current) void load(undefined, true);
    }, 4000);
    return () => {
      window.clearInterval(timer);
      pending.current?.abort();
      pending.current = undefined;
    };
  }, [load]);

  return <section className="gateway-messages" aria-labelledby="grafana-deliveries-title">
    <div className="gateway-section-heading">
      <h4 id="grafana-deliveries-title">接收记录</h4>
      <button className="provider-text-button" type="button" disabled={loading} onClick={() => void load()}>
        <Glyph name="refresh" size={14}/>刷新
      </button>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {loading && <p className="settings-note" role="status">正在读取投递记录…</p>}
    {!loading && !error && !page.deliveries.length && <div className="gateway-empty">
      <Glyph name="alert" size={22}/>
      <h4>还没有收到告警</h4>
      <p>在 Grafana 的接入点点击 Test 后，投递会显示在这里。</p>
    </div>}
    {page.deliveries.length > 0 && <div className="gateway-event-deliveries">
      {page.deliveries.map(delivery => <DeliveryRow key={delivery.id} sourceId={sourceId} delivery={delivery}/>)}
    </div>}
    {page.nextCursor && <button className="provider-text-button gateway-load-more" type="button" disabled={loading}
      onClick={() => void load(page.nextCursor)}>加载更早的记录<Glyph name="down" size={13}/></button>}
  </section>;
}

type Props = {
  source: LakeEventSource;
  projectName: string;
  token?: string;
  disabled: boolean;
  onUpdate: (value: LakeEventSourceUpdate) => void;
  onDismissToken: () => void;
  onReceipt: (at: string) => void;
};

export function GrafanaEventSource({source, projectName, token, disabled, onUpdate, onDismissToken, onReceipt}: Props) {
  const [revealed, setRevealed] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [rotate, setRotate] = useState(false);
  const tokenInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setRevealed(false);
    setRotate(false);
    if (token) tokenInput.current?.focus();
  }, [token]);

  async function copy(value: string, label: string, credential = false) {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback(`${label}已复制`);
    } catch {
      if (credential) setRevealed(true);
      setFeedback(`无法写入剪贴板，请手动复制${label}。`);
    }
  }

  return <>
    <header className="gateway-detail-header">
      <div className="gateway-detail-title">
        <span className="gateway-connection-icon"><Glyph name="alert" size={18}/></span>
        <h3>{source.name}</h3>
        <span className="gateway-protocol">Grafana</span>
      </div>
      <div className="gateway-detail-actions">
        <button type="button" role="switch" aria-checked={source.enabled} aria-label={`启用来源 ${source.name}`}
          className={`provider-switch ${source.enabled ? 'on' : ''}`} disabled={disabled}
          onClick={() => onUpdate({expectedRevision: source.revision, enabled: !source.enabled})}><span/></button>
        <span>{source.enabled ? '已启用' : '已停用'}</span>
      </div>
    </header>
    <p className="settings-note gateway-detail-note">{projectName} · 接收 Grafana 告警</p>
    <div className="gateway-event-setup">
      <div className="gateway-event-field">
        <div>
          <label className="field-label" htmlFor="grafana-webhook-url">本机 Webhook 地址</label>
          <input id="grafana-webhook-url" value={source.webhookUrl} readOnly onFocus={event => event.currentTarget.select()}/>
        </div>
        <button className="button secondary" type="button" onClick={() => void copy(source.webhookUrl, '地址')}>
          <Glyph name="copy" size={14}/>复制地址
        </button>
      </div>
      <p className="settings-note">在 Grafana 添加 Webhook 接入点，选择 POST，认证方式选 Bearer。此地址仅供本机使用。</p>
      {token ? <>
        <div className="gateway-event-field">
          <div>
            <label className="field-label" htmlFor="grafana-webhook-credential">Webhook 凭据</label>
            <input ref={tokenInput} id="grafana-webhook-credential" value={token} type={revealed ? 'text' : 'password'}
              autoComplete="off" spellCheck={false} readOnly onFocus={event => event.currentTarget.select()}/>
          </div>
          <button className="button secondary" type="button" aria-label={revealed ? '隐藏凭据' : '显示凭据'}
            onClick={() => setRevealed(value => !value)}><Glyph name={revealed ? 'eyeOff' : 'eye'} size={15}/></button>
          <button className="button secondary" type="button" onClick={() => void copy(token, '凭据', true)}>
            <Glyph name="copy" size={14}/>复制凭据
          </button>
        </div>
        <div className="gateway-event-token-note">
          <p className="settings-note">本次仅显示一次。粘贴到 Grafana 的 Authorization Header - Credentials。</p>
          <button className="provider-text-button" type="button" onClick={onDismissToken}>完成</button>
        </div>
      </> : rotate ? <div className="gateway-event-token-note">
        <p className="settings-note">重新生成后，需更新 Grafana 中的凭据。</p>
        <button className="provider-text-button" type="button" disabled={disabled} onClick={() => setRotate(false)}>取消</button>
        <button className="button secondary" type="button" disabled={disabled}
          onClick={() => onUpdate({expectedRevision: source.revision, rotateCredential: true})}>确认生成</button>
      </div> : <button className="provider-text-button" type="button" disabled={disabled} onClick={() => setRotate(true)}>
        <Glyph name="lock" size={14}/>重新生成凭据
      </button>}
      {feedback && <p className="settings-note" role="status">{feedback}</p>}
    </div>
    <EventDeliveries sourceId={source.id} onReceipt={onReceipt}/>
  </>;
}
