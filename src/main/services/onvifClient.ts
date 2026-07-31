import { createHash, randomBytes } from 'crypto';
import { request as httpRequest } from 'http';

// Minimal ONVIF SOAP client — just enough to log in, list media profiles,
// and resolve an RTSP stream URI. No XML library dependency: response
// bodies here are narrow and predictable (a handful of known tags), so
// hand-rolled regex extraction (matching discovery.ts's own extractTag
// convention for WS-Discovery responses) is simpler than pulling in a
// general-purpose XML parser for this one adapter.

export interface OnvifAuth {
  username: string;
  password: string;
}

export interface OnvifProfile {
  token: string;
  name: string;
}

const SOAP_TIMEOUT_MS = 8000;

function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<[^:>]*:?${tag}[^>]*>([\\s\\S]*?)<\\/[^:>]*:?${tag}>`, 'i'));
  return match?.[1]?.trim() ?? '';
}

// Same idea as extractTag, but returns every match instead of just the
// first, and keeps the opening tag's attributes separate from its inner
// content — needed for GetProfiles, which returns one <trt:Profiles
// token="..."> block per configured stream profile, with the token itself
// living on the opening tag rather than as a nested element.
function extractAllBlocks(xml: string, tag: string): { attrs: string; inner: string }[] {
  const re = new RegExp(`<[^:>]*:?${tag}([^>]*)>([\\s\\S]*?)<\\/[^:>]*:?${tag}>`, 'gi');
  const blocks: { attrs: string; inner: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    blocks.push({ attrs: match[1], inner: match[2] });
  }
  return blocks;
}

function extractAttrValue(attrsXml: string, attr: string): string {
  const match = attrsXml.match(new RegExp(`\\s${attr}="([^"]*)"`, 'i'));
  return match?.[1] ?? '';
}

// WS-Security UsernameToken with a digest password, the standard ONVIF auth
// scheme — the device recomputes the same digest from the nonce/created it
// receives plus its own stored password and compares, so the real password
// never goes over the wire.
function buildSecurityHeader(auth: OnvifAuth): string {
  const nonce = randomBytes(16);
  const created = new Date().toISOString();
  const digest = createHash('sha1')
    .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(auth.password)]))
    .digest('base64');
  const nonceB64 = nonce.toString('base64');
  return (
    `<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">` +
    `<UsernameToken><Username>${auth.username}</Username>` +
    `<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>` +
    `<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonceB64}</Nonce>` +
    `<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created>` +
    `</UsernameToken></Security></s:Header>`
  );
}

function soapRequest(host: string, port: number, path: string, action: string, bodyXml: string, auth: OnvifAuth): Promise<string> {
  const envelope =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">` +
    buildSecurityHeader(auth) +
    `<s:Body>${bodyXml}</s:Body>` +
    `</s:Envelope>`;

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host,
        port,
        path,
        method: 'POST',
        timeout: SOAP_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/soap+xml; charset=utf-8; action="' + action + '"',
          'Content-Length': Buffer.byteLength(envelope),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          if ((res.statusCode ?? 0) >= 400 && !body.includes('Envelope')) {
            reject(new Error(`ONVIF request failed (HTTP ${res.statusCode})`));
            return;
          }
          resolve(body);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('ONVIF request timed out')));
    req.on('error', reject);
    req.write(envelope);
    req.end();
  });
}

export async function getProfiles(host: string, port: number, auth: OnvifAuth): Promise<OnvifProfile[]> {
  const body = `<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>`;
  const xml = await soapRequest(host, port, '/onvif/media_service', 'http://www.onvif.org/ver10/media/wsdl/GetProfiles', body, auth);
  const blocks = extractAllBlocks(xml, 'Profiles');
  return blocks.map(({ attrs, inner }, index) => ({
    token: extractAttrValue(attrs, 'token') || `profile${index}`,
    name: extractTag(inner, 'Name') || `Channel ${index + 1}`,
  }));
}

export async function getStreamUri(host: string, port: number, auth: OnvifAuth, profileToken: string): Promise<string> {
  const body =
    `<GetStreamUri xmlns="http://www.onvif.org/ver10/media/wsdl">` +
    `<StreamSetup><Stream xmlns="http://www.onvif.org/ver10/schema">RTP-Unicast</Stream>` +
    `<Transport xmlns="http://www.onvif.org/ver10/schema"><Protocol>RTSP</Protocol></Transport></StreamSetup>` +
    `<ProfileToken>${profileToken}</ProfileToken>` +
    `</GetStreamUri>`;
  const xml = await soapRequest(host, port, '/onvif/media_service', 'http://www.onvif.org/ver10/media/wsdl/GetStreamUri', body, auth);
  const uri = extractTag(xml, 'Uri');
  if (!uri) throw new Error('ONVIF device did not return a stream URI');
  return uri;
}

export async function getDeviceInformation(host: string, port: number, auth: OnvifAuth): Promise<{ manufacturer?: string; model?: string }> {
  const body = `<GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/>`;
  try {
    const xml = await soapRequest(host, port, '/onvif/device_service', 'http://www.onvif.org/ver10/device/wsdl/GetDeviceInformation', body, auth);
    return {
      manufacturer: extractTag(xml, 'Manufacturer') || undefined,
      model: extractTag(xml, 'Model') || undefined,
    };
  } catch {
    // Best-effort only — a friendlier label, never required for login/live view.
    return {};
  }
}

// Injects credentials into an RTSP URL if the device didn't already embed
// them in the URI it returned — ffmpeg performs the actual RTSP-level auth
// handshake itself using whatever's in the URL, so this is the only
// integration point needed, no hand-rolled RTSP auth required.
export function withRtspCredentials(rtspUrl: string, auth: OnvifAuth): string {
  if (rtspUrl.includes('@')) return rtspUrl;
  return rtspUrl.replace(/^rtsp:\/\//i, `rtsp://${encodeURIComponent(auth.username)}:${encodeURIComponent(auth.password)}@`);
}
