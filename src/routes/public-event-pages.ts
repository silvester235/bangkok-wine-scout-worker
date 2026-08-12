import { getBangkokLocalDate } from './events';
import {
	getPublishedEventBySlug,
	listPublishedEventSlugs,
	listPublishedEvents,
	type PublicEventDetail,
	type PublicEventSummary,
} from '../services/public-event-repository';
import type { WorkerEnv } from '../types/env';
import { PUBLIC_CANONICAL_ORIGIN } from '../config';

const PAGE_CACHE = 'public, max-age=60, stale-while-revalidate=300';

function escapeHtml(value: string | null | undefined): string {
	return (value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function safeUrl(value: string | null | undefined): string | null {
	if (!value) return null;
	try {
		const url = new URL(value, PUBLIC_CANONICAL_ORIGIN);
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
	} catch {
		return null;
	}
}

function absoluteUrl(value: string): string {
	return new URL(value, PUBLIC_CANONICAL_ORIGIN).href;
}

function jsonForHtml(value: unknown): string {
	return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`);
}

interface PageMeta {
	title: string;
	description: string;
	canonicalPath: string;
	image?: string | null;
	jsonLd?: unknown;
	ogType?: 'website' | 'article';
}

function html(body: string, meta: PageMeta, status = 200, head = false): Response {
	const canonical = absoluteUrl(meta.canonicalPath);
	const image = safeUrl(meta.image);
	const document = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(meta.title)}</title><meta name="description" content="${escapeHtml(meta.description)}"><link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:type" content="${meta.ogType ?? 'website'}"><meta property="og:site_name" content="Bangkok Wine Scout"><meta property="og:title" content="${escapeHtml(meta.title)}"><meta property="og:description" content="${escapeHtml(meta.description)}"><meta property="og:url" content="${escapeHtml(canonical)}">${image ? `<meta property="og:image" content="${escapeHtml(image)}">` : ''}${meta.jsonLd ? `<script type="application/ld+json">${jsonForHtml(meta.jsonLd)}</script>` : ''}<style>${styles}</style></head><body>${body}</body></html>`;
	return new Response(head ? null : document, {
		status,
		headers: {
			'content-type': 'text/html; charset=UTF-8',
			'cache-control': status === 200 ? PAGE_CACHE : 'no-store',
			'x-content-type-options': 'nosniff',
			'content-security-policy': "default-src 'none'; img-src 'self' https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
		},
	});
}

function displayDate(value: string | null): string {
	return value ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'Asia/Bangkok' }).format(new Date(`${value}T00:00:00+07:00`)) : 'Date to be announced';
}

function displayTime(event: Pick<PublicEventSummary, 'startTime' | 'endTime'>): string | null {
	return event.startTime ? `${event.startTime}${event.endTime ? `–${event.endTime}` : ''}` : null;
}

function displayPrice(event: Pick<PublicEventSummary, 'priceText' | 'priceTHB' | 'currency' | 'priceQualifier'>): string | null {
	return event.priceText ?? (event.priceTHB !== null ? `${event.currency ?? 'THB'} ${event.priceTHB.toLocaleString('en-US')}${event.priceQualifier ?? ''}` : null);
}

function hero(event: PublicEventSummary): string {
	return event.heroAsset ? `<img class="hero" src="${escapeHtml(event.heroAsset.url)}" alt="${escapeHtml(event.heroAsset.alt)}">` : '<div class="hero placeholder" aria-hidden="true">Wine event</div>';
}

function card(event: PublicEventSummary): string {
	return `<article class="card">${hero(event)}<div class="card-body"><p class="eyebrow">${escapeHtml(displayDate(event.date))}${displayTime(event) ? ` · ${escapeHtml(displayTime(event))}` : ''}</p><h2><a href="/events/${encodeURIComponent(event.slug)}">${escapeHtml(event.title || 'Wine event')}</a></h2>${event.venue ? `<p>${escapeHtml(event.venue)}</p>` : ''}${displayPrice(event) ? `<p class="price">${escapeHtml(displayPrice(event))}</p>` : ''}</div></article>`;
}

function row(label: string, value: string | null | undefined): string {
	return value ? `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>` : '';
}

function navigation(): string {
	return '<nav aria-label="Main navigation"><a href="/">Home</a><a href="/events">Events</a><a href="/about">About</a><a href="/share-an-event">Share an Event</a></nav>';
}

function shell(content: string): string {
	return `<header><a class="brand" href="/">Bangkok Wine Scout</a>${navigation()}</header>${content}<footer>Bangkok Wine Scout</footer>`;
}

function metadataDescription(event: PublicEventSummary): string {
	const fallback = [event.title || 'Wine event', event.date ? displayDate(event.date) : null, event.venue].filter(Boolean).join(' — ');
	const source = event.description?.trim() || fallback;
	return source.length > 160 ? `${source.slice(0, 157).trimEnd()}…` : source;
}

function isoDateTime(date: string | null, time: string | null): string | null {
	if (!date) return null;
	return time ? `${date}T${time}:00+07:00` : date;
}

function eventJsonLd(event: PublicEventDetail): Record<string, unknown> {
	const canonical = absoluteUrl(`/events/${event.slug}`);
	const location = event.venue || event.address ? {
		'@type': 'Place',
		...(event.venue ? { name: event.venue } : {}),
		...(event.address ? { address: event.address } : {}),
	} : undefined;
	const offerUrl = safeUrl(event.bookingUrl);
	const price = event.priceTHB !== null ? event.priceTHB : undefined;
	return {
		'@context': 'https://schema.org',
		'@type': 'Event',
		name: event.title || 'Wine event',
		...(isoDateTime(event.date, event.startTime) ? { startDate: isoDateTime(event.date, event.startTime) } : {}),
		...(event.date && event.endTime ? { endDate: isoDateTime(event.date, event.endTime) } : {}),
		...(event.description ? { description: event.description } : {}),
		...(event.heroAsset ? { image: [absoluteUrl(event.heroAsset.url)] } : {}),
		url: canonical,
		...(location ? { location } : {}),
		...(event.organizer ? { organizer: { '@type': 'Organization', name: event.organizer } } : {}),
		...(price !== undefined || offerUrl ? {
			offers: {
				'@type': 'Offer',
				...(price !== undefined ? { price, priceCurrency: event.currency || 'THB' } : {}),
				...(offerUrl ? { url: offerUrl } : {}),
			},
		} : {}),
	};
}

function isIsoDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function eventListOptions(url: URL): { from?: string; to?: string; includePast: boolean } | Response {
	const from = url.searchParams.get('from') || undefined;
	const to = url.searchParams.get('to') || undefined;
	if ((from && !isIsoDate(from)) || (to && !isIsoDate(to)) || (from && to && from > to)) {
		return html(shell('<main class="empty"><h1>Invalid date range</h1><p>Dates must use YYYY-MM-DD and the start must not be after the end.</p></main>'), { title: 'Invalid date range | Bangkok Wine Scout', description: 'The requested event date range is invalid.', canonicalPath: '/events' }, 400);
	}
	return { from, to, includePast: url.searchParams.get('includePast') === 'true' };
}

async function eventList(request: Request, env: WorkerEnv, head: boolean): Promise<Response> {
	const url = new URL(request.url);
	const options = eventListOptions(url);
	if (options instanceof Response) return options;
	const result = await listPublishedEvents(env.DB, { limit: 50, ...options, todayBangkok: getBangkokLocalDate() });
	const body = shell(`<main><section class="intro"><p class="kicker">Bangkok Wine Scout</p><h1>Wine events in Bangkok</h1><p>Discover upcoming wine tastings, wine dinners and other published wine experiences across Bangkok.</p></section>${result.events.length ? `<section class="grid" aria-label="Wine events">${result.events.map(card).join('')}</section>` : '<section class="empty"><h2>No events found</h2><p>New events will appear here after publication.</p></section>'}</main>`);
	return html(body, {
		title: 'Bangkok Wine Events, Tastings & Wine Dinners | Bangkok Wine Scout',
		description: 'Discover wine events in Bangkok, including upcoming wine tastings, pairing dinners and other published wine experiences.',
		canonicalPath: '/events',
	}, 200, head);
}

function detail(event: PublicEventDetail): string {
	const booking = safeUrl(event.bookingUrl);
	const website = safeUrl(event.websiteUrl);
	const contacts = [event.contactPhone, event.contactEmail, event.contactText].filter(Boolean).join(' · ');
	return shell(`<main class="detail"><section>${hero(event)}</section><article class="panel"><p class="eyebrow">${escapeHtml(displayDate(event.date))}${displayTime(event) ? ` · ${escapeHtml(displayTime(event))}` : ''}</p><h1>${escapeHtml(event.title || 'Wine event')}</h1>${event.description ? `<p>${escapeHtml(event.description)}</p>` : ''}<dl>${row('Venue', event.venue)}${row('Organizer', event.organizer)}${row('Address', event.address)}${row('Price', displayPrice(event))}${row('Contact', contacts || null)}${row('Courses', event.courseCount !== null ? String(event.courseCount) : null)}${row('Wines', event.wines.join(', ') || null)}${row('Producers', event.wineProducers.join(', ') || null)}</dl><div class="actions">${booking ? `<a class="button" href="${escapeHtml(booking)}" rel="noopener noreferrer">Book this event</a>` : ''}${website ? `<a class="button secondary" href="${escapeHtml(website)}" rel="noopener noreferrer">Venue website</a>` : ''}<a class="button secondary" href="/events">Back to all events</a></div></article></main>`);
}

async function eventDetail(pathname: string, env: WorkerEnv, head: boolean): Promise<Response> {
	const match = pathname.match(/^\/events\/([^/]+)$/);
	if (!match) return notFound(head);
	let slug: string;
	try { slug = decodeURIComponent(match[1]); } catch { return notFound(head); }
	if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return notFound(head);
	const event = await getPublishedEventBySlug(env.DB, slug);
	if (!event) return notFound(head);
	return html(detail(event), {
		title: `${event.title || 'Wine event'} | Bangkok Wine Scout`,
		description: metadataDescription(event),
		canonicalPath: `/events/${event.slug}`,
		image: event.heroAsset ? absoluteUrl(event.heroAsset.url) : null,
		jsonLd: eventJsonLd(event),
		ogType: 'article',
	}, 200, head);
}

type InformationalPagePath = '/about' | '/share-an-event' | '/legal' | '/privacy' | '/disclaimer';

interface InformationalPageDefinition {
	title: string;
	description: string;
	content: string;
}

const INFORMATIONAL_PAGES: Record<InformationalPagePath, InformationalPageDefinition> = {
	'/about': {
		title: 'About Bangkok Wine Scout | Bangkok Wine Events',
		description: 'Discover Bangkok Wine Scout, a community-driven guide to wine tastings, wine dinners, masterclasses and other wine events in Bangkok.',
		content: '<h1>About Bangkok Wine Scout</h1><p>Bangkok Wine Scout is a community-driven way to discover wine tastings, dinners and other wine experiences around Bangkok.</p><p>Anyone may submit a suitable Bangkok wine event. You might be the organizer, a restaurant or hotel, a wine professional, or simply someone who discovered an interesting event and wants others to know about it.</p><p><a href="/events">Browse wine events</a></p>',
	},
	'/share-an-event': {
		title: 'Share a Wine Event in Bangkok | Bangkok Wine Scout',
		description: 'Know about a wine event in Bangkok? Send the flyer or event details to Bangkok Wine Scout via LINE and share it with the community.',
		content: '<h1>Share a Wine Event</h1><p>Found an interesting wine event in Bangkok? Share the flyer or event details with the community.</p><p>You do not need to be the organizer. Restaurants, hotels, importers, wine professionals, guests and anyone who comes across a suitable event are welcome to send it.</p><p><a class="button" href="https://lin.ee/V28460i" rel="noopener noreferrer">Send it via LINE</a></p><p>Events are reviewed before they appear publicly.</p>',
	},
	'/legal': {
		title: 'Legal & Contact | Bangkok Wine Scout',
		description: 'Legal and contact information for Bangkok Wine Scout, an independent wine event discovery platform in Bangkok.',
		content: '<h1>Legal &amp; Contact</h1><p><strong>Bangkok Wine Scout</strong><br>Independent wine event discovery platform<br>Bangkok, Thailand</p><p>For questions, corrections, event submissions or requests concerning published content, contact Bangkok Wine Scout through LINE.</p><p><a class="button" href="https://lin.ee/V28460i" rel="noopener noreferrer">Contact Bangkok Wine Scout on LINE</a></p>',
	},
	'/privacy': {
		title: 'Privacy Policy | Bangkok Wine Scout',
		description: 'Learn what information Bangkok Wine Scout receives, how it is used and how to contact us about information you submitted.',
		content: '<h1>Privacy Policy</h1><p><strong>Last updated: August 2026</strong></p><h2>Information we receive and use</h2><p>Bangkok Wine Scout may receive LINE profile or contact information that you voluntarily provide, along with submitted flyers, images and event information. We use it to review, process and, where appropriate, publish event information. Public event information may be stored in our systems.</p><h2>Website services</h2><p>We use Google Analytics to understand aggregate website usage. Our technical infrastructure and service providers may process normal technical information needed to operate the service. Bangkok Wine Scout does not sell personal information.</p><h2>Your requests and external services</h2><p>You may request access to, correction of or deletion of information you submitted by contacting us through LINE. External links and services, including LINE and booking pages, follow their own privacy practices. This policy may change as the service changes.</p><p><a href="https://lin.ee/V28460i" rel="noopener noreferrer">Contact us through LINE</a></p>',
	},
	'/disclaimer': {
		title: 'Disclaimer | Bangkok Wine Scout',
		description: 'Important information about event listings and external links on Bangkok Wine Scout.',
		content: '<h1>Disclaimer</h1><p>Bangkok Wine Scout is an independent event discovery service. It is not the organizer of listed events unless explicitly stated.</p><p>Information may come from organizers, venues, public materials or community submissions. Dates, prices, availability, locations and booking details may change.</p><p>Confirm important details directly with the organizer or venue before attending or paying. External links are provided for convenience.</p>',
	},
};

function informationalPage(path: InformationalPagePath, head: boolean): Response {
	const page = INFORMATIONAL_PAGES[path];
	return html(shell(`<main class="prose">${page.content}</main>`), {
		title: page.title,
		description: page.description,
		canonicalPath: path,
	}, 200, head);
}

function home(head: boolean): Response {
	return html(shell('<main class="prose"><p class="kicker">Bangkok Wine Scout</p><h1>Find wine events in Bangkok</h1><p>Discover published wine tastings, pairing dinners and wine experiences across Bangkok.</p><p><a class="button" href="/events">Browse wine events</a></p></main>'), {
		title: 'Bangkok Wine Scout | Wine Events in Bangkok',
		description: 'Discover published wine tastings, pairing dinners and other wine events across Bangkok.',
		canonicalPath: '/',
	}, 200, head);
}

async function sitemap(env: WorkerEnv, head: boolean): Promise<Response> {
	const slugs = await listPublishedEventSlugs(env.DB);
	const paths = ['/', '/events', '/about', '/share-an-event', '/legal', '/privacy', '/disclaimer', ...slugs.map((slug) => `/events/${slug}`)];
	const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths.map((path) => `  <url><loc>${escapeHtml(absoluteUrl(path))}</loc></url>`).join('\n')}\n</urlset>`;
	return new Response(head ? null : xml, { headers: { 'content-type': 'application/xml; charset=UTF-8', 'cache-control': PAGE_CACHE, 'x-content-type-options': 'nosniff' } });
}

function robots(head: boolean): Response {
	const body = `User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /api/\nDisallow: /webhook\n\nSitemap: ${PUBLIC_CANONICAL_ORIGIN}/sitemap.xml\n`;
	return new Response(head ? null : body, { headers: { 'content-type': 'text/plain; charset=UTF-8', 'cache-control': PAGE_CACHE, 'x-content-type-options': 'nosniff' } });
}

function notFound(head: boolean): Response {
	return html(shell('<main class="empty"><h1>Not found</h1><p>The requested page does not exist. <a href="/events">Browse published events</a>.</p></main>'), { title: 'Not found | Bangkok Wine Scout', description: 'The requested page does not exist.', canonicalPath: '/events' }, 404, head);
}

export async function handlePublicEventPages(request: Request, env: WorkerEnv): Promise<Response> {
	const url = new URL(request.url);
	const head = request.method === 'HEAD';
	if (request.method !== 'GET' && !head) return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
	if (url.pathname === '/') return home(head);
	if (url.pathname === '/events') return eventList(request, env, head);
	if (url.pathname.startsWith('/events/')) return eventDetail(url.pathname, env, head);
	if (url.pathname === '/about' || url.pathname === '/share-an-event' || url.pathname === '/legal' || url.pathname === '/privacy' || url.pathname === '/disclaimer') {
		return informationalPage(url.pathname, head);
	}
	if (url.pathname === '/sitemap.xml') return sitemap(env, head);
	if (url.pathname === '/robots.txt') return robots(head);
	return notFound(head);
}

const styles = `:root{font-family:ui-serif,Georgia,serif;color:#281b20;background:#f6f1ea}*{box-sizing:border-box}body{margin:0}header,main,footer{width:min(1100px,calc(100% - 32px));margin:auto}header{padding:32px 0 24px;border-bottom:1px solid #d8cbc0;display:flex;align-items:center;justify-content:space-between;gap:20px}.brand{font-weight:700;color:inherit;text-decoration:none}nav{display:flex;flex-wrap:wrap;gap:16px}nav a{color:inherit}.kicker,.eyebrow{font:600 .78rem/1.4 ui-sans-serif,system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:#7c3949}h1{font-size:clamp(2.2rem,6vw,4.8rem);line-height:.98;margin:.2em 0}h2{font-size:1.5rem;margin:.25rem 0}h2 a{color:inherit}p{line-height:1.6}.intro,.prose{padding:56px 0 24px}.prose{max-width:760px;margin:auto;min-height:55vh}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:24px;padding:32px 0 64px}.card{background:#fff;border:1px solid #ded4ca;border-radius:12px;overflow:hidden}.card-body{padding:20px}.hero{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;background:#e9dfd4}.placeholder{display:grid;place-items:center;color:#997d72}.price{font-weight:700}.detail{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(260px,.75fr);gap:36px;padding:36px 0 64px}.detail .hero{border-radius:12px;max-height:720px;aspect-ratio:auto}.panel{background:#fff;border:1px solid #ded4ca;border-radius:12px;padding:24px}.panel h1{font-size:clamp(2rem,5vw,3.6rem)}dl{display:grid;grid-template-columns:max-content 1fr;gap:10px 18px}dt{font-weight:700}dd{margin:0;overflow-wrap:anywhere}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}.button{display:inline-block;padding:10px 15px;background:#722b3d;color:#fff;border-radius:7px;text-decoration:none}.secondary{background:#e9dfd4;color:#281b20}.empty{padding:64px 0;min-height:55vh}footer{border-top:1px solid #d8cbc0;padding:24px 0 40px;color:#705f60}@media(max-width:720px){.detail{grid-template-columns:1fr}header{align-items:flex-start;flex-direction:column}dl{grid-template-columns:1fr;gap:4px}dd{margin-bottom:10px}}`;
