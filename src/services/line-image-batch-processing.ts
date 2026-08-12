import { getLineMessageBatchWindowSeconds, getOptionalAiEventResolutionOptions } from '../config';
import type { WorkerEnv } from '../types/env';
import { extractBatchEvents, type BatchAssetContext } from './batch-event-extraction';
import { recoverBatchEventsWithSingleAssetFallback } from './batch-event-fallback';
import { fuseEventCandidates } from './candidate-fusion';
import { recoverDeterministicEventFields } from './deterministic-event-parser';
import { attributeContributingAssets } from './deterministic-asset-attribution';
import { normalizeUtf8Text, normalizeWineEvent } from './event-normalizer';
import { getStoredCanonicalEvent, saveWineEvent, type EventSourceAssetInput } from './event-repository';
import { validatePublishableEvent } from './event-publication-guard';
import { markLineTextContextLinked } from './line-text-context';
import { claimBatchEventShell, claimClosedBatch, claimPendingAssetContinuation, claimReadyBatch, completeBatch, failBatch, getBatch, getBatchAssetCounts, listBatchAssets, listBatchTexts, listBatchWebSources, markBatchEventShellCreated, markBatchForReconciliation, markBatchNotificationSent, markContinuationEnqueueFailed, MAX_PENDING_ASSET_CONTINUATIONS, retryFailedBatch } from './line-image-batch-repository';
import { pushToLine } from './line';
import { extractAndStoreOcr } from './ocr';
import { parseEventDateEvidenceFromText, parseEventDateFromText } from './date-parser';
import { recordAssetEnrichment } from './event-enrichment-repository';

export interface BatchProcessingMessage { type:'process_batch'; batchId:string; expectedLastReceivedAt:string; closedProcessingToken?:string; continuationAttempt?:number; outboxId?:string; idempotencyKey?:string }

function uniqueJsonValues(values:unknown[],represented:Set<string>):unknown[]{const seen=new Set<string>();const result:unknown[]=[];for(const value of values){if(!value||typeof value!=='object')continue;const compact=Object.fromEntries(Object.entries(value as Record<string,unknown>).filter(([,item])=>typeof item!=='string'||!represented.has(item.trim())));const serialized=JSON.stringify(compact);if(!serialized||serialized==='{}'||seen.has(serialized))continue;seen.add(serialized);if(serialized.length<=2_500)result.push(compact);if(JSON.stringify(result).length>=2_500)break;}return result;}

function buildWebPagePromptSource(web:{finalUrl:string|null;normalizedUrl:string;canonicalUrl:string|null;title:string|null;description:string|null;mainImageUrl:string|null;openGraph:Record<string,string>;jsonLd:unknown[];extractedText:string|null},deterministicDate:string|null):{text:string;reduced:boolean}{
	const represented=new Set([web.title,web.description,web.canonicalUrl,web.finalUrl??web.normalizedUrl,web.mainImageUrl].filter((value):value is string=>Boolean(value)).map((value)=>value.trim()));const jsonLd=uniqueJsonValues(web.jsonLd,represented);const openGraph=Object.fromEntries(Object.entries(web.openGraph).filter(([,value])=>!represented.has(value.trim())));const readable=web.extractedText?.split('\n').filter((line)=>!represented.has(line.trim())).join('\n').trim()||null;const sections=[`PAGE URL: ${web.finalUrl??web.normalizedUrl}`,web.canonicalUrl&&`CANONICAL URL: ${web.canonicalUrl}`,web.title&&`TITLE: ${web.title}`,web.description&&`META DESCRIPTION: ${web.description}`,web.mainImageUrl&&`MAIN IMAGE URL: ${web.mainImageUrl}`,Object.keys(openGraph).length&&`OPEN GRAPH (NON-DUPLICATE FIELDS):\n${JSON.stringify(openGraph)}`,jsonLd.length&&`JSON-LD (NON-DUPLICATE FIELDS):\n${JSON.stringify(jsonLd)}`,deterministicDate&&`DETERMINISTIC EVENT DATE HINT: ${deterministicDate}`,readable&&`EVENT-FOCUSED READABLE TEXT:\n${readable}`].filter(Boolean) as string[];
	const seen=new Set<string>();const text=sections.filter((section)=>{const key=section.trim().toLocaleLowerCase('en-US');if(seen.has(key))return false;seen.add(key);return true;}).join('\n\n');
	return{text:text.slice(0,8_000),reduced:text.length>8_000||jsonLd.length<web.jsonLd.length};
}

function resolveBatchCandidateDates(analysis:Awaited<ReturnType<typeof extractBatchEvents>>,contexts:BatchAssetContext[]):{analysis:Awaited<ReturnType<typeof extractBatchEvents>>;dateNeedsReview:boolean}{
	let dateNeedsReview=false;
	const events=analysis.events.map((event)=>{
		const assigned=new Set(event.assetAssignments.map((assignment)=>assignment.assetId));const relevant=contexts.filter((context)=>assigned.size===0||assigned.has(context.assetId));
		const evidence=relevant.map((context)=>parseEventDateEvidenceFromText(`${context.lineText??''}\n${context.ocrText}`,new Date(context.receivedAt))).filter((item):item is NonNullable<typeof item>=>Boolean(item));
		const explicit=evidence.filter((item)=>item.explicitYear);const authoritative=explicit.length?explicit:evidence;const dates=[...new Set(authoritative.map((item)=>item.date))];
		if(dates.length>1){dateNeedsReview=true;return{...event,date:null};}
		if(dates.length===1){const date=dates[0];const reference=relevant[0]?new Date(relevant[0].receivedAt):new Date();const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(reference);if(explicit.length&&date<today)dateNeedsReview=true;return{...event,date};}
		const reference=relevant[0]?new Date(relevant[0].receivedAt):new Date();const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(reference);return event.date&&event.date<today?{...event,date:null}:event;
	});
	return{analysis:{...analysis,events,ambiguous:analysis.ambiguous||dateNeedsReview},dateNeedsReview};
}

export async function processImageBatch(message:BatchProcessingMessage,env:WorkerEnv):Promise<void> {
	const current=await getBatch(env.DB,message.batchId);
	if(!current||(!['collecting','failed'].includes(current.status)&&!(message.closedProcessingToken&&current.status==='processing'))) return;
	const windowSeconds=getLineMessageBatchWindowSeconds(env);
	const readyBefore=new Date(Date.now()-windowSeconds*1000).toISOString();
	const claimed=message.closedProcessingToken&&current.status==='processing'?await claimClosedBatch(env.DB,message.batchId,message.closedProcessingToken,message.continuationAttempt):current.status==='failed'?await retryFailedBatch(env.DB,message.batchId):await claimReadyBatch(env.DB,message.batchId,message.expectedLastReceivedAt,readyBefore);
	if(!claimed) {
		console.log({event:'batch_claim_conflict',batchId:message.batchId});
		return;
	}
	console.log({event:'batch_claimed',batchId:claimed.id,status:claimed.status});
	console.log({event:'enrichment_started',batchId:claimed.id,attemptState:claimed.status});
	try {
	const counts=await getBatchAssetCounts(env.DB,claimed.id);
	if(counts.pendingAssetCount>0){
		console.log({event:'line_batch_pending_assets_decision',conversationKey:claimed.conversationKey,batchId:claimed.id,assetCount:counts.assetCount,pendingAssetCount:counts.pendingAssetCount,assetStatus:'waiting'});
		const continuation=await claimPendingAssetContinuation(env.DB,claimed.id,claimed.processingAt!);
		const diagnostic={batchId:claimed.id,currentCount:continuation.count,maximumCount:continuation.maximumCount,firstWait:continuation.firstWaitAt,deadline:continuation.deadlineAt,nextDelay:continuation.nextDelaySeconds,resultingState:continuation.resultingState,assetCount:continuation.assetCount,pendingAssetCount:continuation.pendingAssetCount};
		if(continuation.invalidTimestampFields.length)console.warn({event:'invalid_batch_timestamp',...diagnostic,fields:continuation.invalidTimestampFields});
		if(continuation.outcome==='schedule'){
			console.log({event:'pending_asset_wait_claimed',...diagnostic});
			try{
				await env.IMAGE_PROCESSING_QUEUE.send({type:'process_batch',batchId:claimed.id,expectedLastReceivedAt:claimed.lastReceivedAt,closedProcessingToken:continuation.continuationToken!,continuationAttempt:continuation.count} satisfies BatchProcessingMessage,{delaySeconds:continuation.nextDelaySeconds!});
				console.log({event:'pending_asset_continuation_scheduled',...diagnostic});
			}catch(error){
				const reconciled=await markContinuationEnqueueFailed(env.DB,claimed.id,continuation.continuationToken!,error);
				console.error({event:'continuation_enqueue_failed',...diagnostic,resultingState:reconciled?'enqueue_failed':'claim_changed',error:error instanceof Error?error.message:String(error)});
				if(reconciled)console.error({event:'reconciliation_required',...diagnostic,resultingState:'enqueue_failed'});
			}
			return;
		}
		if(continuation.outcome==='asset_ready'){console.log({event:'pending_asset_missing',...diagnostic,resultingState:'asset_ready'});}
		else if(continuation.outcome==='limit_reached'){console.error({event:'pending_asset_limit_reached',...diagnostic});console.error({event:'reconciliation_required',...diagnostic});return;}
		else if(continuation.outcome==='deadline_reached'){console.error({event:'pending_asset_deadline_reached',...diagnostic});console.error({event:'reconciliation_required',...diagnostic});return;}
		else if(continuation.outcome==='already_claimed'){console.log({event:'pending_asset_claim_conflict',...diagnostic});return;}
		else {console.error({event:'reconciliation_required',...diagnostic,outcome:continuation.outcome});return;}
	}
	const allAssets=await listBatchAssets(env.DB,claimed.id);
	const assets=allAssets.filter((asset)=>asset.status==='completed');
	const texts=await listBatchTexts(env.DB,claimed.id);
	const webSources=await listBatchWebSources(env.DB,claimed.id);
	if(allAssets.length===0&&texts.length===0&&webSources.length===0){
		const reconciled=await markBatchForReconciliation(env.DB,claimed.id,claimed.processingAt,'batch has no assets, text, or web sources','no_assets');
		console.error({event:'batch_has_no_assets',batchId:claimed.id,currentCount:claimed.pendingAssetWaitCount??0,maximumCount:MAX_PENDING_ASSET_CONTINUATIONS,firstWait:claimed.firstPendingAssetWaitAt??null,deadline:claimed.pendingAssetWaitDeadlineAt??null,nextDelay:null,resultingState:reconciled?'no_assets':'claim_changed'});
		if(reconciled)console.error({event:'reconciliation_required',batchId:claimed.id,resultingState:'no_assets'});
		return;
	}
	console.log({event:'line_batch_processing_snapshot',conversationKey:claimed.conversationKey,batchId:claimed.id,action:'process',assetCount:allAssets.length,pendingAssetCount:0,failedAssetCount:counts.failedAssetCount,completedAssetCount:assets.length,textMessageCount:texts.length,webSourceCount:webSources.length,expiresAt:claimed.expiresAt});
	const contexts:BatchAssetContext[]=[];
	const imageContexts:BatchAssetContext[]=[];
	const attributableContexts:BatchAssetContext[]=[];
	const sourceAssets=new Map<string,EventSourceAssetInput>();
	const webPageDates=new Set<string>();
	const combinedText=texts.map((text,index)=>`LINE TEXT ${index+1}\nmessageId: ${text.messageId}\nreceivedAt: ${text.receivedAt}\n${text.text}`).join('\n\n---\n\n');
	for(const [assetIndex,asset] of assets.entries()) {
		try { await recordAssetEnrichment(env.DB,{assetId:asset.assetId,status:'processing',extractionStatus:'processing',incrementAttempt:true}); }
		catch(error){console.error({event:'line_enrichment_state_write_failed',assetId:asset.assetId,stage:'extraction_started',error:error instanceof Error?error.message:String(error)});}
		const object=await env.EVENT_INTAKES.get(asset.r2ObjectKey);
		if(!object) throw new Error(`Missing R2 image ${asset.r2ObjectKey}`);
		const content=await object.arrayBuffer();
		const storedOcr=await env.EVENT_INTAKES.get(`intakes/${asset.intakeId}/assets/${asset.assetId}/ocr.json`);
		const ocr=storedOcr&&typeof storedOcr.json==='function'?await storedOcr.json<Awaited<ReturnType<typeof extractAndStoreOcr>>>():await extractAndStoreOcr(env.AI,env.EVENT_INTAKES,{intakeId:asset.intakeId,assetId:asset.assetId,contentType:asset.contentType,content});
		const storedQr=await env.EVENT_INTAKES.get(`intakes/${asset.intakeId}/assets/${asset.assetId}/qr.json`);
		const qr=storedQr&&typeof storedQr.json==='function'?await storedQr.json<{status:string;values?:string[]}>():null;
		const qrEvidence=qr?.status==='complete'&&Array.isArray(qr.values)&&qr.values.length?`\nQR DECODED VALUES:\n${qr.values.join('\n')}`:'';
		console.log({
			event: 'line_batch_asset_ocr_result',
			batchId: claimed.id,
			assetId: asset.assetId,
			ordinal: asset.ordinal,
			status: ocr.status,
			ocrTextLength: ocr.text.length,
			error: ocr.error ?? null,
			model: ocr.model,
		});
		const context={assetId:asset.assetId,intakeId:asset.intakeId,ordinal:asset.ordinal,receivedAt:asset.receivedAt,contentType:asset.contentType,ocrText:`${ocr.status==='completed'?ocr.text:''}${qrEvidence}`.trim(),lineText:null};
		contexts.push(context);imageContexts.push(context);attributableContexts.push(context);
		sourceAssets.set(asset.assetId,{intakeId:asset.intakeId,assetId:asset.assetId,sourceType:asset.sourceType??'line_image',sourceMessageId:asset.lineMessageId,isPublic:true,r2ObjectKey:asset.r2ObjectKey,contentType:asset.contentType});
	}
	for(const text of texts)sourceAssets.set(text.assetId,{intakeId:`line-text-${text.messageId}`,assetId:text.assetId,sourceType:'line_text',sourceMessageId:text.messageId,textContent:text.text,isPublic:false});
	for(const web of webSources){
		const parserEmpty=!web.title&&!web.description&&web.jsonLd.length===0&&!web.extractedText;
		if(parserEmpty){console.error({event:'line_web_source_parser_failure',batchId:claimed.id,assetId:web.assetId,errorCode:'parser_empty',errorMessage:'No title, description, JSON-LD, or readable text was extracted.'});continue;}
		const deterministicDate=parseEventDateFromText([web.description,web.extractedText].filter(Boolean).join('\n'),new Date(web.fetchedAt));
		if(deterministicDate)webPageDates.add(deterministicDate);
		const promptSource=buildWebPagePromptSource(web,deterministicDate);const webText=promptSource.text;
		console.log({event:'line_web_source_prompt_prepared',batchId:claimed.id,assetId:web.assetId,extractedTextLength:web.extractedText?.length??0,promptSize:webText.length,estimatedPromptTokens:Math.ceil(new TextEncoder().encode(webText).byteLength/4),truncationOccurred:promptSource.reduced,textReduced:promptSource.reduced});
		if(web.status==='completed'&&webText){const context={assetId:web.assetId,intakeId:`line-web-${web.messageId}`,ordinal:web.ordinal,receivedAt:web.receivedAt,contentType:'text/html',ocrText:webText,lineText:null};contexts.push(context);attributableContexts.push(context);}
		sourceAssets.set(web.assetId,{intakeId:`line-web-${web.messageId}`,assetId:web.assetId,sourceType:'web_page',sourceMessageId:web.messageId,textContent:webText,isPublic:false,contentType:'text/html'});
	}
	if(assets.length===0&&webSources.filter((source)=>source.status==='completed').length===0&&texts.length>0){const first=texts[0];contexts.push({assetId:first.assetId,intakeId:`line-text-${first.messageId}`,ordinal:first.ordinal,receivedAt:first.receivedAt,contentType:'text/plain',ocrText:'',lineText:combinedText});}
	else if(combinedText&&contexts.length>0)contexts[0].lineText=[contexts[0].lineText,combinedText].filter(Boolean).join('\n\n');
	if(contexts.length===0){console.error({event:'line_batch_processing_skipped',batchId:claimed.id,reason:'no useful extraction context',webSourceErrorCodes:webSources.map((source)=>source.errorCode)});if(!await completeBatch(env.DB,claimed.id,'needs_review',[]))return;if(claimed.pushTarget&&await markBatchNotificationSent(env.DB,claimed.id))try{await pushToLine(claimed.pushTarget,'The event page returned no usable content. Please try again later or send the event details as text or an image.',env.LINE_CHANNEL_ACCESS_TOKEN);}catch(error){console.error('LINE BATCH STATUS PUSH FAILED:',error);}return;}

	let analysis=await extractBatchEvents(env.AI,env.EVENT_INTAKES,claimed.id,contexts);
	const candidateNeedsTitleEnrichment=analysis.events.length===1&&!normalizeUtf8Text(analysis.events[0]?.title);
	const fallbackInvoked=analysis.diagnostics.fallbackRequired||analysis.events.length!==1||candidateNeedsTitleEnrichment;
	let fallbackRecovered=false;
	if(fallbackInvoked){
		const fallbackReason=analysis.diagnostics.fallbackReason??(candidateNeedsTitleEnrichment?'batch candidate had no usable title':`batch analysis returned ${analysis.events.length} candidates instead of exactly one`);
		console.warn({event:'line_batch_single_asset_fallback_invoked',batchId:claimed.id,reason:fallbackReason,model:analysis.diagnostics.model});
		const fallback=await recoverBatchEventsWithSingleAssetFallback(env.AI,env.EVENT_INTAKES,claimed.id,contexts);
		fallbackRecovered=fallback.events.length>0;
		if(fallbackRecovered){
			if(analysis.events.length===1&&fallback.events.length===1){
				const fusion=fuseEventCandidates(analysis.events[0],fallback.events[0]);
				for(const conflict of fusion.conflicts)console.warn({event:'candidate_conflict',batchId:claimed.id,field:conflict.field,preferredSource:conflict.preferredSource,alternateSource:conflict.alternateSource});
				analysis={...analysis,events:[fusion.event],unassignedAssets:[...new Set([...analysis.unassignedAssets,...fallback.unassignedAssets])],ambiguous:analysis.ambiguous||fallback.ambiguous};
			}else analysis={...analysis,events:fallback.events,unassignedAssets:fallback.unassignedAssets,ambiguous:fallback.ambiguous};
		}
	}
	if(webPageDates.size===1){
		const [webPageDate]=webPageDates;
		analysis={...analysis,events:analysis.events.map((candidate)=>candidate.date?candidate:{...candidate,date:webPageDate})};
		console.log({event:'line_batch_web_date_resolution',batchId:claimed.id,detectedDate:webPageDate,candidateDateBackfilled:analysis.events.some((candidate)=>candidate.date===webPageDate),source:'server_rendered_description_or_readable_text'});
	}else if(webPageDates.size>1)console.warn({event:'line_batch_web_date_resolution',batchId:claimed.id,detectedDates:[...webPageDates],candidateDateBackfilled:false,reason:'conflicting webpage dates'});
	const dateResolution=resolveBatchCandidateDates(analysis,contexts);
	analysis=dateResolution.analysis;
	const deterministicEvidence=contexts.map((context)=>`${context.lineText??''}\n${context.ocrText}`).join('\n\n---\n\n');
	analysis={...analysis,events:analysis.events.map((candidate)=>{const recovered=recoverDeterministicEventFields(candidate,deterministicEvidence);for(const warning of recovered.warnings)console.warn({event:'parser_warning',batchId:claimed.id,field:warning.field,code:warning.code});return recovered.event;})};
	const dateEvidenceNeedsReview=dateResolution.dateNeedsReview;
	const multipleCandidates=analysis.events.length>1;
	if(multipleCandidates){console.warn({event:'line_message_batch_multiple_events_collapsed',batchId:claimed.id,candidateCount:analysis.events.length,reason:'one LINE message batch publishes exactly one event'});analysis={...analysis,events:[analysis.events[0]],unassignedAssets:assets.map((asset)=>asset.assetId),ambiguous:true};}
	const attribution=attributeContributingAssets(analysis.events,attributableContexts);
	analysis={...analysis,events:attribution.events,unassignedAssets:attribution.unassignedAssets,ambiguous:dateEvidenceNeedsReview||(attribution.unassignedAssets.length===0&&attribution.events.length>0?false:analysis.ambiguous)};
	for(const contribution of attribution.contributions) console.log({event:'line_batch_deterministic_asset_attribution',batchId:claimed.id,...contribution});
	for(const contribution of attribution.contributions) console.log({event:'line_batch_asset_classification',batchId:claimed.id,assetId:contribution.assetId,ordinal:attributableContexts.find((asset)=>asset.assetId===contribution.assetId)?.ordinal??null,classification:contribution.assignedRole,isMain:contribution.assignedRole==='main',menuLike:contribution.menuLike,identityScore:contribution.identityScore,reason:contribution.exactReason});
	console.log({event:'line_batch_deterministic_asset_attribution_summary',batchId:claimed.id,assetAssignments:analysis.events.map((event,candidateIndex)=>({candidateIndex,assignments:event.assetAssignments})),unassignedAssets:analysis.unassignedAssets});
	console.log({event:'line_batch_fallback_status',batchId:claimed.id,fallbackInvoked,fallbackRecovered,fallbackReason:analysis.diagnostics.fallbackReason});
	console.log({
		event: 'line_batch_analysis_result',
		batchId: claimed.id,
		assetCount: assets.length,
		eventCount:analysis.events.length,unassignedAssetCount:analysis.unassignedAssets.length,ambiguous:analysis.ambiguous,
		model:analysis.diagnostics.model,parseSuccess:analysis.diagnostics.parseSuccess,schemaValidationSuccess:analysis.diagnostics.schemaValidationSuccess,
	});
	for (const asset of assets) {
		const assignments = analysis.events.flatMap((candidate, candidateIndex) =>
			candidate.assetAssignments
				.filter((assignment) => assignment.assetId === asset.assetId)
				.map((assignment) => ({
					candidateIndex,
					role: assignment.role,
					extractionResult: candidate,
					detectedTitle: candidate.title,
					detectedDate: candidate.date,
					detectedVenue: candidate.venue,
					detectedStartTime: candidate.startTime,
				})),
		);
		console.log({
			event: 'line_batch_asset_extraction_result',
			batchId: claimed.id,
			assetId: asset.assetId,
			ordinal: asset.ordinal,
			assigned: assignments.length > 0,
			assetRole: assignments[0]?.role ?? 'unassigned',
			detectedTitle: assignments[0]?.detectedTitle ?? null,
			detectedDate: assignments[0]?.detectedDate ?? null,
			detectedVenue: assignments[0]?.detectedVenue ?? null,
			detectedStartTime: assignments[0]?.detectedStartTime ?? null,
			extractionResultCount: assignments.length,
		});
	}
	const eventIds:string[]=[]; let extractionWarnings=fallbackInvoked||analysis.ambiguous;
	for(const [candidateIndex,candidate] of analysis.events.entries()) {
		const title=normalizeUtf8Text(candidate.title);
		const normalized=normalizeWineEvent({...candidate,isWineEvent:imageContexts.length>0?true:candidate.isWineEvent});
		const guard=validatePublishableEvent({title,bookingUrl:normalizeUtf8Text(candidate.bookingUrl),event:normalized});
		const mergedEventCandidate={title,bookingUrl:normalizeUtf8Text(candidate.bookingUrl),...normalized,assetAssignments:candidate.assetAssignments};
		console.log({
			event: 'line_batch_merged_event_candidate',
			batchId: claimed.id,
			candidateIndex,
			populatedFields:Object.entries(mergedEventCandidate).filter(([,value])=>value!==null&&value!==undefined&&(!Array.isArray(value)||value.length>0)).map(([field])=>field),
		});
		console.log({
			event: 'line_batch_publishability_evaluation',
			batchId: claimed.id,
			candidateIndex,
			publishable: guard.publishable,
			score: guard.score,
			detectedSignals: guard.reasons,
			missingRequiredFields: guard.missingRequiredFields,
			rejectionReasons: guard.rejectionReasons,
			exactReason: guard.exactReason,
		});
		await env.EVENT_INTAKES.put(`line-batches/${claimed.id}/candidates/${candidateIndex}/publication-guard.json`,JSON.stringify({mergedEventCandidate,evaluation:guard},null,2),{httpMetadata:{contentType:'application/json'}});
		if(guard.missingRequiredFields.length>0)extractionWarnings=true;
		const [assignedPrimary,...assignedRelated]=candidate.assetAssignments;
		const primaryAssignment=assignedPrimary??(assets[0]?{assetId:assets[0].assetId,role:'main' as const}:undefined);
		const relatedAssignments=assignedPrimary?assignedRelated:assets.slice(1).map((asset)=>({assetId:asset.assetId,role:'other' as const}));
		const primary=primaryAssignment?sourceAssets.get(primaryAssignment.assetId):texts[0]?sourceAssets.get(texts[0].assetId):undefined;
		if(!primary) { console.error({event:'line_batch_d1_write_skipped',batchId:claimed.id,candidateIndex,reason:'resolved event has no persisted primary source asset',primaryAssignment:primaryAssignment??null,knownSourceAssetIds:[...sourceAssets.keys()]}); continue; }
		const related:EventSourceAssetInput[]=[];
		for(const assignment of relatedAssignments){const asset=sourceAssets.get(assignment.assetId);if(asset)related.push({...asset,assetRole:assignment.role});}
		const linkedIds=new Set([primary.assetId,...related.map((asset)=>asset.assetId)]);
		for(const asset of sourceAssets.values()) if(!linkedIds.has(asset.assetId)){linkedIds.add(asset.assetId);related.push({...asset,assetRole:'other'});}
		const ownership=await claimBatchEventShell(env.DB,claimed.id,primary.assetId);
		if(!ownership){console.error({event:'reconciliation_required',batchId:claimed.id,assetId:primary.assetId,resultingState:'batch_terminal_before_event_enrichment'});continue;}
		console.log({event:ownership.shellCreatedAt?'event_shell_reused':'event_shell_created',batchId:claimed.id,eventId:ownership.eventId,anchorAssetId:ownership.anchorAssetId});
		console.log({event:'line_batch_d1_write_attempt',batchId:claimed.id,candidateIndex,operation:'create_or_update_event',primaryAssetId:primary.assetId,primaryAssetRole:primaryAssignment?.role??'main',relatedAssets:related.map((asset)=>({assetId:asset.assetId,assetRole:asset.assetRole??'other',sourceType:asset.sourceType})),candidate:{title,date:normalized.date,startTime:normalized.startTime,venue:normalized.venue,priceTHB:normalized.priceTHB}});
		let saved;
		try {
			saved=await saveWineEvent(env.DB,{...primary,eventId:ownership.eventId,assetRole:primaryAssignment?.role??'main',relatedAssets:related,title,event:normalized},getOptionalAiEventResolutionOptions(env));
			await markBatchEventShellCreated(env.DB,claimed.id,saved.id);
			console.log({event:'line_batch_d1_write_result',batchId:claimed.id,candidateIndex,success:true,eventId:saved.id,operation:saved.duplicate?'update':'create'});
		} catch(error) {
			console.error({event:'line_batch_d1_write_exception',batchId:claimed.id,candidateIndex,success:false,error:error instanceof Error?error.message:String(error)});
			throw error;
		}
			eventIds.push(saved.id);
		const persistedEvent=await getStoredCanonicalEvent(env.DB,saved.id);
		await env.EVENT_INTAKES.put(`line-batches/${claimed.id}/candidates/${candidateIndex}/persistence.json`,JSON.stringify({saved,persistedEvent,recordedAt:new Date().toISOString()},null,2),{httpMetadata:{contentType:'application/json'}});
		for (const assignment of candidate.assetAssignments) {
			try { await recordAssetEnrichment(env.DB,{assetId:assignment.assetId,status:extractionWarnings?'partial':'complete',extractionStatus:extractionWarnings?'partial':'complete',model:analysis.diagnostics.model,errorCode:extractionWarnings?(analysis.diagnostics.fallbackReason??'extraction_warning'):null}); }
			catch(error){console.error({event:'line_enrichment_state_write_failed',assetId:assignment.assetId,stage:'extraction_completed',error:error instanceof Error?error.message:String(error)});}
		}
		for(const asset of sourceAssets.values()) if(asset.sourceType==='line_text') await markLineTextContextLinked(env.DB,asset.sourceMessageId!,saved.id);
	}
	if(eventIds.length===0) for(const asset of assets){
		try { await recordAssetEnrichment(env.DB,{assetId:asset.assetId,status:'retryable',extractionStatus:'failed',model:analysis.diagnostics.model,errorCode:analysis.diagnostics.fallbackReason??'no_event_persisted'}); }
		catch(error){console.error({event:'line_enrichment_state_write_failed',assetId:asset.assetId,stage:'extraction_failed',error:error instanceof Error?error.message:String(error)});}
	}
	const status=eventIds.length===0||dateEvidenceNeedsReview?'needs_review':'completed';
	console.log({
		event: 'line_batch_completion_decision',
		batchId: claimed.id,
		status,
		assetCount: assets.length,
		textMessageCount:texts.length,
		extractedCandidateCount: analysis.events.length,
		publishedEventCount: eventIds.length,
		unassignedAssets: analysis.unassignedAssets,
		ambiguous: analysis.ambiguous,
		exactReason: eventIds.length===0
			? 'no event was persisted because no stored primary source asset was available'
			: dateEvidenceNeedsReview
				? 'event was published, but deterministic source date evidence requires review'
				: extractionWarnings
					? 'event was published with extraction warnings'
					: 'event was published with extracted metadata',
	});
	if(!await completeBatch(env.DB,claimed.id,status,eventIds)) return;
	console.log({event:extractionWarnings||status==='needs_review'?'enrichment_partial':'enrichment_completed',batchId:claimed.id,status,eventCount:eventIds.length});
	if(!claimed.pushTarget||!await markBatchNotificationSent(env.DB,claimed.id)) return;
	const countSummary=[assets.length?`${assets.length} image${assets.length===1?'':'s'}`:'',webSources.length?`${webSources.length} web page${webSources.length===1?'':'s'}`:'',texts.length?`${texts.length} text message${texts.length===1?'':'s'}`:''].filter(Boolean).join(', ').replace(/, ([^,]+)$/,' and $1');
	const summary=eventIds.length===0
		? `Processed ${countSummary}, but the stored flyer could not be linked to an event because of a technical persistence error.`
		: `Processed ${countSummary} and published 1 event.${extractionWarnings?' Some event details could not be extracted.':''}`;
	try{await pushToLine(claimed.pushTarget,summary,env.LINE_CHANNEL_ACCESS_TOKEN);console.log({event:'notification_sent',batchId:claimed.id,channel:'push'});}catch(error){console.error({event:'notification_failed',batchId:claimed.id,channel:'push',error:error instanceof Error?error.message:String(error)});}
	} catch(error) {
		await failBatch(env.DB,claimed.id,error);
		console.error({event:'enrichment_retryable_failed',batchId:claimed.id,error:error instanceof Error?error.message:String(error)});
		throw error;
	}
}
