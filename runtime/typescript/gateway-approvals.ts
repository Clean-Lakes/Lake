import type { GatewayApprovalField } from "../../web-agent/shared/contracts";

export type ApprovalResourceSummary = {
  id: string;
  name: string;
  kind: string;
  host?: string;
};

export type DynamicGatewayApprovalPlan =
  | { blocked: true; unauthorizedResource: string }
  | {
      blocked: false;
      askText: string;
      title: string;
      summary: string;
      fields: GatewayApprovalField[];
      resourceIds: string[];
      resourceNames: string[];
    };

function clean(value: string, max = 120) {
  return value.replace(/\s+/g, " ").trim().replace(/[，。；、,.;]+$/, "").slice(0, max);
}

function normalizeMatch(value: string) {
  return value.trim().toLowerCase();
}

function matchesResource(text: string, resource: ApprovalResourceSummary) {
  const haystack = normalizeMatch(text);
  const name = normalizeMatch(resource.name);
  if (name.length >= 2 && haystack.includes(name)) return true;
  const host = resource.host ? normalizeMatch(resource.host) : "";
  if (host.length >= 4 && haystack.includes(host)) return true;
  return false;
}

function pushField(fields: GatewayApprovalField[], label: string, value: string | undefined) {
  const trimmed = value ? clean(value, 140) : "";
  if (!trimmed) return;
  if (fields.some(field => field.label === label || field.value.toLowerCase() === trimmed.toLowerCase() && field.label.includes(label))) return;
  if (fields.length < 6) fields.push({ label, value: trimmed });
}

function extractExplicitPairs(text: string): GatewayApprovalField[] {
  const pairs: GatewayApprovalField[] = [];
  const lines = text.split(/\r?\n|；|;/);
  const labelPattern = /^[\s\-•*]*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{1,16})\s*[:：=]\s*(.+)$/;
  for (const rawLine of lines) {
    const match = rawLine.trim().match(labelPattern);
    if (!match) continue;
    const label = clean(match[1]!, 24);
    const value = clean(match[2]!, 140);
    if (!label || !value || /^https?$/i.test(label)) continue;
    pushField(pairs, label, value);
  }
  return pairs;
}

function detectAction(text: string) {
  if (/重跑|重新运行|重新触发|构建|流水线|ci\b|pipeline/i.test(text)) return "rebuild" as const;
  if (/回滚|rollback/i.test(text)) return "rollback" as const;
  if (/重启|restart|扩容|缩容|scale/i.test(text)) return "operate" as const;
  if (/发布|部署|上线|deploy|release/i.test(text)) return "deploy" as const;
  if (/排查|巡检|检查|查询|日志|监控|诊断/i.test(text)) return "inspect" as const;
  return "general" as const;
}

export function buildDynamicGatewayApproval(input: {
  text: string;
  threadTitle?: string;
  requester: string;
  roleName: string;
  grantedResources: ApprovalResourceSummary[];
  allProjectResources: ApprovalResourceSummary[];
}): DynamicGatewayApprovalPlan {
  const raw = input.text.trim();
  const grantedIds = new Set(input.grantedResources.map(resource => resource.id));
  const matchedGranted = input.grantedResources.filter(resource => matchesResource(raw, resource));
  const unauthorized = input.allProjectResources.find(resource =>
    !grantedIds.has(resource.id) &&
    matchesResource(raw, resource) &&
    !matchedGranted.some(allowed => normalizeMatch(allowed.name).includes(normalizeMatch(resource.name))),
  );
  if (unauthorized) {
    return { blocked: true, unauthorizedResource: unauthorized.name };
  }

  const effectiveResources = matchedGranted.length ? matchedGranted : input.grantedResources;
  const resourceIds = effectiveResources.map(resource => resource.id);
  const resourceNames = effectiveResources.map(resource => resource.name);

  const action = detectAction(raw);
  const fields = extractExplicitPairs(raw);

  // Extract dynamic domain fields from natural language when not already explicitly listed.
  const versionMatch = raw.match(/\b(v\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9._-]+)?)\b/i)
    ?? raw.match(/(?:目标版本|版本号|版本|tag)\s*[:：为是]?\s*([A-Za-z0-9][A-Za-z0-9._-]{1,48})/i);
  const buildMatch = raw.match(/(?:#(\d{2,10}))/)
    ?? raw.match(/(?:构建编号|构建号|build)\s*[:：为是#]?\s*#?(\d{2,10})/i);
  const pipelineMatch = raw.match(/\b([a-z][a-z0-9_-]{2,40}-(?:ci|cd|pipeline|build|job))\b/i)
    ?? raw.match(/(?:流水线|pipeline)\s*[:：为是]?\s*([A-Za-z0-9._/-]{2,64})/i);
  const branchMatch = raw.match(/\b((?:release|hotfix|feature|feat|fix|bugfix)\/[A-Za-z0-9._/-]+)\b/)
    ?? raw.match(/(?:分支|branch)\s*[:：为是]?\s*([A-Za-z0-9._/-]{2,64})/i);
  const envMatch = raw.match(/(GOS\s*(?:预发|测试|生产|灰度)|预发环境|预发|测试环境|测试|灰度环境|灰度|生产环境|生产|staging|prod(?:uction)?|pre)/i);
  const targetMatch = raw.match(/把\s*([^\s，。；、]{2,32}?)\s*(?:发布|部署|回滚|重启|更新|切流)/)
    ?? raw.match(/\b([a-z][a-z0-9_-]{2,36}-(?:service|gateway|api|worker|web|app|server))\b/i)
    ?? raw.match(/([\u4e00-\u9fa5A-Za-z0-9_-]{2,18}(?:服务|网关|中心|应用|系统|集群|数据库))/);
  const postCheckMatch = raw.match(/(?:发布后检查|执行后检查|顺便检查|确认一下|核验)\s*[:：]?\s*([^，。；\n]{2,32})/);

  if (action === "rebuild") {
    pushField(fields, "流水线", pipelineMatch?.[1]);
    pushField(fields, "构建编号", buildMatch ? `#${buildMatch[1]}` : undefined);
    pushField(fields, "目标分支", branchMatch?.[1]);
    if (!fields.length && targetMatch?.[1]) pushField(fields, "目标对象", targetMatch[1]);
  } else if (action === "deploy" || action === "rollback") {
    pushField(fields, action === "rollback" ? "回滚目标" : "发布目标", targetMatch?.[1]);
    pushField(fields, "目标环境", matchedGranted[0]?.name ?? envMatch?.[1]);
    pushField(fields, action === "rollback" ? "回滚版本" : "目标版本", versionMatch?.[1]);
    pushField(fields, "发布后检查", postCheckMatch?.[1] ?? (/健康检查|健康状态/.test(raw) ? "服务健康状态" : undefined));
  } else if (action === "operate") {
    pushField(fields, "操作对象", targetMatch?.[1] ?? matchedGranted[0]?.name);
    pushField(fields, "目标环境", envMatch?.[1]);
    pushField(fields, "目标版本", versionMatch?.[1]);
    pushField(fields, "执行后检查", postCheckMatch?.[1]);
  } else {
    pushField(fields, "目标对象", targetMatch?.[1]);
    pushField(fields, "目标环境", envMatch?.[1]);
    pushField(fields, "版本", versionMatch?.[1]);
    pushField(fields, "分支", branchMatch?.[1]);
  }

  if (resourceNames.length && !fields.some(field => resourceNames.some(name => field.value.includes(name)))) {
    pushField(fields, "授权资源", resourceNames.join("、"));
  }
  if (!fields.length) {
    pushField(fields, "请求内容", clean(raw, 80));
  }

  const targetText = targetMatch?.[1] ?? pipelineMatch?.[1] ?? matchedGranted[0]?.name ?? "";
  const envText = envMatch?.[1] ?? "";
  let title = input.threadTitle ? clean(input.threadTitle, 64) : "";
  if (!title) {
    if (action === "deploy") title = targetText ? `发布${targetText}${envText ? `至${envText}` : ""}` : `执行${envText || "应用"}发布`;
    else if (action === "rollback") title = targetText ? `回滚${targetText}${envText ? `（${envText}）` : ""}` : "执行服务回滚";
    else if (action === "rebuild") title = pipelineMatch?.[1] ? `重跑构建 ${pipelineMatch[1]}` : targetText ? `重跑${targetText}构建` : "重跑构建流水线";
    else if (action === "operate") title = targetText ? `操作${targetText}` : "执行远程运维操作";
    else if (action === "inspect") title = targetText ? `检查${targetText}` : "执行外部请求检查";
    else title = clean(raw, 40) || `${input.roleName}外部任务请求`;
  }

  const actionClause = clean(
    raw
      .replace(/^(?:请|麻烦|帮我|帮忙|请帮我|麻烦帮我)/, "")
      .replace(/[？?！!。]+$/, ""),
    64,
  ) || title;
  const requester = clean(input.requester, 40) || "外部请求方";
  const askText = `${requester}请我${actionClause}。需要我创建任务并执行吗？`;
  const summary = resourceNames.length
    ? `将在已授权资源（${resourceNames.join("、")}）范围内由「${input.roleName}」创建独立任务并同步执行进度。`
    : `将由「${input.roleName}」创建独立任务执行，并实时同步进度与结果给外部请求方。`;

  return {
    blocked: false,
    askText,
    title: clean(title, 64),
    summary,
    fields,
    resourceIds,
    resourceNames,
  };
}
