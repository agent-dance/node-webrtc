import * as os from 'node:os';
import * as dgram from 'node:dgram';
import {
  AttributeType,
  MessageClass,
  decodeMessage,
  encodeMessage,
  createBindingRequest,
  isStunMessage,
  decodeXorMappedAddress,
} from '@agentdance/node-webrtc-stun';
import type { StunAttribute } from '@agentdance/node-webrtc-stun';
import { computeFoundation, computePriority } from './candidate.js';
import type { IceCandidate, TransportProtocol } from './types.js';

// ---------------------------------------------------------------------------
// Interface tier classification
//
// Mirrors pion/ice's approach (RFC 8421 §4.1 "Interface Type Preferences"):
//   loopback  → tier 0 (highest localPref base = 65535)
//   physical  → tier 1 (Ethernet / WiFi)
//   virtual   → tier 2 (VPN tunnels, Docker bridges, VM adapters)
//
// Within each tier, interfaces are assigned descending localPref values so
// the first enumerated interface of each tier gets the highest priority.
// localPref for interface i = tierBase - i, where tierBase is spaced 1024
// apart so tiers never overlap: loopback ≥ 65535, physical 64511..63488,
// virtual 63487..62464.
//
// This ensures:
//   loopback↔loopback pair > physical↔physical pair > virtual pair
//   (all host candidates; type_pref=126 is the same for all)
// ---------------------------------------------------------------------------

const TIER_BASE: Record<0 | 1 | 2, number> = {
  0: 65535,    // loopback
  1: 64511,    // physical (Ethernet / WiFi)
  2: 63487,    // virtual  (VPN, Docker, VM)
};

// Heuristics for "virtual" interface detection that work across platforms
// without requiring OS-specific syscalls.
const VIRTUAL_PREFIXES = [
  'docker',
  'br-',      // Docker bridge networks
  'veth',     // Docker container-side veth
  'virbr',    // libvirt bridges
  'vmnet',    // VMware host-only
  'vboxnet',  // VirtualBox host-only
  'tun',      // OpenVPN / WireGuard tun
  'tap',      // tap adapters
  'utun',     // macOS utun (WireGuard / built-in VPN)
  'ipsec',
  'ppp',
  'wg',       // WireGuard
  'tailscale', // Tailscale VPN
  'zt',       // ZeroTier
  'nordlynx', // NordVPN
];

// Windows network interfaces have human-readable names (often localized) that
// don't match Unix-style prefixes.  We detect virtual adapters by checking
// for common VPN/virtual keywords in a case-insensitive match.
const VIRTUAL_KEYWORDS_CI = [
  'vpn', 'virtual', 'hyper-v', 'vmware', 'vbox', 'docker',
  'wsl', 'loopback', 'pseudo', 'tunnel', 'wireguard',
  'nordlynx', 'tailscale', 'zerotier', 'clash', 'wintun',
  'tap-windows', 'npcap',
];

// On macOS, en0 is typically WiFi/Ethernet. We treat the generic "en"
// prefix as physical; everything else that is non-loopback, non-virtual
// is also treated as physical.
function classifyInterface(name: string): 0 | 1 | 2 {
  if (name === 'lo' || name === 'lo0') return 0;
  const lower = name.toLowerCase();
  for (const prefix of VIRTUAL_PREFIXES) {
    if (lower.startsWith(prefix)) return 2;
  }
  for (const keyword of VIRTUAL_KEYWORDS_CI) {
    if (lower.includes(keyword)) return 2;
  }
  // Windows: "Unknown adapter ..." or adapters that aren't standard
  // Ethernet/WiFi/WLAN names are likely virtual
  if (lower.startsWith('unknown')) return 2;
  return 1;
}

// ---------------------------------------------------------------------------
// Local address enumeration (includes loopback, excludes IPv6)
// ---------------------------------------------------------------------------

export interface LocalAddress {
  address: string;
  family: 4 | 6;
  name: string;
  tier: 0 | 1 | 2;
}

export function getLocalAddresses(): LocalAddress[] {
  const ifaces = os.networkInterfaces();
  const result: LocalAddress[] = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      // IPv4 only – ts-rtc binds udp4 sockets
      if (addr.family !== 'IPv4') continue;
      const tier = addr.internal ? 0 : classifyInterface(name);
      result.push({ address: addr.address, family: 4, name, tier });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Gather host candidates from all local interfaces
//
// Candidates are sorted by tier (loopback first) and within a tier by
// enumeration order. localPref is assigned so that loopback always gets the
// highest value, physical interfaces are in the middle, and virtual/VPN
// interfaces are lowest – matching pion's RFC 8421 §4.1 intent.
// ---------------------------------------------------------------------------

export async function gatherHostCandidates(
  port: number,
  component: 1 | 2,
  protocol: TransportProtocol,
): Promise<IceCandidate[]> {
  const addrs = getLocalAddresses();

  // Sort: loopback(0) < physical(1) < virtual(2) so localPref decrements
  // in the right order within each tier.
  addrs.sort((a, b) => a.tier - b.tier);

  // Track per-tier counter for localPref assignment
  const tierCount: Record<0 | 1 | 2, number> = { 0: 0, 1: 0, 2: 0 };

  const candidates: IceCandidate[] = [];

  for (const addr of addrs) {
    const localPref = TIER_BASE[addr.tier] - tierCount[addr.tier];
    tierCount[addr.tier]++;

    candidates.push({
      foundation: computeFoundation('host', addr.address, protocol),
      component,
      transport: protocol,
      priority: computePriority('host', localPref, component),
      address: addr.address,
      port,
      type: 'host',
    });
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Gather server-reflexive candidate via STUN binding request
// ---------------------------------------------------------------------------

export async function gatherSrflxCandidate(
  socket: dgram.Socket,
  localCandidate: IceCandidate,
  stunServer: { host: string; port: number },
): Promise<IceCandidate | null> {
  return new Promise((resolve) => {
    const req = createBindingRequest();
    const buf = encodeMessage(req);
    const txId = req.transactionId;

    const timeout = setTimeout(() => {
      socket.removeListener('message', onMessage);
      resolve(null);
    }, 3000);

    function onMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
      if (!isStunMessage(msg)) return;

      let decoded;
      try {
        decoded = decodeMessage(msg);
      } catch {
        return;
      }

      // Match transaction ID
      if (!decoded.transactionId.equals(txId)) return;
      if (decoded.messageClass !== MessageClass.SuccessResponse) return;

      clearTimeout(timeout);
      socket.removeListener('message', onMessage);

      // Extract XOR-MAPPED-ADDRESS
      const xorAttr = decoded.attributes.find(
        (a: StunAttribute) => a.type === AttributeType.XorMappedAddress,
      );
      if (!xorAttr) {
        resolve(null);
        return;
      }

      let mapped;
      try {
        mapped = decodeXorMappedAddress(xorAttr.value, decoded.transactionId);
      } catch {
        resolve(null);
        return;
      }

      const foundation = computeFoundation(
        'srflx',
        localCandidate.address,
        localCandidate.transport,
      );
      const priority = computePriority('srflx', 65535, localCandidate.component);

      const srflx: IceCandidate = {
        foundation,
        component: localCandidate.component,
        transport: localCandidate.transport,
        priority,
        address: mapped.address,
        port: mapped.port,
        type: 'srflx',
        relatedAddress: localCandidate.address,
        relatedPort: localCandidate.port,
      };

      resolve(srflx);
    }

    socket.on('message', onMessage);

    socket.send(buf, stunServer.port, stunServer.host, (err) => {
      if (err) {
        clearTimeout(timeout);
        socket.removeListener('message', onMessage);
        resolve(null);
      }
    });
  });
}
