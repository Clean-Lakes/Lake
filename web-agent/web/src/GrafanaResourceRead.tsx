import {useEffect, useId, useState} from 'react';
import type {GrafanaReadResult, Resource} from '../../shared/contracts';
import {api, readableError} from './api';
import {Glyph} from './Icons';
import './grafanaResource.css';

const categories = [
  ['dashboards', '仪表盘'], ['folders', '目录'], ['datasources', '数据源'],
  ['rules', '告警规则'], ['alerts', '活动告警'],
] as const;

function count(result: GrafanaReadResult): string | undefined {
  if ('items' in result) {
    const paged = result.operation === 'dashboards' || result.operation === 'folders';
    return result.items.length + (paged && result.nextPage ? '+' : '');
  }
  if (result.operation === 'alerts' && Array.isArray(result.data)) return String(result.data.length);
  if (result.operation === 'rules') {
    const groups = (result.data as {data?: {groups?: {rules?: unknown[]}[]}} | undefined)?.data?.groups;
    if (Array.isArray(groups)) return String(groups.reduce((total, group) =>
      total + (Array.isArray(group?.rules) ? group.rules.length : 0), 0));
  }
}

function grafanaURL(endpoint: unknown) {
  if (typeof endpoint !== 'string' || !endpoint) return;
  try {
    const url = new URL(endpoint);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.search && !url.hash)
      return url;
  } catch { /* An invalid catalog URL has no outbound link. */ }
}

function ActiveAlertList({alerts}: {alerts: unknown[]}) {
  if (!alerts.length) return <p className="settings-note">当前没有活动告警。</p>;
  return <ul className="grafana-active-alert-list">
    {alerts.map((alert, index) => {
      const value = alert as {labels?: {alertname?: unknown; instance?: unknown}; annotations?: {summary?: unknown}} | null;
      const name = value?.labels?.alertname;
      const summary = value?.annotations?.summary ?? value?.labels?.instance;
      return <li key={index}>
        <strong>{typeof name === 'string' && name ? name : 'Grafana 告警'}</strong>
        {typeof summary === 'string' && summary && <small>{summary}</small>}
      </li>;
    })}
  </ul>;
}

export function GrafanaResourceRead({resource, disabled}: {resource: Resource; disabled: boolean}) {
  const [overview, setOverview] = useState<{values: (string | undefined)[]; alerts?: unknown[]; error?: string}>();
  const [alertsOpen, setAlertsOpen] = useState(false);
  const alertsId = useId();
  const url = grafanaURL(resource.settings?.endpoint);
  const configured = !!url && !!resource.settings?.credentialRef;
  const {id, configurationRevision = 1} = resource;

  useEffect(() => {
    if (!configured || disabled) return;
    const request = new AbortController();
    void Promise.allSettled(categories.map(([operation]) =>
      api.grafanaRead(id, configurationRevision, {operation}, request.signal),
    )).then(results => {
      if (request.signal.aborted) return;
      let alerts: unknown[] | undefined;
      let error: string | undefined;
      const values = results.map(result => {
        if (result.status === 'rejected') {
          error ??= readableError(result.reason);
          return undefined;
        }
        if (result.value.operation === 'alerts' && Array.isArray(result.value.data)) alerts = result.value.data;
        return count(result.value);
      });
      setOverview({values, alerts, error});
    });
    return () => request.abort();
  }, [configured, disabled, id, configurationRevision]);

  return <>
    <header className="grafana-resource-header">
      <div className="grafana-resource-identity">
        <span className="grafana-resource-icon"><Glyph name="grafana" size={28}/></span>
        <div>
          <h1>{resource.name}</h1>
          {url && <p title={url.href}>{url.host + (url.pathname === '/' ? '' : url.pathname)}</p>}
        </div>
      </div>
      {url && <a className="button primary grafana-open" href={url.href} target="_blank" rel="noopener noreferrer">
        打开 Grafana<Glyph name="outbound" size={15}/>
      </a>}
    </header>
    <section className="grafana-overview" aria-label="Grafana 资源概览" aria-busy={configured && !disabled && !overview}>
      {!configured ? <p className="settings-note">配置 Grafana 连接后可查看资源概览。</p> : <>
        <div className="grafana-metrics">
          {categories.map(([operation, label], index) => {
            const total = overview?.values[index];
            const cell = <>
              <span className="grafana-metric-label">{label}</span>
              <strong className={operation === 'alerts' && !!overview?.alerts?.length ? 'grafana-metric-alerting' : undefined}>
                {total ?? '—'}
              </strong>
            </>;
            if (operation === 'alerts' && overview?.alerts) return <div className="grafana-metric" key={operation}>
              <button type="button" className="grafana-metric-button" aria-label={`活动告警 ${total}`}
                aria-expanded={alertsOpen} aria-controls={alertsId} onClick={() => setAlertsOpen(open => !open)}>
                {cell}<Glyph name="next" size={14}/>
              </button>
            </div>;
            return <div className="grafana-metric" key={operation} title={total === undefined && overview ? '暂不可读' : undefined}>{cell}</div>;
          })}
        </div>
        {overview && overview.values.some(value => value === undefined) && <p className="settings-note" role="status">
          {overview.values.every(value => value === undefined) ? overview.error ?? 'Grafana 暂不可读' :
            '暂不可读 · ' + categories.filter((_, index) => overview.values[index] === undefined).map(([, label]) => label).join('、')}
        </p>}
        {!!overview?.alerts && <div id={alertsId} className="grafana-active-alerts" hidden={!alertsOpen}>
          {alertsOpen && <ActiveAlertList alerts={overview.alerts}/>}
        </div>}
      </>}
    </section>
  </>;
}
