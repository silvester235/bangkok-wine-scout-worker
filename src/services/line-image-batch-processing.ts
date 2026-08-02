import { getLineMessageBatchWindowSeconds, getOptionalAiEventResolutionOptions } from '../config';
import type { WorkerEnv } from '../types/env';
import { extractBatchEvents, type BatchAssetContext } from './batch-event-extraction';
import { recoverBatchEventsWithSingleAssetFallback } from './batch-event-fallback';
import { attributeContributingAssets } from './deterministic-asset-attribution';
import { normalizeUtf8Text, normalizeWineEvent } from './event-normalizer';
import { saveWineEvent, type EventSourceAssetInput } from './event-repository';
import { validatePublishableEvent } from './event-publication-guard';
import { markLineTextContextLinked } from './line-text-context';
import { claimClosedBatch, claimReadyBatch, completeBatch, failBatch, getBatch, listBatchAssets, listBatchTexts, listBatchWebSources, markBatchNotificationSent, retryFailedBatch } from './line-image-batch-repository';
import { pushToLine } from './line';
import { extractAndStoreOcr } from './ocr';

export interface BatchProcessingMessage { type:'process_batch'; batchId:string; expectedLastReceivedAt:string; closedProcessingToken?:string }

export async function processImageBatch(message:BatchProcessingMessage,env:WorkerEnv):Promise<void> {
	const current=await getBatch(env.DB,message.batchId);
	if(!current||(!['collecting','failed'].includes(current.status)&&!(message.closedProcessingToken&&current.status==='processing'))) return;
	const windowSeconds=getLineMessageBatchWindowSeconds(env);
	const readyBefore=new Date(Date.now()-windowSeconds*1000).toISOString();
	const claimed=message.closedProcessingToken&&current.status==='processing'?await claimClosedBatch(env.DB,message.batchId,message.closedProcessingToken):current.status==='failed'?await retryFailedBatch(env.DB,message.batchId):await claimReadyBatch(env.DB,message.batchId,message.expectedLastReceivedAt,readyBefore);
	if(!claimed) {
		const latest=await getBatch(env.DB,message.batchId);
		if(latest?.status==='collecting') {
			const remaining=Math.max(1,Math.ceil((Date.parse(latest.lastReceivedAt)+windowSeconds*1000-Date.now())/1000));
			await env.IMAGE_PROCESSING_QUEUE.send({type:'process_batch',batchId:latest.id,expectedLastReceivedAt:latest.lastReceivedAt} satisfies BatchProcessingMessage,{delaySeconds:remaining});
		}
		return;
	}
	try {

	const assets=await listBatchAssets(env.DB,claimed.id);
	const texts=await listBatchTexts(env.DB,claimed.id);
	const webSources=await listBatchWebSources(env.DB,claimed.id);
	console.log({event:'line_batch_processing_snapshot',batchId:claimed.id,action:'process',assetCount:assets.length,textMessageCount:texts.length,webSourceCount:webSources.length,expiresAt:claimed.expiresAt});
	const contexts:BatchAssetContext[]=[];
	const imageContexts:BatchAssetContext[]=[];
	const attributableContexts:BatchAssetContext[]=[];
	const sourceAssets=new Map<string,EventSourceAssetInput>();
	const combinedText=texts.map((text,index)=>`LINE TEXT ${index+1}\nmessageId: ${text.messageId}\nreceivedAt: ${text.receivedAt}\n${text.text}`).join('\n\n---\n\n');
	for(const [assetIndex,asset] of assets.entries()) {
		const object=await env.EVENT_INTAKES.get(asset.r2ObjectKey);
		if(!object) throw new Error(`Missing R2 image ${asset.r2ObjectKey}`);
		const content=await object.arrayBuffer();
		const ocr=await extractAndStoreOcr(env.AI,env.EVENT_INTAKES,{intakeId:asset.intakeId,assetId:asset.assetId,contentType:asset.contentType,content});
		console.log({
			event: 'line_batch_asset_ocr_result',
			batchId: claimed.id,
			assetId: asset.assetId,
			ordinal: asset.ordinal,
			status: ocr.status,
			ocrText: ocr.text,
			error: ocr.error ?? null,
			model: ocr.model,
		});
		const context={assetId:asset.assetId,intakeId:asset.intakeId,ordinal:asset.ordinal,receivedAt:asset.receivedAt,contentType:asset.contentType,ocrText:ocr.status==='completed'?ocr.text:'',lineText:assetIndex===0?combinedText:null};
		contexts.push(context);imageContexts.push(context);attributableContexts.push(context);
		sourceAssets.set(asset.assetId,{intakeId:asset.intakeId,assetId:asset.assetId,sourceType:asset.sourceType??'line_image',sourceMessageId:asset.lineMessageId,isPublic:true,r2ObjectKey:asset.r2ObjectKey,contentType:asset.contentType});
	}
	for(const text of texts)sourceAssets.set(text.assetId,{intakeId:`line-text-${text.messageId}`,assetId:text.assetId,sourceType:'line_text',sourceMessageId:text.messageId,textContent:text.text,isPublic:false});
	for(const web of webSources){
		const structured=web.jsonLd.length?`\nJSON-LD:\n${JSON.stringify(web.jsonLd)}`:'';
		const webText=[`URL: ${web.finalUrl??web.normalizedUrl}`,web.title&&`TITLE: ${web.title}`,web.description&&`DESCRIPTION: ${web.description}`,web.extractedText,structured].filter(Boolean).join('\n');
		if(web.status==='completed'&&webText){const context={assetId:web.assetId,intakeId:`line-web-${web.messageId}`,ordinal:web.ordinal,receivedAt:web.receivedAt,contentType:'text/html',ocrText:webText,lineText:null};contexts.push(context);attributableContexts.push(context);}
		sourceAssets.set(web.assetId,{intakeId:`line-web-${web.messageId}`,assetId:web.assetId,sourceType:'web_page',sourceMessageId:web.messageId,textContent:webText,isPublic:false,contentType:'text/html'});
	}
	if(assets.length===0&&webSources.filter((source)=>source.status==='completed').length===0&&texts.length>0){const first=texts[0];contexts.push({assetId:first.assetId,intakeId:`line-text-${first.messageId}`,ordinal:first.ordinal,receivedAt:first.receivedAt,contentType:'text/plain',ocrText:'',lineText:combinedText});}
	else if(combinedText&&contexts.length>0)contexts[0].lineText=[contexts[0].lineText,combinedText].filter(Boolean).join('\n\n');

	let analysis=await extractBatchEvents(env.AI,env.EVENT_INTAKES,claimed.id,contexts);
	const fallbackInvoked=analysis.diagnostics.fallbackRequired;
	let fallbackRecovered=false;
	if(fallbackInvoked){
		console.warn({event:'line_batch_single_asset_fallback_invoked',batchId:claimed.id,reason:analysis.diagnostics.fallbackReason,model:analysis.diagnostics.model});
		const fallback=await recoverBatchEventsWithSingleAssetFallback(env.AI,env.EVENT_INTAKES,claimed.id,contexts);
		fallbackRecovered=fallback.events.length>0;
		analysis={...analysis,events:fallback.events,unassignedAssets:fallback.unassignedAssets,ambiguous:fallback.ambiguous};
	}
	const multipleCandidates=analysis.events.length>1;
	if(multipleCandidates){console.warn({event:'line_message_batch_multiple_events_rejected',batchId:claimed.id,candidateCount:analysis.events.length,reason:'one LINE message batch may publish at most one event'});analysis={...analysis,events:[],unassignedAssets:assets.map((asset)=>asset.assetId),ambiguous:true};}
	const attribution=attributeContributingAssets(analysis.events,attributableContexts);
	analysis={...analysis,events:attribution.events,unassignedAssets:attribution.unassignedAssets,ambiguous:attribution.unassignedAssets.length===0&&attribution.events.length>0?false:analysis.ambiguous};
	for(const contribution of attribution.contributions) console.log({event:'line_batch_deterministic_asset_attribution',batchId:claimed.id,...contribution});
	console.log({event:'line_batch_deterministic_asset_attribution_summary',batchId:claimed.id,assetAssignments:analysis.events.map((event,candidateIndex)=>({candidateIndex,assignments:event.assetAssignments})),unassignedAssets:analysis.unassignedAssets});
	console.log({event:'line_batch_fallback_status',batchId:claimed.id,fallbackInvoked,fallbackRecovered,fallbackReason:analysis.diagnostics.fallbackReason});
	console.log({
		event: 'line_batch_analysis_result',
		batchId: claimed.id,
		assetCount: assets.length,
		analysis,
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
			extractionResults: assignments,
		});
	}
	const eventIds:string[]=[]; const titles:string[]=[]; let rejectedCandidateCount=0;
	for(const [candidateIndex,candidate] of analysis.events.entries()) {
		const title=normalizeUtf8Text(candidate.title);
		const normalized=normalizeWineEvent(candidate);
		const guard=validatePublishableEvent({title,bookingUrl:normalizeUtf8Text(candidate.bookingUrl),event:normalized});
		const mergedEventCandidate={title,bookingUrl:normalizeUtf8Text(candidate.bookingUrl),...normalized,assetAssignments:candidate.assetAssignments};
		console.log({
			event: 'line_batch_merged_event_candidate',
			batchId: claimed.id,
			candidateIndex,
			mergedEventCandidate,
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
		if(!guard.publishable) { rejectedCandidateCount++; continue; }
		const [primaryAssignment,...relatedAssignments]=candidate.assetAssignments;
		const primary=primaryAssignment?sourceAssets.get(primaryAssignment.assetId):texts[0]?sourceAssets.get(texts[0].assetId):undefined; if(!primary) continue;
		const related:EventSourceAssetInput[]=[];
		for(const assignment of relatedAssignments){const asset=sourceAssets.get(assignment.assetId);if(asset)related.push({...asset,assetRole:assignment.role});}
		for(const asset of sourceAssets.values()) if(asset.sourceType==='line_text'&&asset.assetId!==primary.assetId) related.push(asset);
		const saved=await saveWineEvent(env.DB,{...primary,assetRole:primaryAssignment?.role??'main',relatedAssets:related,title,event:normalized},getOptionalAiEventResolutionOptions(env));
		eventIds.push(saved.id); titles.push(title??'Untitled event');
		for(const asset of sourceAssets.values()) if(asset.sourceType==='line_text') await markLineTextContextLinked(env.DB,asset.sourceMessageId!,saved.id);
	}
	const unresolved=eventIds.length<analysis.events.length||analysis.ambiguous;
	const status=eventIds.length===0||unresolved?'needs_review':'completed';
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
		exactReason: analysis.events.length === 0
			? fallbackInvoked
				? 'batch analysis failed or returned no usable candidates; single-asset fallback was invoked but recovered no strong event candidate'
				: 'no event candidates were extracted; the publication guard was not evaluated'
			: eventIds.length === 0
				? `all ${rejectedCandidateCount} extracted event candidate(s) failed deterministic publication or had no assigned assets`
				: unresolved
					? 'at least one event was published, but ambiguous or unassigned assets remain'
					: 'all extracted candidates passed publication and all assets were resolved',
	});
	if(!await completeBatch(env.DB,claimed.id,status,eventIds)) return;
	if(!claimed.pushTarget||!await markBatchNotificationSent(env.DB,claimed.id)) return;
	const countSummary=[assets.length?`${assets.length} image${assets.length===1?'':'s'}`:'',webSources.length?`${webSources.length} web page${webSources.length===1?'':'s'}`:'',texts.length?`${texts.length} text message${texts.length===1?'':'s'}`:''].filter(Boolean).join(', ').replace(/, ([^,]+)$/,' and $1');
	const summary=eventIds.length===0
		? analysis.events.length===0
			? `Processed ${countSummary}, but no event candidate could be extracted${fallbackInvoked?' after batch analysis and single-message fallback':''}.`
			: `Processed ${countSummary}, but ${rejectedCandidateCount} event candidate${rejectedCandidateCount===1?' was':'s were'} rejected because required event details were incomplete.`
		: `Processed ${countSummary} and published 1 event: ${titles[0]}.${fallbackRecovered?' Batch analysis failed, but single-message fallback recovered the event.':''}`;
	try{await pushToLine(claimed.pushTarget,summary,env.LINE_CHANNEL_ACCESS_TOKEN);}catch(error){console.error('LINE BATCH STATUS PUSH FAILED:',error);}
	} catch(error) {
		await failBatch(env.DB,claimed.id,error);
		throw error;
	}
}
