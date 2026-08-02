export interface WebPageFetchOptions {
	timeoutMs: number;
	maxRedirects: number;
	maxHtmlBytes: number;
	maxExtractedTextChars: number;
	userAgent: string;
}

export interface WebPageIngestionResult {
	requestedUrl: string; normalizedUrl: string; finalUrl: string | null;
	status: 'completed' | 'unsupported' | 'failed'; httpStatus: number | null;
	contentType: string | null; responseBytes: number | null; redirectCount: number;
	title: string | null; description: string | null; canonicalUrl: string | null;
	mainImageUrl: string | null; jsonLd: unknown[]; extractedText: string | null;
	errorCode: string | null; errorMessage: string | null; fetchedAt: string;
}

const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain']);
const TRAILING_PUNCTUATION = /[.,!?;:'"\]\}]+$/;

function isPrivateIpv4(hostname: string): boolean {
	const parts = hostname.split('.').map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
		(parts[0] === 169 && parts[1] === 254) || (parts[0] === 192 && parts[1] === 168) ||
		(parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || parts[0] >= 224;
}

function isPublicHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		const host = url.hostname.toLowerCase().replace(/\.$/, '');
		if (!['http:', 'https:'].includes(url.protocol) || !host || url.username || url.password) return false;
		if (BLOCKED_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.local') || isPrivateIpv4(host)) return false;
		if (host.includes(':')) {
			const compact = host.replace(/^\[|\]$/g, '').toLowerCase();
			if (compact === '::1' || compact === '::' || compact.startsWith('fc') || compact.startsWith('fd') || compact.startsWith('fe8') || compact.startsWith('fe9') || compact.startsWith('fea') || compact.startsWith('feb')) return false;
		}
		return true;
	} catch { return false; }
}

export function normalizeWebUrl(value: string): string | null {
	if (!isPublicHttpUrl(value)) return null;
	const url = new URL(value);
	url.hash = '';
	if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = '';
	url.hostname = url.hostname.toLowerCase();
	return url.toString();
}

export function detectPrimaryWebUrl(text: string): { url: string; normalizedUrl: string; contextText: string } | null {
	const match = /https?:\/\/[^\s<>]+/i.exec(text);
	if (!match) return null;
	let raw = match[0];
	while (TRAILING_PUNCTUATION.test(raw)) raw = raw.replace(TRAILING_PUNCTUATION, '');
	while (raw.endsWith(')') && (raw.match(/\(/g)?.length ?? 0) < (raw.match(/\)/g)?.length ?? 0)) raw = raw.slice(0, -1);
	const normalizedUrl = normalizeWebUrl(raw);
	if (!normalizedUrl) return null;
	const contextText = `${text.slice(0, match.index)}${match[0].slice(raw.length)}${text.slice(match.index + match[0].length)}`.trim();
	return { url: raw, normalizedUrl, contextText };
}

function decodeHtml(value: string): string {
	const named: Record<string,string> = { amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ' };
	return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity:string) => {
		if (entity[0] !== '#') return named[entity.toLowerCase()] ?? _;
		const code = entity[1].toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
		return Number.isFinite(code) ? String.fromCodePoint(code) : _;
	});
}

function attr(tag: string, name: string): string | null {
	const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
	return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? '').trim() || null : null;
}

function absoluteUrl(value: string | null, base: string): string | null {
	if (!value) return null;
	try { const result = new URL(value, base); return ['http:','https:'].includes(result.protocol) ? result.toString() : null; } catch { return null; }
}

function extractHtml(html: string, finalUrl: string, maxChars: number) {
	const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	let description: string | null = null; let canonicalUrl: string | null = null; let mainImageUrl: string | null = null;
	for (const tag of html.match(/<(?:meta|link)\b[^>]*>/gi) ?? []) {
		const property = (attr(tag, 'property') ?? attr(tag, 'name') ?? '').toLowerCase();
		const rel = (attr(tag, 'rel') ?? '').toLowerCase();
		if (!description && ['description','og:description','twitter:description'].includes(property)) description = attr(tag, 'content');
		if (!mainImageUrl && ['og:image','twitter:image','twitter:image:src'].includes(property)) mainImageUrl = absoluteUrl(attr(tag, 'content'), finalUrl);
		if (!canonicalUrl && rel.split(/\s+/).includes('canonical')) canonicalUrl = absoluteUrl(attr(tag, 'href'), finalUrl);
	}
	const jsonLd: unknown[] = [];
	for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
		try { const parsed:unknown = JSON.parse(decodeHtml(match[1]).trim()); Array.isArray(parsed) ? jsonLd.push(...parsed) : jsonLd.push(parsed); } catch { /* malformed publisher data */ }
	}
	const text = decodeHtml(html.replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<!--([\s\S]*?)-->/g, ' ').replace(/<\/?(?:p|div|section|article|main|header|footer|aside|li|h[1-6]|br|tr|td|th)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' '))
		.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars);
	return { title: titleMatch ? decodeHtml(titleMatch[1]).replace(/\s+/g,' ').trim() || null : null, description, canonicalUrl, mainImageUrl, jsonLd, extractedText:text || null };
}

function base(requestedUrl:string, normalizedUrl:string):WebPageIngestionResult { return { requestedUrl,normalizedUrl,finalUrl:null,status:'failed',httpStatus:null,contentType:null,responseBytes:null,redirectCount:0,title:null,description:null,canonicalUrl:null,mainImageUrl:null,jsonLd:[],extractedText:null,errorCode:null,errorMessage:null,fetchedAt:new Date().toISOString() }; }

export async function fetchAndExtractWebPage(url:string, options:WebPageFetchOptions):Promise<WebPageIngestionResult> {
	const normalizedUrl=normalizeWebUrl(url) ?? url; const result=base(url,normalizedUrl);
	if (!normalizeWebUrl(url)) return {...result,status:'unsupported',errorCode:'unsupported_url',errorMessage:'Only public HTTP and HTTPS URLs are supported.'};
	const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),options.timeoutMs);
	try {
		let current=normalizedUrl; let response:Response | null=null;
		for(let redirects=0;;redirects++) {
			response=await fetch(current,{method:'GET',redirect:'manual',signal:controller.signal,headers:{Accept:'text/html,application/xhtml+xml','User-Agent':options.userAgent}});
			result.httpStatus=response.status; result.contentType=response.headers.get('content-type'); result.finalUrl=current; result.redirectCount=redirects;
			if (![301,302,303,307,308].includes(response.status)) break;
			if (redirects>=options.maxRedirects) return {...result,status:'failed',errorCode:'too_many_redirects',errorMessage:'The page redirected too many times.'};
			const next=absoluteUrl(response.headers.get('location'),current);
			if (!next || !isPublicHttpUrl(next)) return {...result,status:'unsupported',errorCode:'unsafe_redirect',errorMessage:'The page redirected to an unsupported or private address.'};
			current=normalizeWebUrl(next)!;
		}
		if (!response.ok) return {...result,status:'failed',errorCode:'http_error',errorMessage:`The page returned HTTP ${response.status}.`};
		const type=(result.contentType??'').toLowerCase();
		if (!type.includes('text/html') && !type.includes('application/xhtml+xml')) return {...result,status:'unsupported',errorCode:'unsupported_content_type',errorMessage:'The URL did not return an HTML page.'};
		const declared=Number(response.headers.get('content-length'));
		if (Number.isFinite(declared)&&declared>options.maxHtmlBytes) return {...result,status:'failed',errorCode:'response_too_large',errorMessage:'The HTML page exceeds the configured size limit.'};
		const reader=response.body?.getReader(); if(!reader) throw new Error('The page response had no body.');
		const chunks:Uint8Array[]=[]; let bytes=0;
		while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>options.maxHtmlBytes){await reader.cancel();return {...result,responseBytes:bytes,status:'failed',errorCode:'response_too_large',errorMessage:'The HTML page exceeds the configured size limit.'};}chunks.push(part.value);}
		const body=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
		const extracted=extractHtml(new TextDecoder().decode(body),result.finalUrl!,options.maxExtractedTextChars);
		return {...result,...extracted,responseBytes:bytes,status:'completed'};
	} catch(error) { const aborted=controller.signal.aborted; return {...result,status:'failed',errorCode:aborted?'timeout':'fetch_failed',errorMessage:aborted?'The page fetch timed out.':error instanceof Error?error.message:String(error)}; }
	finally { clearTimeout(timeout); }
}

export async function fetchWebPageImage(url:string,options:{timeoutMs:number;maxRedirects:number;maxBytes:number;userAgent:string}):Promise<{contentType:string;content:ArrayBuffer}|null>{
	if(!normalizeWebUrl(url))return null;
	const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),options.timeoutMs);
	try{
		let current=normalizeWebUrl(url)!;
		for(let redirects=0;;redirects++){
			const response=await fetch(current,{redirect:'manual',signal:controller.signal,headers:{Accept:'image/*','User-Agent':options.userAgent}});
			if([301,302,303,307,308].includes(response.status)){
				if(redirects>=options.maxRedirects)return null;const next=absoluteUrl(response.headers.get('location'),current);if(!next||!isPublicHttpUrl(next))return null;current=normalizeWebUrl(next)!;continue;
			}
			const contentType=(response.headers.get('content-type')??'').split(';')[0].trim().toLowerCase();
			if(!response.ok||!contentType.startsWith('image/')||contentType==='image/svg+xml')return null;
			const declared=Number(response.headers.get('content-length'));if(Number.isFinite(declared)&&declared>options.maxBytes)return null;
			const content=await response.arrayBuffer();return content.byteLength<=options.maxBytes?{contentType,content}:null;
		}
	}catch{return null;}finally{clearTimeout(timeout);}
}
