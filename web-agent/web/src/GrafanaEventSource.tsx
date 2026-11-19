import {useCallback, useEffect, useId, useRef, useState} from 'react';
import type {GrafanaDelivery, GrafanaDeliveryDetail, GrafanaDeliveryPage, LakeEventSource, LakeEventSourceResult, LakeEventSourceUpdate, Resource} from '../../shared/contracts';
import {api, readableError} from './api';
import {DisclosureSummary} from './DisclosureSummary';
import {Glyph} from './Icons';

function readableTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

const dateGroup = new Intl.DateTimeFormat('zh-CN', {month: 'long', day: 'numeric'});
const dateWithYear = new Intl.DateTimeFormat('zh-CN', {year: 'numeric', month: 'long', day: 'numeric'});
const clockTime = new Intl.DateTimeFormat('zh-CN', {hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});

function deliveryGroups(deliveries: GrafanaDelivery[]) {
  const today = new Date();
  const groups = new Map<string, {label: string; deliveries: GrafanaDelivery[]}>();
  for (const delivery of deliveries) {
    const date = new Date(delivery.receivedAt);
    const day = date.toDateString();
    let group = groups.get(day);
    if (!group) {
      const label = Number.isNaN(date.getTime()) ? '接收日期未知' : day === today.toDateString() ? '今天 · ' + dateGroup.format(date) :
        (date.getFullYear() === today.getFullYear() ? dateGroup : dateWithYear).format(date);
      group = {label, deliveries: []};
      groups.set(day, group);
    }
    group.deliveries.push(delivery);
  }
  return groups;
}

function DeliveryPayload({sourceId, deliveryId, timeline}: {sourceId: string; deliveryId: string; timeline: boolean}) {
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
  const raw = <pre className="gateway-config gateway-event-payload" tabIndex={0} aria-label="投递 JSON">
    {JSON.stringify(detail.payload, null, 2)}
  </pre>;
  if (!timeline) return raw;
  const alerts = Array.isArray(detail.payload.alerts) ? detail.payload.alerts : [];
  return <>
    <p className="settings-note">{detail.alertCount} 条告警</p>
    <ul className="grafana-delivery-alerts">
      {alerts.map((alert, index) => {
        const item = alert as {status?: unknown; labels?: Record<string, unknown>} | null;
        const name = item?.labels?.alertname;
        const labels = Object.entries(item?.labels ?? {}).filter(([key, value]) => key !== 'alertname' && typeof value === 'string');
        return <li key={index}>
          <strong>{typeof name === 'string' && name ? name : detail.title}</strong>
          <small>{item?.status === 'resolved' ? '恢复' : '触发'}</small>
          {!!labels.length && <div className="grafana-alert-labels">
            {labels.map(([key, value]) => <span key={key}>{key} = {String(value)}</span>)}
          </div>}
        </li>;
      })}
    </ul>
    <details className="grafana-raw-notification">
      <DisclosureSummary>原始通知</DisclosureSummary>
      {raw}
    </details>
  </>;
}

function DeliveryRow({sourceId, delivery, timeline = false}: {sourceId: string; delivery: GrafanaDelivery; timeline?: boolean}) {
  const [open, setOpen] = useState(false);
  const status = delivery.status === 'resolved' ? '恢复通知' : '触发通知';
  const time = new Date(delivery.receivedAt);
  const title = delivery.title.replace(/^\[(?:FIRING|RESOLVED)(?::\d+)?\]\s*/i, '') || delivery.title;
  const expanded = <>
    {!!delivery.truncatedAlerts && <p className="settings-note">Grafana 此次省略了 {delivery.truncatedAlerts} 条告警。</p>}
    <DeliveryPayload sourceId={sourceId} deliveryId={delivery.id} timeline={timeline}/>
  </>;
  return <details className={timeline ? 'grafana-timeline-entry' : 'gateway-event-delivery'} onToggle={event => setOpen(event.currentTarget.open)}>
    {timeline ? <DisclosureSummary className="grafana-timeline-summary">
      <time dateTime={delivery.receivedAt}>{Number.isNaN(time.getTime()) ? '—' : clockTime.format(time)}</time>
      <i aria-hidden="true" className="grafana-timeline-dot"/>
      <span className="grafana-timeline-event"><strong>{title}</strong><small>{status}</small></span>
      <span className="grafana-timeline-action">{open ? '收起详情' : '查看详情'}</span>
    </DisclosureSummary> : <DisclosureSummary>
      <span className="gateway-event-summary">
        <strong>{delivery.title}</strong>
        <span className="gateway-event-meta">
          <span>{status}</span>
          <span>{delivery.alertCount} 条告警</span>
          <time dateTime={delivery.receivedAt}>{readableTime(delivery.receivedAt)}</time>
        </span>
      </span>
    </DisclosureSummary>}
    {open && (timeline ? <div className="grafana-timeline-detail">{expanded}</div> : expanded)}
  </details>;
}

function EventDeliveries({sourceId, onReceipt, timeline = false, waitingForSource = false}: {
  sourceId?: string; onReceipt?: (at: string) => void; timeline?: boolean; waitingForSource?: boolean;
}) {
  const headingId = useId();
  const [page, setPage] = useState<GrafanaDeliveryPage>({deliveries: []});
  const [loading, setLoading] = useState(!!sourceId);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | undefined>(undefined);
  const hasOlderPages = useRef(false);
  const receipt = useRef(onReceipt);
  receipt.current = onReceipt;

  const load = useCallback(async (cursor?: string, quiet = false) => {
    if (!sourceId || pending.current) return;
    const request = new AbortController();
    pending.current = request;
    if (!quiet) setLoading(true);
    try {
      const result = await api.eventDeliveries(sourceId, cursor, request.signal);
      if (request.signal.aborted) return;
      hasOlderPages.current = !!cursor;
      setPage(previous => cursor ? {...result, deliveries: [...previous.deliveries, ...result.deliveries]} : result);
      if (!cursor && result.deliveries[0]) receipt.current?.(result.deliveries[0].receivedAt);
      setError('');
    } catch (cause) {
      if (!request.signal.aborted) setError(readableError(cause));
    } finally {
      if (pending.current === request) pending.current = undefined;
      if (!request.signal.aborted) setLoading(false);
    }
  }, [sourceId]);

  useEffect(() => {
    if (!sourceId) return;
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden && !hasOlderPages.current) void load(undefined, true);
    }, 4000);
    return () => {
      window.clearInterval(timer);
      pending.current?.abort();
      pending.current = undefined;
    };
  }, [load, sourceId]);

  const Heading = timeline ? 'h2' : 'h4';
  return <section className={timeline ? 'grafana-timeline' : 'gateway-messages'} aria-labelledby={headingId}>
    <div className="gateway-section-heading">
      <Heading id={headingId}>接收记录</Heading>
      <button className="provider-text-button" type="button" disabled={!sourceId || loading} onClick={() => void load()}>
        <Glyph name="refresh" size={14}/>刷新
      </button>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {(loading || waitingForSource) && <p className="settings-note" role="status">正在读取投递记录…</p>}
    {!loading && !waitingForSource && !error && !page.deliveries.length && (timeline
      ? <p className="settings-note">暂无接收记录。</p>
      : <div className="gateway-empty">
      <Glyph name="alert" size={22}/>
      <h4>还没有收到告警</h4>
      <p>在 Grafana 的接入点点击 Test 后，投递会显示在这里。</p>
    </div>)}
    {sourceId && timeline && [...deliveryGroups(page.deliveries)].map(([day, group]) => <div className="grafana-timeline-group" key={day}>
      <h3>{group.label}</h3>
      <ol>{group.deliveries.map(delivery => <li key={delivery.id}><DeliveryRow sourceId={sourceId} delivery={delivery} timeline/></li>)}</ol>
    </div>)}
    {sourceId && !timeline && page.deliveries.length > 0 && <div className="gateway-event-deliveries">
      {page.deliveries.map(delivery => <DeliveryRow key={delivery.id} sourceId={sourceId} delivery={delivery}/>)}
    </div>}
    {page.nextCursor && <button className="provider-text-button gateway-load-more" type="button" disabled={loading}
      onClick={() => void load(page.nextCursor)}>加载更早的记录<Glyph name="down" size={13}/></button>}
  </section>;
}

type Props = {
  source: LakeEventSource;
  projectName?: string;
  token?: string;
  disabled: boolean;
  onUpdate: (value: LakeEventSourceUpdate) => void;
  onDismissToken: () => void;
  onReceipt?: (at: string) => void;
};

function ManualWebhookFields({source, token, disabled, onUpdate, onDismissToken, resourceBound = false}:
  Pick<Props, 'source' | 'token' | 'disabled' | 'onUpdate' | 'onDismissToken'> & {resourceBound?: boolean}) {
  const [revealed, setRevealed] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [rotate, setRotate] = useState(false);
  const urlId = useId();
  const tokenId = useId();
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

  return <div className="gateway-event-setup">
      <div className="gateway-event-field">
        <div>
          <label className="field-label" htmlFor={urlId}>本机 Webhook 地址</label>
          <input id={urlId} value={source.webhookUrl} readOnly onFocus={event => event.currentTarget.select()}/>
        </div>
        <button className="button secondary" type="button" onClick={() => void copy(source.webhookUrl, '地址')}>
          <Glyph name="copy" size={14}/>复制地址
        </button>
      </div>
      <p className="settings-note">在 Grafana 添加 Webhook 接入点，选择 POST，认证方式选 Bearer。此地址仅供本机使用。</p>
      {token ? <>
        <div className="gateway-event-field">
          <div>
            <label className="field-label" htmlFor={tokenId}>Webhook 凭据</label>
            <input ref={tokenInput} id={tokenId} value={token} type={revealed ? 'text' : 'password'}
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
        <p className="settings-note">{resourceBound ? '重新生成后，需更新 Grafana 中手动接入的凭据。' : '重新生成后，需更新 Grafana 中的凭据。'}</p>
        <button className="provider-text-button" type="button" disabled={disabled} onClick={() => setRotate(false)}>取消</button>
        <button className="button secondary" type="button" disabled={disabled}
          onClick={() => onUpdate({expectedRevision: source.revision, rotateCredential: true})}>确认生成</button>
      </div> : <button className="provider-text-button" type="button" disabled={disabled} onClick={() => setRotate(true)}>
        <Glyph name="lock" size={14}/>{resourceBound ? '重新生成手动凭据' : '重新生成凭据'}
      </button>}
      {feedback && <p className="settings-note" role="status">{feedback}</p>}
    </div>;
}

export function GrafanaEventSource({source, projectName, token, disabled, onUpdate, onDismissToken, onReceipt}: Props) {
  return <>
    <header className="gateway-detail-header">
      <div className="gateway-detail-title">
        {projectName ? <>
          <span className="gateway-connection-icon"><Glyph name="grafana" size={18}/></span>
          <h3>{source.name}</h3>
          <span className="gateway-protocol">Grafana</span>
        </> : <h2>Grafana Webhook</h2>}
      </div>
      <div className="gateway-detail-actions">
        <button type="button" role="switch" aria-checked={source.enabled} aria-label={`启用来源 ${source.name}`}
          className={`provider-switch ${source.enabled ? 'on' : ''}`} disabled={disabled}
          onClick={() => onUpdate({expectedRevision: source.revision, enabled: !source.enabled})}><span/></button>
        <span>{source.enabled ? '已启用' : '已停用'}</span>
      </div>
    </header>
    {projectName && <p className="settings-note gateway-detail-note">{projectName} · 接收 Grafana 告警</p>}
    <ManualWebhookFields source={source} token={token} disabled={disabled} onUpdate={onUpdate} onDismissToken={onDismissToken}/>
    <EventDeliveries sourceId={source.id} onReceipt={onReceipt}/>
  </>;
}

export function GrafanaResourceWebhook({resource, disabled, onEdit}: {resource: Resource; disabled: boolean; onEdit: () => void}) {
  const resourceId = resource.id;
  const [source, setSource] = useState<LakeEventSource | null>();
  const [token, setToken] = useState<string>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [pending, setPending] = useState<'injection' | 'source'>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState('');
  const detailsId = useId();
  const saving = useRef(false);
  const injectionButton = useRef<HTMLButtonElement>(null);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const busy = pending !== undefined;

  useEffect(() => {
    if (busy || !restoreFocus.current) return;
    restoreFocus.current = false;
    if (document.activeElement === document.body) (injectionButton.current ?? detailsButton.current)?.focus();
  }, [busy]);

  useEffect(() => {
    const request = new AbortController();
    void api.grafanaResourceWebhook(resourceId, request.signal).then(result => {
      if (!request.signal.aborted) setSource(result.source);
    }, cause => {
      if (!request.signal.aborted) setError(readableError(cause));
    });
    return () => request.abort();
  }, [resourceId, retry]);

  async function save(action: () => Promise<LakeEventSourceResult>, operation: 'injection' | 'source' = 'source') {
    if (saving.current) return;
    saving.current = true;
    setPending(operation);
    setError('');
    try {
      const result = await action();
      setSource(result.source);
      if (result.token) {
        setToken(result.token);
        setDetailsOpen(true);
      }
    } catch (cause) {
      setError(readableError(cause));
      setRetry(value => value + 1);
    } finally {
      saving.current = false;
      setPending(undefined);
    }
  }

  const contactPoint = source?.contactPoint;
  const configured = !!resource.settings?.endpoint && !!resource.settings?.credentialRef;
  const callbackUrl = contactPoint && contactPoint.receiverBase + '/api/ingress/v1/grafana/' + resourceId;
  const ready = contactPoint && source?.localReceiverReady !== false;
  const update = (value: LakeEventSourceUpdate) => {
    if (source) void save(() => api.updateEventSource(source.id, value));
  };
  const inject = <button ref={injectionButton} type="button" className={`button ${contactPoint ? 'secondary' : 'primary'}`}
    disabled={disabled || busy || !configured} onClick={event => {
      restoreFocus.current = document.activeElement === event.currentTarget;
      void save(() => api.injectGrafanaResourceWebhook(resourceId, {revision: resource.configurationRevision ?? 1}), 'injection');
    }}><Glyph name="plug" size={15}/>{pending === 'injection' ? '正在注入…' : contactPoint ? '重新注入' : '注入配置'}</button>;

  async function copyAddress() {
    if (!callbackUrl) return;
    try {
      await navigator.clipboard.writeText(callbackUrl);
      setCopyFeedback('接收地址已复制');
    } catch {
      setCopyFeedback('无法使用剪贴板，请选择并复制接收地址。');
    }
  }

  return <>
    <EventDeliveries key={source?.id ?? 'no-source'} sourceId={source?.id} timeline waitingForSource={source === undefined && !error}/>
    <section className="grafana-management" aria-label="接入管理">
      <h2>接入管理</h2>
      <div className="grafana-management-bar">
        <div className="grafana-management-status">
          <strong>Grafana Webhook</strong>
          {contactPoint ? <span className={ready ? 'grafana-ingress-ready' : 'grafana-ingress-unavailable'} role="status">
            {ready ? '已接入' : '接收端口未就绪'}
          </span> : <span className="settings-note">{source === undefined && !error ? '正在读取…' : '未注入'}</span>}
        </div>
        {source && <div className="grafana-management-switch">
          <span>接收告警</span>
          <button type="button" role="switch" aria-checked={source.enabled} aria-label="接收告警"
            className={`provider-switch ${source.enabled ? 'on' : ''}`} disabled={disabled || busy}
            onClick={() => update({expectedRevision: source.revision, enabled: !source.enabled})}><span/></button>
        </div>}
        <div className="grafana-management-actions">
          {source !== undefined && !contactPoint && inject}
          <button type="button" className="provider-text-button" onClick={onEdit} disabled={disabled}>
            <Glyph name="edit" size={15}/>{configured ? '编辑连接' : '配置连接'}
          </button>
          {source === undefined && error && <button type="button" className="provider-text-button" onClick={() => {
            setError('');
            setRetry(value => value + 1);
          }}><Glyph name="refresh" size={14}/>重试</button>}
          {source !== undefined && <button ref={detailsButton} type="button" className="provider-text-button grafana-details-toggle"
            aria-expanded={detailsOpen} aria-controls={detailsId} onClick={() => setDetailsOpen(open => !open)}>
            接入详情<Glyph name="next" size={14}/>
          </button>}
        </div>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {source !== undefined && <div className="grafana-management-details" id={detailsId} hidden={!detailsOpen}>
        {detailsOpen && <>
          {contactPoint && <div className="grafana-receiver-configuration">
            <dl>
              <div><dt>接入点</dt><dd>{contactPoint.name}</dd></div>
              <div><dt>接收地址</dt><dd><code>{callbackUrl}</code></dd></div>
            </dl>
            <div className="grafana-detail-actions">
              <button className="button secondary" type="button" onClick={() => void copyAddress()}><Glyph name="copy" size={14}/>复制地址</button>
              {inject}
            </div>
            {copyFeedback && <p role="status" className="settings-note">{copyFeedback}</p>}
            <p className="settings-note">Grafana 的告警规则或通知策略选用此接入点后，投递会显示在接收记录中。</p>
          </div>}
          <details className="grafana-webhook-manual" open={token ? true : undefined}>
            <DisclosureSummary>手动接入</DisclosureSummary>
            {source ? <ManualWebhookFields source={source} token={token} disabled={disabled || busy} onUpdate={update}
              onDismissToken={() => setToken(undefined)} resourceBound/> :
              <button type="button" className="button secondary" disabled={disabled || busy}
                onClick={() => void save(() => api.createGrafanaResourceWebhook(resourceId))}>生成 Webhook 凭据</button>}
          </details>
        </>}
      </div>}
    </section>
  </>;
}
