export type AgentSubmissionStatus='collecting'|'queued'|'processing'|'needs_review'|'published'|'failed';
export type AgentSubmissionItemType='image'|'text'|'url';

export interface AgentSubmission {
	id:string;source:string;conversationKey:string;pushTarget:string|null;status:AgentSubmissionStatus;
	firstReceivedAt:string;lastReceivedAt:string;closedAt:string|null;workflowInstanceId:string|null;
	resultEventId:string|null;resultAction:string|null;errorCode:string|null;errorMessage:string|null;
	imageSetId:string|null;expectedImageCount:number|null;groupingStrategy:string|null;doneRequestedAt:string|null;doneSettleUntil:string|null;closureReason:string|null;appendRaceCount:number;webhookEventCount:number;imageEventCount:number;
	createdAt:string;updatedAt:string;
}
export interface AgentSubmissionItem {id:string;submissionId:string;sourceMessageId:string;webhookEventId:string|null;itemType:AgentSubmissionItemType;assetId:string|null;intakeId:string|null;r2ObjectKey:string|null;contentType:string|null;textContent:string|null;sourceUrl:string|null;ordinal:number;receivedAt:string;imageSetId?:string|null;imageSetIndex?:number|null;imageSetTotal?:number|null;webhookBatchId?:string|null;appendRaceResolved?:boolean;}

export interface AgentSubmissionIntakeDiagnostics {webhookEventCount:number;imageEventCount:number;imageSetId:string|null;expectedImageCount:number|null;receivedImageCount:number;receivedIndexes:number[];missingIndexes:number[];webhookPostCount:number;deliveryMode:'one_post'|'multiple_posts'|'unknown';groupingStrategy:string|null;appendRaceCount:number;finalImageCount:number;closureReason:string|null;}

export interface AgentSubmissionListItem extends AgentSubmission {
	itemCount:number;
	imageCount:number;
	textCount:number;
	urlCount:number;
	resultEventTitle:string|null;
	resultEventSlug:string|null;
	decision:string|null;
	confidence:number|null;
}
export interface AgentSubmissionListOptions {
	page?:number;
	pageSize?:number;
	sort?:'newest'|'oldest';
	status?:AgentSubmissionStatus;
	search?:string;
}
export interface AgentSubmissionDiagnostics {
	aiResult:unknown;
	validation:unknown;
	matching:unknown;
	uncertainties:unknown;
	urls:unknown;
	updatedAt:string;
}
export interface AgentSubmissionResult {
	publicationOutcome:{status:AgentSubmissionStatus;eventId:string|null;action:string|null;errorCode:string|null;errorMessage:string|null};
	event:{id:string;title:string|null;slug:string|null;eventDate:string|null;startTime:string|null;status:string;venue:string|null;address:string|null;price:string|null;bookingUrl:string|null;contact:string|null;description:string|null;wines:string[];menu:string[];createdAt:string}|null;
}

interface SubmissionRow {id:string;source:string;conversation_key:string;push_target:string|null;status:AgentSubmissionStatus;first_received_at:string;last_received_at:string;closed_at:string|null;workflow_instance_id:string|null;result_event_id:string|null;result_action:string|null;error_code:string|null;error_message:string|null;image_set_id:string|null;expected_image_count:number|null;grouping_strategy:string|null;done_requested_at:string|null;done_settle_until:string|null;closure_reason:string|null;append_race_count:number;webhook_event_count:number;image_event_count:number;created_at:string;updated_at:string;}
interface ItemRow {id:string;submission_id:string;source_message_id:string;webhook_event_id:string|null;item_type:AgentSubmissionItemType;asset_id:string|null;intake_id:string|null;r2_object_key:string|null;content_type:string|null;text_content:string|null;source_url:string|null;ordinal:number;received_at:string;image_set_id:string|null;image_set_index:number|null;image_set_total:number|null;webhook_batch_id:string|null;append_race_resolved:number;}
const mapSubmission=(r:SubmissionRow):AgentSubmission=>({id:r.id,source:r.source,conversationKey:r.conversation_key,pushTarget:r.push_target,status:r.status,firstReceivedAt:r.first_received_at,lastReceivedAt:r.last_received_at,closedAt:r.closed_at,workflowInstanceId:r.workflow_instance_id,resultEventId:r.result_event_id,resultAction:r.result_action,errorCode:r.error_code,errorMessage:r.error_message,imageSetId:r.image_set_id,expectedImageCount:r.expected_image_count,groupingStrategy:r.grouping_strategy,doneRequestedAt:r.done_requested_at,doneSettleUntil:r.done_settle_until,closureReason:r.closure_reason,appendRaceCount:Number(r.append_race_count??0),webhookEventCount:Number(r.webhook_event_count??0),imageEventCount:Number(r.image_event_count??0),createdAt:r.created_at,updatedAt:r.updated_at});
const mapItem=(r:ItemRow):AgentSubmissionItem=>({id:r.id,submissionId:r.submission_id,sourceMessageId:r.source_message_id,webhookEventId:r.webhook_event_id,itemType:r.item_type,assetId:r.asset_id,intakeId:r.intake_id,r2ObjectKey:r.r2_object_key,contentType:r.content_type,textContent:r.text_content,sourceUrl:r.source_url,ordinal:r.ordinal,receivedAt:r.received_at,imageSetId:r.image_set_id,imageSetIndex:r.image_set_index,imageSetTotal:r.image_set_total,webhookBatchId:r.webhook_batch_id,appendRaceResolved:Boolean(r.append_race_resolved)});

function parseDiagnostic(value:string|null,fallback:unknown):unknown {
	if(value===null)return fallback;
	try{return sanitizeDiagnostic(JSON.parse(value));}catch{return fallback;}
}

function sanitizeDiagnostic(value:unknown):unknown {
	if(Array.isArray(value))return value.map(sanitizeDiagnostic);
	if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/(?:secret|token|password|authorization|r2.*key|base64|image[_-]?data)/i.test(key)).map(([key,item])=>[key,sanitizeDiagnostic(item)]));
	if(typeof value==='string'&&/^data:image\/.+;base64,/i.test(value))return '[redacted]';
	if(typeof value==='string')return sanitizeAdminUrl(value);
	return value;
}

export function sanitizeAdminUrl(value:string):string {
	try{
		const url=new URL(value);if(!['http:','https:'].includes(url.protocol))return value;
		if(url.username||url.password){url.username='';url.password='';}
		for(const key of [...url.searchParams.keys()])if(/(?:token|secret|password|authorization|credential|key)/i.test(key))url.searchParams.set(key,'[redacted]');
		return url.href;
	}catch{return value;}
}

export async function listAgentSubmissions(db:D1Database,options:AgentSubmissionListOptions={}):Promise<{submissions:AgentSubmissionListItem[];total:number;page:number;pageSize:number;sort:'newest'|'oldest'}>{
	const page=Math.max(1,Math.floor(options.page??1));
	const pageSize=Math.min(100,Math.max(1,Math.floor(options.pageSize??25)));
	const sort=options.sort==='oldest'?'oldest':'newest';
	const conditions:string[]=[];const bindings:unknown[]=[];
	if(options.status){conditions.push('s.status=?');bindings.push(options.status);}
	const search=options.search?.trim();
	if(search){const pattern=`%${search.replace(/[\\%_]/g,'\\$&')}%`;conditions.push("(s.id LIKE ? ESCAPE '\\' OR s.result_event_id LIKE ? ESCAPE '\\' OR e.title LIKE ? ESCAPE '\\')");bindings.push(pattern,pattern,pattern);}
	const where=conditions.length?`WHERE ${conditions.join(' AND ')}`:'';
	const countRow=await db.prepare(`SELECT COUNT(*) total FROM agent_submissions s LEFT JOIN events e ON e.id=s.result_event_id ${where}`).bind(...bindings).first<{total:number}>();
	interface ListRow extends SubmissionRow {item_count:number;image_count:number;text_count:number;url_count:number;result_event_title:string|null;result_event_slug:string|null;decision:string|null;confidence:number|null;}
	const rows=await db.prepare(`SELECT s.*,COUNT(i.id) item_count,SUM(CASE WHEN i.item_type='image' THEN 1 ELSE 0 END) image_count,SUM(CASE WHEN i.item_type='text' THEN 1 ELSE 0 END) text_count,SUM(CASE WHEN i.item_type='url' THEN 1 ELSE 0 END) url_count,e.title result_event_title,e.slug result_event_slug,json_extract(d.ai_result_json,'$.decision') decision,json_extract(d.ai_result_json,'$.confidence') confidence FROM agent_submissions s LEFT JOIN agent_submission_items i ON i.submission_id=s.id LEFT JOIN events e ON e.id=s.result_event_id LEFT JOIN agent_submission_diagnostics d ON d.submission_id=s.id ${where} GROUP BY s.id ORDER BY s.last_received_at ${sort==='oldest'?'ASC':'DESC'},s.id ${sort==='oldest'?'ASC':'DESC'} LIMIT ? OFFSET ?`).bind(...bindings,pageSize,(page-1)*pageSize).all<ListRow>();
	return{submissions:(rows.results??[]).map(row=>({...mapSubmission(row),itemCount:Number(row.item_count),imageCount:Number(row.image_count),textCount:Number(row.text_count),urlCount:Number(row.url_count),resultEventTitle:row.result_event_title,resultEventSlug:row.result_event_slug,decision:row.decision,confidence:typeof row.confidence==='number'?row.confidence:null})),total:Number(countRow?.total??0),page,pageSize,sort};
}

export async function getAgentSubmission(db:D1Database,id:string):Promise<AgentSubmission|null>{return readSubmission(db,id);}

export async function getSubmissionDiagnostics(db:D1Database,id:string):Promise<AgentSubmissionDiagnostics|null>{
	const row=await db.prepare('SELECT ai_result_json,validation_diagnostics_json,matching_diagnostics_json,uncertainty_reasons_json,url_diagnostics_json,updated_at FROM agent_submission_diagnostics WHERE submission_id=?').bind(id).first<{ai_result_json:string|null;validation_diagnostics_json:string|null;matching_diagnostics_json:string|null;uncertainty_reasons_json:string|null;url_diagnostics_json:string|null;updated_at:string}>();
	return row?{aiResult:parseDiagnostic(row.ai_result_json,null),validation:parseDiagnostic(row.validation_diagnostics_json,[]),matching:parseDiagnostic(row.matching_diagnostics_json,{}),uncertainties:parseDiagnostic(row.uncertainty_reasons_json,[]),urls:parseDiagnostic(row.url_diagnostics_json,[]),updatedAt:row.updated_at}:null;
}

export async function getSubmissionResult(db:D1Database,id:string):Promise<AgentSubmissionResult|null>{
	const row=await db.prepare('SELECT s.status,s.result_event_id,s.result_action,s.error_code,s.error_message,e.id event_id,e.title,e.slug,e.event_date,e.start_time,e.status event_status,e.venue,e.address,e.price_text,e.price_thb,e.booking_url,e.contact_text,e.contact_phone,e.contact_email,e.description,e.wines_json,e.menu_json,e.created_at event_created_at FROM agent_submissions s LEFT JOIN events e ON e.id=s.result_event_id WHERE s.id=?').bind(id).first<{status:AgentSubmissionStatus;result_event_id:string|null;result_action:string|null;error_code:string|null;error_message:string|null;event_id:string|null;title:string|null;slug:string|null;event_date:string|null;start_time:string|null;event_status:string|null;venue:string|null;address:string|null;price_text:string|null;price_thb:number|null;booking_url:string|null;contact_text:string|null;contact_phone:string|null;contact_email:string|null;description:string|null;wines_json:string|null;menu_json:string|null;event_created_at:string|null}>();
	if(!row)return null;
	const fallbackContact=[row.contact_phone,row.contact_email].filter(Boolean).join(' ')||null;
	return{publicationOutcome:{status:row.status,eventId:row.result_event_id,action:row.result_action,errorCode:row.error_code,errorMessage:row.error_message},event:row.event_id?{id:row.event_id,title:row.title,slug:row.slug,eventDate:row.event_date,startTime:row.start_time,status:row.event_status!,venue:row.venue,address:row.address,price:row.price_text??(row.price_thb===null?null:String(row.price_thb)),bookingUrl:row.booking_url,contact:row.contact_text??fallbackContact,description:row.description,wines:parseDiagnostic(row.wines_json,[]) as string[],menu:parseDiagnostic(row.menu_json,[]) as string[],createdAt:row.event_created_at!}:null};
}

export async function countSubmissionsByStatus(db:D1Database):Promise<Record<AgentSubmissionStatus,number>>{
	const counts:Record<AgentSubmissionStatus,number>={collecting:0,queued:0,processing:0,needs_review:0,published:0,failed:0};
	const rows=await db.prepare('SELECT status,COUNT(*) count FROM agent_submissions GROUP BY status').all<{status:AgentSubmissionStatus;count:number}>();
	for(const row of rows.results??[])if(row.status in counts)counts[row.status]=Number(row.count);
	return counts;
}

export async function readSubmission(db:D1Database,id:string):Promise<AgentSubmission|null>{const row=await db.prepare('SELECT * FROM agent_submissions WHERE id=?').bind(id).first<SubmissionRow>();return row?mapSubmission(row):null;}
export async function listSubmissionItems(db:D1Database,id:string):Promise<AgentSubmissionItem[]>{const rows=await db.prepare('SELECT * FROM agent_submission_items WHERE submission_id=? ORDER BY ordinal').bind(id).all<ItemRow>();return (rows.results??[]).map(mapItem).sort((left,right)=>left.imageSetId&&left.imageSetId===right.imageSetId&&typeof left.imageSetIndex==='number'&&typeof right.imageSetIndex==='number'?left.imageSetIndex-right.imageSetIndex:left.ordinal-right.ordinal);}
export async function findSubmissionForMessage(db:D1Database,messageId:string,webhookEventId?:string):Promise<AgentSubmission|null>{const row=await db.prepare('SELECT submission_id FROM agent_submission_items WHERE source_message_id=? OR (? IS NOT NULL AND webhook_event_id=?) LIMIT 1').bind(messageId,webhookEventId??null,webhookEventId??null).first<{submission_id:string}>();return row?readSubmission(db,row.submission_id):null;}

export async function appendSubmissionItem(db:D1Database,input:{conversationKey:string;pushTarget?:string;sourceMessageId:string;webhookEventId?:string;itemType:AgentSubmissionItemType;assetId?:string;intakeId?:string;r2ObjectKey?:string;contentType?:string;textContent?:string;sourceUrl?:string;receivedAt:string;windowSeconds:number;imageSetId?:string;imageSetIndex?:number;imageSetTotal?:number;webhookBatchId?:string;webhookEventCount?:number;imageEventCount?:number}):Promise<{submission:AgentSubmission;item:AgentSubmissionItem;duplicate:boolean;expiredSubmissionId:string|null;appendRaceResolved:boolean}>{
	const duplicate=await db.prepare('SELECT submission_id FROM agent_submission_items WHERE source_message_id=? OR (? IS NOT NULL AND webhook_event_id=?) LIMIT 1').bind(input.sourceMessageId,input.webhookEventId??null,input.webhookEventId??null).first<{submission_id:string}>();
	if(duplicate){const submission=await readSubmission(db,duplicate.submission_id);const item=await db.prepare('SELECT * FROM agent_submission_items WHERE source_message_id=? OR (? IS NOT NULL AND webhook_event_id=?) LIMIT 1').bind(input.sourceMessageId,input.webhookEventId??null,input.webhookEventId??null).first<ItemRow>();if(!submission||!item)throw new Error('Duplicate V2 item lost its submission.');return{submission,item:mapItem(item),duplicate:true,expiredSubmissionId:null,appendRaceResolved:false};}
	let active=await db.prepare("SELECT * FROM agent_submissions WHERE source='line_v2' AND conversation_key=? AND status='collecting' ORDER BY CASE WHEN image_set_id=? THEN 0 ELSE 1 END,last_received_at DESC LIMIT 1").bind(input.conversationKey,input.imageSetId??null).first<SubmissionRow>();
	let expiredSubmissionId:string|null=null;const cutoff=Date.parse(input.receivedAt)-input.windowSeconds*1000;
	if(active&&Date.parse(active.last_received_at)<cutoff){const now=input.receivedAt;const closed=await db.prepare("UPDATE agent_submissions SET status='queued',closed_at=?,closure_reason='inactivity_timeout',updated_at=? WHERE id=? AND status='collecting'").bind(now,now,active.id).run();if(closed.meta.changes){expiredSubmissionId=active.id;active=null;}else active=await db.prepare("SELECT * FROM agent_submissions WHERE source='line_v2' AND conversation_key=? AND status='collecting' LIMIT 1").bind(input.conversationKey).first<SubmissionRow>();}
	let creationRace=false;
	if(!active){const id=crypto.randomUUID();try{await db.prepare(`INSERT INTO agent_submissions(id,source,conversation_key,push_target,status,first_received_at,last_received_at,image_set_id,expected_image_count,grouping_strategy,created_at,updated_at) VALUES(?,'line_v2',?,?,'collecting',?,?,?,?,?,?,?)`).bind(id,input.conversationKey,input.pushTarget??null,input.receivedAt,input.receivedAt,input.imageSetId??null,input.imageSetTotal??null,input.imageSetId?'image_set':'grouping_window',input.receivedAt,input.receivedAt).run();}catch(error){active=await db.prepare("SELECT * FROM agent_submissions WHERE source='line_v2' AND conversation_key=? AND status='collecting' LIMIT 1").bind(input.conversationKey).first<SubmissionRow>();if(!active)throw error;creationRace=true;}active=active??await db.prepare('SELECT * FROM agent_submissions WHERE id=?').bind(id).first<SubmissionRow>();}
	if(!active)throw new Error('Unable to create V2 submission.');
	const itemId=crypto.randomUUID();
	try{await db.prepare(`INSERT INTO agent_submission_items(id,submission_id,source_message_id,webhook_event_id,item_type,asset_id,intake_id,r2_object_key,content_type,text_content,source_url,ordinal,received_at,created_at,image_set_id,image_set_index,image_set_total,webhook_batch_id,append_race_resolved) SELECT ?,?,?,?,?,?,?,?,?,?,?,COALESCE(MAX(ordinal),0)+1,?,?,?,?,?,?,? FROM agent_submission_items WHERE submission_id=?`).bind(itemId,active.id,input.sourceMessageId,input.webhookEventId??null,input.itemType,input.assetId??null,input.intakeId??null,input.r2ObjectKey??null,input.contentType??null,input.textContent??null,input.sourceUrl??null,input.receivedAt,input.receivedAt,input.imageSetId??null,input.imageSetIndex??null,input.imageSetTotal??null,input.webhookBatchId??null,creationRace?1:0,active.id).run();}
	catch(error){const raced=await db.prepare('SELECT * FROM agent_submission_items WHERE source_message_id=? OR (? IS NOT NULL AND webhook_event_id=?) LIMIT 1').bind(input.sourceMessageId,input.webhookEventId??null,input.webhookEventId??null).first<ItemRow>();if(!raced)throw error;const submission=await readSubmission(db,raced.submission_id);if(!submission)throw error;return{submission,item:mapItem(raced),duplicate:true,expiredSubmissionId,appendRaceResolved:true};}
	const groupingStrategy=input.imageSetId?'image_set':active.grouping_strategy??'active_submission';
	const batchItemCount=input.webhookBatchId?await db.prepare('SELECT COUNT(*) count FROM agent_submission_items WHERE submission_id=? AND webhook_batch_id=?').bind(active.id,input.webhookBatchId).first<{count:number}>():null;const firstItemInWebhook=!input.webhookBatchId||Number(batchItemCount?.count??0)===1;
	await db.prepare(`UPDATE agent_submissions SET last_received_at=?,push_target=COALESCE(push_target,?),image_set_id=COALESCE(image_set_id,?),expected_image_count=MAX(COALESCE(expected_image_count,0),COALESCE(?,0)),grouping_strategy=COALESCE(grouping_strategy,?),append_race_count=append_race_count+?,webhook_event_count=webhook_event_count+?,image_event_count=image_event_count+?,updated_at=? WHERE id=?`).bind(input.receivedAt,input.pushTarget??null,input.imageSetId??null,input.imageSetTotal??null,groupingStrategy,creationRace?1:0,firstItemInWebhook?(input.webhookEventCount??1):0,firstItemInWebhook?(input.imageEventCount??(input.itemType==='image'?1:0)):0,input.receivedAt,active.id).run();
	const counts=await db.prepare("SELECT COUNT(*) received FROM agent_submission_items WHERE submission_id=? AND item_type='image'").bind(active.id).first<{received:number}>();
	const refreshed=await readSubmission(db,active.id);if(!refreshed)throw new Error('V2 submission disappeared after append.');
	if(refreshed.doneRequestedAt&&refreshed.expectedImageCount!==null&&Number(counts?.received??0)>=refreshed.expectedImageCount)await db.prepare("UPDATE agent_submissions SET status='queued',closed_at=?,closure_reason='done_all_expected_images',updated_at=? WHERE id=? AND status='collecting'").bind(input.receivedAt,input.receivedAt,active.id).run();
	const submission=(await readSubmission(db,active.id))!;const item=(await db.prepare('SELECT * FROM agent_submission_items WHERE id=?').bind(itemId).first<ItemRow>())!;return{submission,item:mapItem(item),duplicate:false,expiredSubmissionId,appendRaceResolved:creationRace};
}

export async function closeActiveSubmission(db:D1Database,conversationKey:string,receivedAt:string):Promise<AgentSubmission|null>{const active=await db.prepare("SELECT id FROM agent_submissions WHERE source='line_v2' AND conversation_key=? AND status='collecting' LIMIT 1").bind(conversationKey).first<{id:string}>();if(!active)return null;await db.prepare("UPDATE agent_submissions SET status='queued',closed_at=?,last_received_at=?,updated_at=? WHERE id=? AND status='collecting'").bind(receivedAt,receivedAt,receivedAt,active.id).run();return readSubmission(db,active.id);}
export async function closeSubmissionForDone(db:D1Database,input:{conversationKey:string;sourceMessageId:string;webhookEventId?:string;receivedAt:string;settlementSeconds:number;closedAcknowledgement:string;emptyAcknowledgement:string}):Promise<{submission:AgentSubmission|null;duplicate:boolean;acknowledgement:string}>{const eventId=input.webhookEventId??input.sourceMessageId;const receipt=await db.prepare('SELECT submission_id,acknowledgement_text FROM agent_v2_webhook_receipts WHERE source_message_id=? OR webhook_event_id=? LIMIT 1').bind(input.sourceMessageId,eventId).first<{submission_id:string|null;acknowledgement_text:string}>();if(receipt)return{submission:receipt.submission_id?await readSubmission(db,receipt.submission_id):null,duplicate:true,acknowledgement:receipt.acknowledgement_text};const active=await db.prepare("SELECT id,expected_image_count FROM agent_submissions WHERE source='line_v2' AND conversation_key=? AND status='collecting' LIMIT 1").bind(input.conversationKey).first<{id:string;expected_image_count:number|null}>();const acknowledgement=active?input.closedAcknowledgement:input.emptyAcknowledgement;try{if(active){const count=await db.prepare("SELECT COUNT(*) count FROM agent_submission_items WHERE submission_id=? AND item_type='image'").bind(active.id).first<{count:number}>();const complete=active.expected_image_count===null||Number(count?.count??0)>=active.expected_image_count;const settleUntil=new Date(Date.parse(input.receivedAt)+input.settlementSeconds*1000).toISOString();await db.batch([db.prepare('INSERT INTO agent_v2_webhook_receipts(webhook_event_id,source_message_id,submission_id,acknowledgement_text,created_at) VALUES(?,?,?,?,?)').bind(eventId,input.sourceMessageId,active.id,acknowledgement,input.receivedAt),complete?db.prepare("UPDATE agent_submissions SET status='queued',closed_at=?,done_requested_at=?,closure_reason='done_complete',updated_at=? WHERE id=? AND status='collecting'").bind(input.receivedAt,input.receivedAt,input.receivedAt,active.id):db.prepare("UPDATE agent_submissions SET done_requested_at=?,done_settle_until=?,closure_reason='done_settling',updated_at=? WHERE id=? AND status='collecting'").bind(input.receivedAt,settleUntil,input.receivedAt,active.id)]);}else await db.prepare('INSERT INTO agent_v2_webhook_receipts(webhook_event_id,source_message_id,submission_id,acknowledgement_text,created_at) VALUES(?,?,NULL,?,?)').bind(eventId,input.sourceMessageId,acknowledgement,input.receivedAt).run();}catch(error){const raced=await db.prepare('SELECT submission_id,acknowledgement_text FROM agent_v2_webhook_receipts WHERE source_message_id=? OR webhook_event_id=? LIMIT 1').bind(input.sourceMessageId,eventId).first<{submission_id:string|null;acknowledgement_text:string}>();if(!raced)throw error;return{submission:raced.submission_id?await readSubmission(db,raced.submission_id):null,duplicate:true,acknowledgement:raced.acknowledgement_text};}return{submission:active?await readSubmission(db,active.id):null,duplicate:false,acknowledgement};}

export async function getSubmissionIntakeDiagnostics(db:D1Database,id:string):Promise<AgentSubmissionIntakeDiagnostics|null>{const submission=await readSubmission(db,id);if(!submission)return null;const rows=await db.prepare("SELECT image_set_index,webhook_batch_id FROM agent_submission_items WHERE submission_id=? AND item_type='image' ORDER BY image_set_index,ordinal").bind(id).all<{image_set_index:number|null;webhook_batch_id:string|null}>();const indexes=[...new Set((rows.results??[]).map(row=>row.image_set_index).filter((value):value is number=>value!==null))].sort((a,b)=>a-b);const expected=submission.expectedImageCount;const missing=expected===null?[]:Array.from({length:expected},(_,index)=>index+1).filter(index=>!indexes.includes(index));const posts=new Set((rows.results??[]).map(row=>row.webhook_batch_id).filter(Boolean)).size;return{webhookEventCount:submission.webhookEventCount,imageEventCount:submission.imageEventCount,imageSetId:submission.imageSetId,expectedImageCount:expected,receivedImageCount:rows.results.length,receivedIndexes:indexes,missingIndexes:missing,webhookPostCount:posts,deliveryMode:posts===0?'unknown':posts===1?'one_post':'multiple_posts',groupingStrategy:submission.groupingStrategy,appendRaceCount:submission.appendRaceCount,finalImageCount:rows.results.length,closureReason:submission.closureReason};}
export async function setWorkflowInstance(db:D1Database,id:string,instanceId:string):Promise<void>{await db.prepare('UPDATE agent_submissions SET workflow_instance_id=COALESCE(workflow_instance_id,?),updated_at=? WHERE id=?').bind(instanceId,new Date().toISOString(),id).run();}
export async function setSubmissionStatus(db:D1Database,id:string,status:AgentSubmissionStatus,fields:{eventId?:string;action?:string;errorCode?:string;errorMessage?:string}={}):Promise<void>{const now=new Date().toISOString();await db.prepare('UPDATE agent_submissions SET status=?,result_event_id=COALESCE(?,result_event_id),result_action=COALESCE(?,result_action),error_code=?,error_message=?,updated_at=? WHERE id=?').bind(status,fields.eventId??null,fields.action??null,fields.errorCode??null,fields.errorMessage??null,now,id).run();}
export async function saveSubmissionDiagnostics(db:D1Database,id:string,input:{aiResult?:unknown;validation?:unknown;matching?:unknown;uncertainties?:unknown;urls?:unknown;rawAiR2Key?:string}):Promise<void>{await db.prepare(`INSERT INTO agent_submission_diagnostics(submission_id,ai_result_json,validation_diagnostics_json,matching_diagnostics_json,uncertainty_reasons_json,url_diagnostics_json,raw_ai_r2_key,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(submission_id) DO UPDATE SET ai_result_json=excluded.ai_result_json,validation_diagnostics_json=excluded.validation_diagnostics_json,matching_diagnostics_json=excluded.matching_diagnostics_json,uncertainty_reasons_json=excluded.uncertainty_reasons_json,url_diagnostics_json=excluded.url_diagnostics_json,raw_ai_r2_key=excluded.raw_ai_r2_key,updated_at=excluded.updated_at`).bind(id,input.aiResult===undefined?null:JSON.stringify(input.aiResult),JSON.stringify(input.validation??[]),JSON.stringify(input.matching??{}),JSON.stringify(input.uncertainties??[]),JSON.stringify(input.urls??[]),input.rawAiR2Key??null,new Date().toISOString()).run();}
