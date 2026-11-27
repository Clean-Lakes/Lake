export type GatewayScopedResource = {
  id: string;
  name: string;
  kind: string;
  host?: string;
};

export type GatewayResourceScopeResult =
  | { blocked: true; unauthorizedResource: string }
  | {
      blocked: false;
      resourceIds: string[];
      resourceNames: string[];
      matchedResourceNames: string[];
    };

function normalizeMatch(value: string) {
  return value.trim().toLowerCase();
}

function matchesResource(text: string, resource: GatewayScopedResource) {
  const haystack = normalizeMatch(text);
  const name = normalizeMatch(resource.name);
  if (name.length >= 2 && haystack.includes(name)) return true;
  const host = resource.host ? normalizeMatch(resource.host) : "";
  if (host.length >= 4 && haystack.includes(host)) return true;
  return false;
}

/**
 * Resolve the effective authorized resources for an external specialist MCP message.
 * Any reference to a project resource outside the specialist's active grants is blocked.
 */
export function resolveGatewayResourceScope(input: {
  text: string;
  grantedResources: GatewayScopedResource[];
  allProjectResources: GatewayScopedResource[];
}): GatewayResourceScopeResult {
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
  const effective = matchedGranted.length ? matchedGranted : input.grantedResources;
  return {
    blocked: false,
    resourceIds: effective.map(resource => resource.id),
    resourceNames: effective.map(resource => resource.name),
    matchedResourceNames: matchedGranted.map(resource => resource.name),
  };
}
