export type SSHTarget = {
  hostHash: string;
  endpointHash: string;
  addressFamily: number;
  hostKeys: {algorithm: string; fingerprint: string}[];
};

function pinnedAddress(target?:SSHTarget): target is SSHTarget {
  return !!target && (target.addressFamily === 4 || target.addressFamily === 6) &&
    /^[a-f0-9]{64}$/.test(target.hostHash) && /^[a-f0-9]{64}$/.test(target.endpointHash) &&
    Array.isArray(target.hostKeys) && target.hostKeys.length > 0 &&
    target.hostKeys.every(pin=>pin && typeof pin.algorithm === "string" && pin.algorithm.length > 0 &&
      /^SHA256:[A-Za-z0-9+/]{43}$/.test(pin.fingerprint));
}

/** A matching host address or host key is positive alias evidence even when the
 * old record cannot prove that any other target is independent. */
export function sameSSHHost(first?:SSHTarget,second?:SSHTarget) {
  if (!first || !second) return false;
  return (/^[a-f0-9]{64}$/.test(first.hostHash) && first.hostHash === second.hostHash) ||
    (/^[a-f0-9]{64}$/.test(first.endpointHash) && first.endpointHash === second.endpointHash) ||
    (Array.isArray(first.hostKeys) && Array.isArray(second.hostKeys) &&
     first.hostKeys.some(a=>a && /^SHA256:[A-Za-z0-9+/]{43}$/.test(a.fingerprint) &&
        second.hostKeys.some(b=>b?.fingerprint===a.fingerprint)));
}

/** Only comparable, pinned SSH peers on different literal addresses prove separation.
 * DNS aliases, alternate ports on a host, missing historical keys and cloned keys do not. */
export function distinctSSHTargets(first?: SSHTarget, second?: SSHTarget) {
  return pinnedAddress(first) && pinnedAddress(second) && first.addressFamily === second.addressFamily &&
    first.hostHash !== second.hostHash && first.endpointHash !== second.endpointHash &&
    first.hostKeys.some(a => second.hostKeys.some(b => a.algorithm === b.algorithm)) &&
    !first.hostKeys.some(a => second.hostKeys.some(b => a.fingerprint === b.fingerprint));
}
