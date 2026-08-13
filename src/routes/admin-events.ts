import { deleteEventCompletely, EventDeleteVerificationError } from '../services/admin-event-deletion-service';
import { getAdminImageAsset, listAdminEvents } from '../services/event-repository';
import type { WorkerEnv } from '../types/env';
import { queueEventReprocess } from '../services/event-reprocess-service';
import { deleteAdminReviewItem, listAdminReviewItems } from '../services/admin-review-item-service';

const SESSION_COOKIE = '__Host-bws_admin_session';
const SESSION_SECONDS = 8 * 60 * 60;
const encoder = new TextEncoder();

function json(body: unknown, status: number): Response {
	return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function validEventId(pathValue: string): string | null {
	try {
		const value = decodeURIComponent(pathValue);
		return value.length > 0 && value.length <= 500 && !/[\u0000-\u001f\u007f/]/.test(value) ? value : null;
	} catch {
		return null;
	}
}

async function sameSecret(provided: string, expected: string): Promise<boolean> {
	const [left, right] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(provided)),
		crypto.subtle.digest('SHA-256', encoder.encode(expected)),
	]);
	const a = new Uint8Array(left);
	const b = new Uint8Array(right);
	let difference = a.length ^ b.length;
	for (let index = 0; index < Math.max(a.length, b.length); index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
	return difference === 0;
}

function base64Url(bytes: ArrayBuffer): string {
	let binary = '';
	for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function readCookie(request: Request, name: string): string | null {
	for (const part of (request.headers.get('cookie') ?? '').split(';')) {
		const separator = part.indexOf('=');
		if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
		return part.slice(separator + 1).trim();
	}
	return null;
}

async function sessionSignature(payload: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
	);
	return base64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}

async function createSession(secret: string, now = Date.now()): Promise<string> {
	const payload = `v1.${Math.floor(now / 1000) + SESSION_SECONDS}`;
	return `${payload}.${await sessionSignature(payload, secret)}`;
}

async function hasValidSession(request: Request, secret: string, now = Date.now()): Promise<boolean> {
	const value = readCookie(request, SESSION_COOKIE);
	if (!value) return false;
	const match = /^(v1\.([0-9]{10}))\.([A-Za-z0-9_-]{43})$/.exec(value);
	if (!match || Number(match[2]) <= Math.floor(now / 1000)) return false;
	return sameSecret(match[3], await sessionSignature(`${match[1]}`, secret));
}

async function isAuthorized(request: Request, env: WorkerEnv): Promise<boolean> {
	const expected = env.ADMIN_API_TOKEN?.trim();
	if (!expected) return false;
	const authorization = request.headers.get('authorization');
	if (authorization?.startsWith('Bearer ') && await sameSecret(authorization.slice(7), expected)) return true;
	return hasValidSession(request, expected);
}

function htmlResponse(body: string, status = 200, nonce?: string): Response {
	const headers = new Headers({
		'content-type': 'text/html; charset=UTF-8',
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
		'x-frame-options': 'DENY',
		'referrer-policy': 'no-referrer',
		'content-security-policy': nonce
			? `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
			: "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
	});
	return new Response(body, { status, headers });
}

function loginPage(invalid = false): Response {
	return htmlResponse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bangkok Wine Scout Admin</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#160f12;color:#f8f1eb;font:16px/1.5 system-ui,sans-serif}.card{width:min(92vw,420px);padding:32px;border:1px solid #5a343f;border-radius:18px;background:#24171c;box-shadow:0 24px 70px #0008}h1{font-family:Georgia,serif;font-size:28px;margin:0 0 8px}.muted{color:#c8afb5;margin:0 0 24px}label{display:block;font-weight:700;margin-bottom:8px}input{width:100%;padding:12px 14px;border:1px solid #80505d;border-radius:9px;background:#120b0e;color:white;font:inherit}button{width:100%;margin-top:16px;padding:12px;border:0;border-radius:9px;background:#a72d48;color:white;font-weight:800;font:inherit;cursor:pointer}.error{padding:10px 12px;border-radius:8px;background:#4b1723;color:#ffdce4;margin-bottom:16px}</style></head>
<body><main class="card"><h1>Bangkok Wine Scout Admin</h1><p class="muted">Sign in to inspect and manage events.</p>${invalid ? '<p class="error" role="alert">Invalid admin token.</p>' : ''}<form method="post" action="/admin/login"><label for="token">Admin token</label><input id="token" name="token" type="password" required autocomplete="current-password"><button type="submit">Sign in</button></form></main></body></html>`, invalid ? 401 : 200);
}

function randomNonce(): string {
	const bytes = new Uint8Array(18);
	crypto.getRandomValues(bytes);
	return base64Url(bytes.buffer);
}

function adminPage(): Response {
	const nonce = randomNonce();
	return htmlResponse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bangkok Wine Scout Admin</title><style nonce="${nonce}">
:root{color-scheme:dark;--bg:#130e10;--panel:#21171b;--line:#54343d;--wine:#b43655;--text:#f7f0eb;--muted:#beaab0;--green:#3aa675;--amber:#d09a42}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top right,#341821 0,transparent 38%),var(--bg);color:var(--text);font:14px/1.45 system-ui,sans-serif}button,input,select{font:inherit}.shell{width:min(1240px,94vw);margin:0 auto;padding:30px 0 60px}.top{display:flex;gap:18px;align-items:center;justify-content:space-between;margin-bottom:24px}.eyebrow{color:#d18a9d;text-transform:uppercase;letter-spacing:.13em;font-size:11px;font-weight:800}.top h1{font:34px/1.1 Georgia,serif;margin:4px 0}.top p{color:var(--muted);margin:5px 0}.actions{display:flex;gap:9px}.btn{border:1px solid var(--line);border-radius:8px;padding:9px 13px;background:#2c1d22;color:var(--text);cursor:pointer;font-weight:700}.btn:hover{border-color:#a66}.btn:disabled{opacity:.55;cursor:wait}.danger{background:#9f2944;border-color:#c44763}.danger:hover{background:#b83250}.toolbar{display:grid;grid-template-columns:minmax(220px,1fr) 170px 220px;gap:10px;margin-bottom:10px}.bulkbar{min-height:45px;display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;padding:8px 10px 8px 14px;border:1px solid var(--line);border-radius:9px;background:#21171b;color:var(--muted)}.control{width:100%;border:1px solid var(--line);border-radius:9px;padding:11px 12px;background:#21171b;color:var(--text)}.panel{overflow:hidden;border:1px solid var(--line);border-radius:13px;background:color-mix(in srgb,var(--panel) 94%,transparent);box-shadow:0 20px 60px #0004}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;min-width:1030px}th,td{padding:11px 12px;text-align:left;border-bottom:1px solid #412931}th{color:#cbb7bd;font-size:11px;text-transform:uppercase;letter-spacing:.08em;background:#291b20}.checkcell{width:42px;text-align:center}.checkcell input{width:17px;height:17px;accent-color:var(--wine)}.thumb{width:72px;height:72px;border-radius:9px;object-fit:cover;display:block;background:#37262c}.no-image{width:72px;height:72px;border:1px dashed #67444e;border-radius:9px;display:grid;place-items:center;text-align:center;color:#9f858c;font-size:11px;background:#2b1d22}.titlecell{font-weight:750;max-width:280px}.sub{display:block;color:var(--muted);font-size:12px;margin-top:3px}.badge{display:inline-flex;border-radius:999px;padding:4px 8px;font-size:11px;font-weight:800;text-transform:capitalize}.published{background:#163b2d;color:#8ee1ba}.draft{background:#493416;color:#f2c87d}.other{background:#3a2b38;color:#dac2d6}.empty,.loading,.error-state{padding:55px 20px;text-align:center;color:var(--muted)}.error-state{color:#ffb7c6}.footer{display:flex;justify-content:space-between;padding:12px 15px;color:var(--muted);font-size:12px}.review-section{margin-top:36px}.section-head{display:flex;align-items:end;justify-content:space-between;gap:16px;margin-bottom:12px}.section-head h2{font:27px/1.2 Georgia,serif;margin:0}.section-head p{color:var(--muted);margin:5px 0 0}.review-panel{border-color:#76502e}.review-panel th{background:#33251a}.review-reason{min-width:240px;max-width:390px;color:#f1c989}.toast{position:fixed;right:20px;bottom:20px;max-width:390px;padding:12px 15px;border-radius:9px;background:#244b39;color:#c9f8df;box-shadow:0 12px 40px #0008}.toast.error{background:#5a1d2b;color:#ffe0e7}dialog{width:min(92vw,520px);border:1px solid #744352;border-radius:14px;padding:0;background:#27191e;color:var(--text);box-shadow:0 30px 90px #000b}dialog::backdrop{background:#080507c9}.modal{padding:25px}.modal h2{font:25px Georgia,serif;margin:0 0 8px}.warning{background:#3c2028;border:1px solid #6c3443;border-radius:9px;padding:13px;margin:18px 0;color:#f5dce2}.modal label{font-weight:750}.modal input{margin-top:8px}.modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}@media(max-width:720px){.shell{padding-top:20px}.top{align-items:flex-start;flex-direction:column}.top h1{font-size:28px}.toolbar{grid-template-columns:1fr}.actions{width:100%}.actions .btn{flex:1}.thumb,.no-image{width:56px;height:56px}.bulkbar,.section-head{align-items:flex-start;flex-direction:column}.bulkbar .btn{width:100%}}
</style></head><body><main class="shell"><header class="top"><div><div class="eyebrow">Operations</div><h1>Bangkok Wine Scout Admin</h1><p><strong id="count">0</strong> events in the catalogue</p></div><div class="actions"><button class="btn" id="refresh" type="button">Refresh</button><form method="post" action="/admin/logout"><button class="btn" type="submit">Log out</button></form></div></header><nav class="actions" aria-label="Admin sections" style="margin-bottom:18px"><a class="btn" href="/admin/events-ui" aria-current="page">Events</a></nav>
<section class="toolbar" aria-label="Event controls"><input class="control" id="search" type="search" placeholder="Search title or venue…" aria-label="Search events"><select class="control" id="status" aria-label="Filter status"><option value="all">All statuses</option><option value="published">Published</option><option value="draft">Draft</option></select><select class="control" id="sort" aria-label="Sort events"><option value="event-desc">Event date descending</option><option value="event-asc">Event date ascending</option><option value="created-desc">Created date descending</option></select></section>
<section class="bulkbar" aria-label="Bulk actions"><span><strong id="selected-count">0</strong> events selected</span><button class="btn danger" id="bulk-delete" type="button" disabled>Delete selected permanently</button></section>
<section class="panel"><div class="table-wrap"><table><thead><tr><th class="checkcell"><input id="select-all" type="checkbox" aria-label="Select all visible events"></th><th>Image</th><th>Title</th><th>Event date</th><th>Venue</th><th>Status</th><th>Assets</th><th>Created</th><th>Actions</th></tr></thead><tbody id="rows"><tr><td class="loading" colspan="9">Loading events…</td></tr></tbody></table></div><div class="footer"><span id="shown">Loading…</span><span>Permanent deletion cannot be undone</span></div></section>
<section class="review-section" aria-labelledby="review-heading"><div class="section-head"><div><div class="eyebrow">Private intake queue</div><h2 id="review-heading">Unpublished / Needs review</h2><p><strong id="review-count">0</strong> received items require review and are not public.</p></div></div><div class="panel review-panel"><div class="table-wrap"><table><thead><tr><th>Image</th><th>Title</th><th>Event date</th><th>Venue</th><th>Received</th><th>Review reason</th><th>Source</th><th>Actions</th></tr></thead><tbody id="review-rows"><tr><td class="loading" colspan="8">Loading review items…</td></tr></tbody></table></div><div class="footer"><span id="review-shown">Loading…</span><span>Review items remain private</span></div></div></section></main>
<dialog id="confirm"><form method="dialog" class="modal" id="confirm-form"><h2>Delete permanently?</h2><p id="target"></p><div class="warning" id="delete-warning">This removes database records, images, LINE references, OCR data, and website publication. The original message in the user's LINE chat cannot be deleted.</div><label for="confirm-text">Type <strong>DELETE</strong> to confirm</label><input class="control" id="confirm-text" autocomplete="off"><div class="modal-actions"><button class="btn" value="cancel">Cancel</button><button class="btn danger" id="confirm-delete" value="default" disabled>Delete permanently</button></div></form></dialog><div id="toast" hidden></div>
<script nonce="${nonce}">
(()=>{const state={events:[],reviews:[],targets:[],selected:new Set(),bulk:false,targetKind:'event'};const $=id=>document.getElementById(id);const rows=$('rows'),reviewRows=$('review-rows'),count=$('count'),reviewCount=$('review-count'),shown=$('shown'),reviewShown=$('review-shown'),dialog=$('confirm'),confirmText=$('confirm-text'),confirmDelete=$('confirm-delete'),selectAll=$('select-all'),bulkDelete=$('bulk-delete');
const safeDate=value=>{if(!value)return '—';const date=new Date(value.length===10?value+'T00:00:00Z':value);return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeZone:'UTC'}).format(date)};
const toast=(message,error=false)=>{const el=$('toast');el.textContent=message;el.className='toast'+(error?' error':'');el.hidden=false;setTimeout(()=>el.hidden=true,5000)};
const text=(tag,value,className)=>{const el=document.createElement(tag);el.textContent=typeof value==='string'?value:'—';if(className)el.className=className;return el};
function filtered(){const query=$('search').value.trim().toLowerCase(),status=$('status').value,sort=$('sort').value;const values=state.events.filter(e=>(status==='all'||e.status===status)&&(!query||String(e.title||'').toLowerCase().includes(query)||String(e.venue||'').toLowerCase().includes(query)));const time=(v,fallback)=>{const n=Date.parse(v||'');return Number.isNaN(n)?fallback:n};values.sort((a,b)=>sort==='created-desc'?time(b.createdAt,0)-time(a.createdAt,0):sort==='event-asc'?time(a.eventDate,Infinity)-time(b.eventDate,Infinity):time(b.eventDate,-Infinity)-time(a.eventDate,-Infinity));return values}
function updateSelection(values){const visible=values.map(e=>e.id),selectedVisible=visible.filter(id=>state.selected.has(id)).length;$('selected-count').textContent=String(state.selected.size);bulkDelete.disabled=state.selected.size===0;selectAll.checked=visible.length>0&&selectedVisible===visible.length;selectAll.indeterminate=selectedVisible>0&&selectedVisible<visible.length}
function render(){const values=filtered();rows.replaceChildren();count.textContent=String(state.events.length);shown.textContent='Showing '+values.length+' of '+state.events.length;updateSelection(values);if(!values.length){const tr=document.createElement('tr'),td=text('td',state.events.length?'No matching events.':'No events found.','empty');td.colSpan=9;tr.append(td);rows.append(tr);return}for(const event of values){const tr=document.createElement('tr'),checkCell=document.createElement('td'),checkbox=document.createElement('input');checkCell.className='checkcell';checkbox.type='checkbox';checkbox.checked=state.selected.has(event.id);checkbox.setAttribute('aria-label','Select '+(event.title||'untitled event'));checkbox.addEventListener('change',()=>{checkbox.checked?state.selected.add(event.id):state.selected.delete(event.id);updateSelection(filtered())});checkCell.append(checkbox);const imageCell=document.createElement('td');if(typeof event.thumbnailUrl==='string'&&event.thumbnailUrl){const image=document.createElement('img');image.className='thumb';image.src=event.thumbnailUrl;image.loading='lazy';image.alt=(event.title||'Wine event')+' '+(event.thumbnailAssetType||'event')+' image';image.width=72;image.height=72;imageCell.append(image)}else imageCell.append(text('span','No image','no-image'));const title=text('td',event.title||'Untitled event','titlecell');title.append(text('span',event.slug||event.id,'sub'));tr.append(checkCell,imageCell,title,text('td',safeDate(event.eventDate)),text('td',event.venue||'—'));const status=document.createElement('td'),badge=text('span',event.status||'unknown','badge '+(event.status==='published'?'published':event.status==='draft'?'draft':'other'));status.append(badge);tr.append(status,text('td',String(Number.isFinite(event.assetCount)?event.assetCount:0)),text('td',safeDate(event.createdAt)));const action=document.createElement('td'),button=text('button','Delete permanently','btn danger');button.type='button';button.addEventListener('click',()=>openDelete([event],false));action.append(button);tr.append(action);rows.append(tr)}}
function renderReviews(){reviewRows.replaceChildren();reviewCount.textContent=String(state.reviews.length);reviewShown.textContent=state.reviews.length+' review item'+(state.reviews.length===1?'':'s');if(!state.reviews.length){const tr=document.createElement('tr'),td=text('td','No items currently need review.','empty');td.colSpan=8;tr.append(td);reviewRows.append(tr);return}for(const item of state.reviews){const tr=document.createElement('tr'),imageCell=document.createElement('td');if(typeof item.thumbnailUrl==='string'&&item.thumbnailUrl){const image=document.createElement('img');image.className='thumb';image.src=item.thumbnailUrl;image.loading='lazy';image.alt=(item.title||'Review item')+' source image';image.width=72;image.height=72;imageCell.append(image)}else imageCell.append(text('span','No image','no-image'));const title=text('td',item.title||'(missing title)','titlecell');title.append(text('span',item.id,'sub'));tr.append(imageCell,title,text('td',safeDate(item.eventDate)),text('td',item.venue||'—'),text('td',safeDate(item.receivedAt)),text('td',item.reviewReason||'Review required','review-reason'),text('td',item.source||'—'));const action=document.createElement('td'),button=text('button','Delete','btn danger');button.type='button';button.addEventListener('click',()=>openDelete([item],false,'review'));action.append(button);tr.append(action);reviewRows.append(tr)}}
function openDelete(items,bulk,kind='event'){state.targets=items;state.bulk=bulk;state.targetKind=kind;$('target').textContent=bulk?items.length+' selected events':(items[0].title||(kind==='review'?'(missing title)':'Untitled event'))+' · '+safeDate(items[0].eventDate);$('delete-warning').textContent=kind==='review'?'This removes the persisted private review submission, its diagnostics, and unshared stored source files. It cannot delete the original message in LINE.':'This removes database records, images, LINE references, OCR data, and website publication. The original message in the user\\'s LINE chat cannot be deleted.';confirmText.value='';confirmDelete.disabled=true;dialog.showModal();confirmText.focus()}
confirmText.addEventListener('input',()=>confirmDelete.disabled=confirmText.value!=='DELETE');$('confirm-form').addEventListener('submit',async event=>{if(event.submitter?.value!=='default')return;if(confirmText.value!=='DELETE'||!state.targets.length){event.preventDefault();return}event.preventDefault();const targets=[...state.targets],ids=targets.map(item=>item.id);confirmDelete.disabled=true;confirmDelete.textContent='Deleting…';try{const response=state.targetKind==='review'?await fetch('/admin/review-items/'+encodeURIComponent(ids[0]),{method:'DELETE'}):state.bulk?await fetch('/admin/events/bulk-delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({eventIds:ids})}):await fetch('/admin/events/'+encodeURIComponent(ids[0]),{method:'DELETE'});if(response.status===401){location.href='/admin/events-ui';return}const result=await response.json().catch(()=>null);if(!response.ok)throw new Error(result?.error?.message||'Deletion could not be completed.');const removed=state.targetKind==='review'?(result?.success?ids:[]):state.bulk?(result.results||[]).filter(item=>item?.success).map(item=>item.eventId):(result?.success?ids:[]);if(!removed.length)throw new Error(result?.error?.message||'No selected items were deleted.');const removedSet=new Set(removed);if(state.targetKind==='review')state.reviews=state.reviews.filter(item=>!removedSet.has(item.id));else{state.events=state.events.filter(item=>!removedSet.has(item.id));for(const id of removed)state.selected.delete(id)}dialog.close();render();renderReviews();if(state.bulk&&result.failed)toast(removed.length+' removed; '+result.failed+' failed and remain selected.',true);else toast(state.targetKind==='review'?'Review item deleted permanently.':removed.length===1?'Event deleted permanently.':removed.length+' events deleted permanently.')}catch(error){toast(error instanceof Error?error.message:'Network interruption. Please retry.',true)}finally{confirmDelete.textContent='Delete permanently';confirmDelete.disabled=confirmText.value!=='DELETE'}});
async function loadEvents(){rows.innerHTML='<tr><td class="loading" colspan="9">Loading events…</td></tr>';try{const response=await fetch('/admin/events');if(response.status===401){location.href='/admin/events-ui';return}const body=await response.json();if(!response.ok||!Array.isArray(body.events))throw new Error(body?.error?.message||'Malformed event data.');state.events=body.events.filter(e=>e&&typeof e.id==='string');const ids=new Set(state.events.map(e=>e.id));for(const id of state.selected)if(!ids.has(id))state.selected.delete(id);render()}catch(error){rows.innerHTML='';const tr=document.createElement('tr'),td=text('td',error instanceof Error?error.message:'Could not load events.','error-state');td.colSpan=9;tr.append(td);rows.append(tr);shown.textContent='Listing unavailable';toast('Failed to load events.',true)}}
async function loadReviews(){reviewRows.innerHTML='<tr><td class="loading" colspan="8">Loading review items…</td></tr>';try{const response=await fetch('/admin/review-items');if(response.status===401){location.href='/admin/events-ui';return}const body=await response.json();if(!response.ok||!Array.isArray(body.reviewItems))throw new Error(body?.error?.message||'Malformed review item data.');state.reviews=body.reviewItems.filter(item=>item&&typeof item.id==='string');renderReviews()}catch(error){reviewRows.innerHTML='';const tr=document.createElement('tr'),td=text('td',error instanceof Error?error.message:'Could not load review items.','error-state');td.colSpan=8;tr.append(td);reviewRows.append(tr);reviewShown.textContent='Listing unavailable';toast('Failed to load review items.',true)}}
const load=()=>Promise.all([loadEvents(),loadReviews()]);selectAll.addEventListener('change',()=>{for(const event of filtered())selectAll.checked?state.selected.add(event.id):state.selected.delete(event.id);render()});bulkDelete.addEventListener('click',()=>{const events=state.events.filter(event=>state.selected.has(event.id));if(events.length)openDelete(events,true)});for(const id of ['search','status','sort'])$(id).addEventListener(id==='search'?'input':'change',render);$('refresh').addEventListener('click',load);load()})();
</script></body></html>`, 200, nonce);
}

export async function handleAdminUi(request: Request, env: WorkerEnv): Promise<Response> {
	return await isAuthorized(request, env) ? adminPage() : loginPage();
}

export async function handleAdminLogin(request: Request, env: WorkerEnv): Promise<Response> {
	const expected = env.ADMIN_API_TOKEN?.trim();
	let token = '';
	try {
		const contentType = request.headers.get('content-type') ?? '';
		if (!contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) return loginPage(true);
		const body = await request.formData();
		const value = body.get('token');
		token = typeof value === 'string' ? value : '';
	} catch {
		return loginPage(true);
	}
	if (!expected || !await sameSecret(token, expected)) return loginPage(true);
	const response = new Response(null, {
		status: 303,
		headers: { location: '/admin/events-ui', 'cache-control': 'no-store' },
	});
	response.headers.set('set-cookie', `${SESSION_COOKIE}=${await createSession(expected)}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`);
	return response;
}

export function handleAdminLogout(): Response {
	const response = new Response(null, {
		status: 303,
		headers: { location: '/admin/events-ui', 'cache-control': 'no-store' },
	});
	response.headers.set('set-cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
	return response;
}

export async function handleAdminEventDelete(request: Request, env: WorkerEnv, encodedEventId: string): Promise<Response> {
	if (!await isAuthorized(request, env)) {
		return json({ error: { code: 'UNAUTHORIZED', message: 'Valid administrator credentials are required.' } }, 401);
	}
	const eventId = validEventId(encodedEventId);
	if (!eventId) return json({ error: { code: 'INVALID_EVENT_ID', message: 'eventId is invalid.' } }, 400);
	try {
		const result = await deleteEventCompletely(eventId, env);
		return json(result, 200);
	} catch(error) {
		return json({
				error: {
				code: 'EVENT_DELETE_FAILED',
				message: 'Complete event cleanup could not be confirmed. Retry the request safely.',
			},
			eventId,
			...(error instanceof EventDeleteVerificationError?{remainingRecords:error.remainingRecords}:{}),
		}, 500);
	}
}

export async function handleAdminEventReprocess(request: Request, env: WorkerEnv, encodedEventId: string): Promise<Response> {
	if (!await isAuthorized(request, env)) return json({error:{code:'UNAUTHORIZED',message:'Valid administrator credentials are required.'}},401);
	const eventId=validEventId(encodedEventId);
	if(!eventId)return json({error:{code:'INVALID_EVENT_ID',message:'eventId is invalid.'}},400);
	try {
		const result=await queueEventReprocess(eventId,env);
		return result?json({success:true,eventId,...result},202):json({error:{code:'REPROCESS_SOURCE_NOT_FOUND',message:'No replayable LINE image batch was found for this event.'}},404);
	} catch(error){console.error({event:'admin_event_reprocess_failed',eventId,error:error instanceof Error?error.message:String(error)});return json({error:{code:'EVENT_REPROCESS_FAILED',message:'The event could not be queued for reprocessing.'}},500);}
}

export async function handleAdminBulkEventDelete(request: Request, env: WorkerEnv): Promise<Response> {
	if (!await isAuthorized(request, env)) {
		return json({ error: { code: 'UNAUTHORIZED', message: 'Valid administrator credentials are required.' } }, 401);
	}
	let input: unknown;
	try {
		if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new Error();
		input = await request.json();
	} catch {
		return json({ error: { code: 'INVALID_REQUEST', message: 'A JSON body containing eventIds is required.' } }, 400);
	}
	const values = (input as { eventIds?: unknown } | null)?.eventIds;
	if (!Array.isArray(values) || values.length === 0 || values.length > 100) {
		return json({ error: { code: 'INVALID_EVENT_IDS', message: 'eventIds must contain 1 to 100 event IDs.' } }, 400);
	}
	const eventIds = [...new Set(values)];
	if (eventIds.some((value) => typeof value !== 'string' || validEventId(encodeURIComponent(value)) !== value)) {
		return json({ error: { code: 'INVALID_EVENT_IDS', message: 'One or more event IDs are invalid.' } }, 400);
	}
	const startedAt = Date.now();
	const results: Array<{ eventId: string; success: boolean; eventFound?: boolean; message?: string }> = [];
	for (const eventId of eventIds as string[]) {
		try {
			const result = await deleteEventCompletely(eventId, env);
			results.push({
				eventId,
				success: result.success,
				eventFound: result.eventFound,
				...(result.success ? {} : { message: 'Cleanup is incomplete and can be retried safely.' }),
			});
		} catch {
			results.push({ eventId, success: false, message: 'Complete event cleanup could not be confirmed.' });
		}
	}
	const deleted = results.filter((result) => result.success && result.eventFound === true).length;
	const alreadyMissing = results.filter((result) => result.success && result.eventFound === false).length;
	const failed = results.filter((result) => !result.success).length;
	console.log(JSON.stringify({
		event: 'admin_events_bulk_delete', requested: eventIds.length, deleted, alreadyMissing, failed,
		durationMs: Date.now() - startedAt,
	}));
	return json({ success: failed === 0, requested: eventIds.length, deleted, alreadyMissing, failed, results }, 200);
}

export async function handleAdminAsset(request: Request, env: WorkerEnv, encodedAssetId: string): Promise<Response> {
	if (!await isAuthorized(request, env)) return new Response('Unauthorized', { status: 401, headers: { 'cache-control': 'no-store' } });
	const assetId = validEventId(encodedAssetId);
	if (!assetId) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
	try {
		const canonicalAsset = await getAdminImageAsset(env.DB, assetId);
		const submissionAsset=canonicalAsset?null:await env.DB.prepare("SELECT r2_object_key,content_type FROM agent_submission_items WHERE asset_id=? AND item_type='image' LIMIT 1").bind(assetId).first<{r2_object_key:string|null;content_type:string|null}>();
		const asset=canonicalAsset??(submissionAsset?.r2_object_key?{r2ObjectKey:submissionAsset.r2_object_key,contentType:submissionAsset.content_type??'application/octet-stream'}:null);
		if (!asset) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
		const object = await env.EVENT_INTAKES.get(asset.r2ObjectKey);
		if (!object) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
		const headers = new Headers({
			'content-type': object.httpMetadata?.contentType ?? asset.contentType,
			'cache-control': 'private, max-age=300',
			'x-content-type-options': 'nosniff',
			'content-security-policy': "default-src 'none'; sandbox",
		});
		headers.set('etag', object.httpEtag);
		return new Response(object.body, { status: 200, headers });
	} catch {
		return new Response('Asset could not be loaded', { status: 500, headers: { 'cache-control': 'no-store' } });
	}
}

export async function handleAdminEventList(request: Request, env: WorkerEnv): Promise<Response> {
	if (!await isAuthorized(request, env)) {
		return json({ error: { code: 'UNAUTHORIZED', message: 'Valid administrator credentials are required.' } }, 401);
	}
	const startedAt = Date.now();
	try {
		const events = await listAdminEvents(env.DB);
		console.log(JSON.stringify({ event: 'admin_events_list', count: events.length, durationMs: Date.now() - startedAt }));
		return json({ events, count: events.length }, 200);
	} catch (error) {
		console.error(JSON.stringify({
			event: 'admin_events_list_failed',
			durationMs: Date.now() - startedAt,
			error: error instanceof Error ? error.message : String(error),
		}));
		return json({ error: { code: 'ADMIN_EVENTS_LIST_FAILED', message: 'Events could not be listed.' } }, 500);
	}
}

export async function handleAdminReviewItemList(request: Request, env: WorkerEnv): Promise<Response> {
	if (!await isAuthorized(request, env)) {
		return json({ error: { code: 'UNAUTHORIZED', message: 'Valid administrator credentials are required.' } }, 401);
	}
	try {
		const reviewItems = await listAdminReviewItems(env.DB);
		return json({ reviewItems, count: reviewItems.length }, 200);
	} catch (error) {
		console.error(JSON.stringify({ event: 'admin_review_items_list_failed', error: error instanceof Error ? error.message : String(error) }));
		return json({ error: { code: 'ADMIN_REVIEW_ITEMS_LIST_FAILED', message: 'Review items could not be listed.' } }, 500);
	}
}

export async function handleAdminReviewItemDelete(request: Request, env: WorkerEnv, encodedReviewItemId: string): Promise<Response> {
	if (!await isAuthorized(request, env)) {
		return json({ error: { code: 'UNAUTHORIZED', message: 'Valid administrator credentials are required.' } }, 401);
	}
	const reviewItemId = validEventId(encodedReviewItemId);
	if (!reviewItemId) return json({ error: { code: 'INVALID_REVIEW_ITEM_ID', message: 'reviewItemId is invalid.' } }, 400);
	try {
		const result = await deleteAdminReviewItem(reviewItemId, env);
		if (!result.success) {
			const cleanupFailed = result.reason === 'r2_cleanup_failed';
			return json({ error: {
				code: cleanupFailed ? 'REVIEW_ITEM_DELETE_FAILED' : 'NOT_REVIEW_ITEM',
				message: cleanupFailed ? 'Review item cleanup could not be completed. Retry safely.' : 'Only items currently marked needs_review can be deleted here.',
			}, reviewItemId }, cleanupFailed ? 500 : 409);
		}
		return json(result, 200);
	} catch (error) {
		console.error(JSON.stringify({ event: 'admin_review_item_delete_failed', reviewItemId, error: error instanceof Error ? error.message : String(error) }));
		return json({ error: { code: 'REVIEW_ITEM_DELETE_FAILED', message: 'Review item cleanup could not be completed. Retry safely.' }, reviewItemId }, 500);
	}
}
