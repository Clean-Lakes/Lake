import { normalizeZCodeEndpointOrigin, type ElectronReleaseChannel } from "@zcode/shared";

const ELECTRON_MANIFEST_API_PATH = "/api/v1/releases/electron/manifest";

export const DEFAULT_LAKE_UPDATE_MANIFEST_URL =
  "https://github.com/Clean-Lakes/Lake/releases/latest/download/latest-mac.yml";
export const LAKE_UPDATE_POLL_INTERVAL_MS = 5 * 60 * 1000;

export function mapElectronReleaseChannelToApiValue(channel: ElectronReleaseChannel): string {
  return channel === "preview" ? "3" : "1";
}

export function resolveUpdateManifestRequestUrl(options: {
  endpointOrigin: string;
  manifestUrl?: string;
  platform: string;
  deviceMid?: string;
  channel: ElectronReleaseChannel;
}): URL {
  const staticManifestUrl = options.manifestUrl?.trim();
  if (staticManifestUrl) {
    // GitHub Release 资产是静态文件。平台、设备和通道参数既无意义，也会把本机标识
    // 带到第三方请求；开发服务端 manifest 才需要这些查询参数。
    return new URL(staticManifestUrl);
  }

  const url = new URL(
    ELECTRON_MANIFEST_API_PATH,
    normalizeZCodeEndpointOrigin(options.endpointOrigin),
  );
  url.searchParams.set("platform", options.platform);
  if (options.deviceMid?.trim()) {
    url.searchParams.set("device_mid", options.deviceMid.trim());
  }
  url.searchParams.set("channel", mapElectronReleaseChannelToApiValue(options.channel));
  return url;
}

export function resolveUpdateAssetBaseUrl(manifestUrl: URL): URL {
  // `latest/download/latest-mac.yml` 中的相对 ZIP/blockmap 必须继续落在同一个
  // Release 下载目录。使用站点根 `/` 会错误解析成 https://github.com/<asset>。
  return new URL(".", manifestUrl);
}
