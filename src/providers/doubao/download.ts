import { ProviderError } from "../../core/provider.js";
import {
  downloadMediaFile as downloadMedia,
  validateMediaDirectory,
  type MediaType,
} from "../../core/media-download.js";

export { validateMediaDirectory };

type DownloadOptions = { directory?: string; fetch?: typeof fetch };

const configurationError = () => new ProviderError(
  "Media download directory is not configured or is unavailable", "download_configuration_error"
);
const invalidResponse = () => new ProviderError("Doubao returned an invalid media file", "invalid_response");
const downloadError = () => new ProviderError("Could not download or save the Doubao media file", "download_error");

function permittedUrl(value: string, type: MediaType): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw invalidResponse(); }
  const host = type === "image" ? /^p\d+-flow-imagex-sign\.byteimg\.com$/ : /^v\d+-vdl\.doubao\.com$/;
  if (value.length > 8192 || url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
      !host.test(url.hostname) || [...url.searchParams.keys()].some(key => /cookie|sessionid|csrf|authorization|access[_-]?token|user[_-]?token/i.test(key))) {
    throw invalidResponse();
  }
  return url;
}

/** Download a completed Doubao media URL into a configured, pre-existing local directory. */
export async function downloadMediaFile(
  url: string,
  type: MediaType,
  signal?: AbortSignal,
  options: DownloadOptions = {},
): Promise<{ localPath: string; bytes: number; mimeType: string }> {
  try {
    return await downloadMedia(url, type, signal, {
      ...options,
      validateUrl: permittedUrl,
    });
  } catch (error) {
    if (error instanceof ProviderError) {
      if (error.code === "download_configuration_error") throw configurationError();
      if (error.code === "invalid_response") throw invalidResponse();
      if (error.code === "download_error") throw downloadError();
    }
    throw error;
  }
}
