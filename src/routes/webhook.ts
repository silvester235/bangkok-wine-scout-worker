import {
	APP_NAME, getLineImageBatchWindowSeconds, getLineMessageBatchWindowSeconds, VERSION,
} from '../config';
import { isKnownCommand, routeCommand } from '../commands/router';
import { storeLineImageAsset } from '../services/event-intake';
import {
	downloadLineMessageContent,
	replyToLine,
} from '../services/line';
import {
	buildLineConversationKey,
	storePendingLineText,
} from '../services/line-text-context';
import { claimBatchAssetProcessing, claimBatchEventShell, claimBatchForDone, completeBatchAssetProcessing, expireActiveBatchForIncoming, failBatchAssetProcessing, finalizeUselessWebBatch, findPriorWebSourceOutcome, findUrlIngestionDelivery, getBatch, markAssetAttemptLimitForReconciliation, markBatchEventShellCreated, recordUrlIngestionDelivery, registerBatchAsset, registerBatchText, registerBatchWebSource } from '../services/line-image-batch-repository';
import { claimLineAcknowledgement, claimLineDelivery, hashConversationIdentity, lineDeliveryId, recordLineDeliveryOutcome } from '../services/line-delivery-repository';
import { dispatchDeliveryOutbox, ensureBatchDeliveryIntent, ensureImageDeliveryIntents } from '../services/line-delivery-outbox';
import { detectPrimaryWebUrl, fetchAndExtractWebPage, fetchWebPageImage } from '../services/web-page-ingestion-service';
import { extractAndStoreOcr } from '../services/ocr';
import { saveWineEvent } from '../services/event-repository';
import { initializeEventEnrichment, recordAssetEnrichment } from '../services/event-enrichment-repository';
import { inspectAndStoreQr } from '../services/qr-decoder';
import type { BatchProcessingMessage } from '../services/line-image-batch-processing';
import type { WorkerEnv } from '../types/env';
import type {
	LineImageMessageEvent,
	LineTextMessageEvent,
	LineWebhookPayload,
} from '../types/line';

export interface ImageProcessingMessage {
	type: 'process_image';
	batchId: string;
	assetId: string;
	sourceMessageId: string;
	messageId: string;
	lineUserId?: string;
	pushTarget?: string;
	conversationKey?: string;
	receivedAt: string;
	webhookEventId?: string;
	outboxId?: string;
	idempotencyKey?: string;
}

export async function ensureBatchProcessingScheduledAfterAssetCompletion(message:ImageProcessingMessage,env:WorkerEnv):Promise<void>{
	const batch=await getBatch(env.DB,message.batchId);
	if(!batch)return;
	if(batch.status==='processing'&&batch.processingAt){
		console.log({event:'pending_asset_ready_for_scheduled_continuation',conversationKey:message.conversationKey,batchId:batch.id,assetId:message.assetId,batchStatus:batch.status,currentCount:batch.pendingAssetWaitCount,maximumCount:3,firstWait:batch.firstPendingAssetWaitAt,deadline:batch.pendingAssetWaitDeadlineAt,nextDelay:null,resultingState:batch.continuationState});
	}
}

function isTextMessageEvent(event: unknown): event is LineTextMessageEvent {
	const candidate = event as LineTextMessageEvent;
	return candidate?.type === 'message' && candidate.message?.type === 'text' && typeof candidate.replyToken === 'string';
}

function isImageMessageEvent(event: unknown): event is LineImageMessageEvent {
	const candidate = event as LineImageMessageEvent;
	return candidate?.type === 'message' && candidate.message?.type === 'image' && typeof candidate.message.id === 'string' && typeof candidate.replyToken === 'string';
}

function isPdfFileMessageEvent(event: unknown): event is { type: 'message'; replyToken: string; message: { id: string; type: 'file'; fileName?: string } } {
	const candidate = event as { type?: unknown; replyToken?: unknown; message?: { id?: unknown; type?: unknown; fileName?: unknown } };
	return candidate?.type === 'message'
		&& candidate.message?.type === 'file'
		&& typeof candidate.message.id === 'string'
		&& typeof candidate.replyToken === 'string'
		&& typeof candidate.message.fileName === 'string'
		&& candidate.message.fileName.toLowerCase().endsWith('.pdf');
}

function getPushTarget(event: LineImageMessageEvent): string | undefined {
	return event.source?.userId ?? event.source?.groupId ?? event.source?.roomId;
}

export async function processImageMessage(message: ImageProcessingMessage, env: WorkerEnv): Promise<void> {
	const claim=await claimBatchAssetProcessing(env.DB,message.batchId,message.assetId);
	if(claim==='completed') { console.log({event:'line_asset_queue_duplicate_suppressed',conversationKey:message.conversationKey,batchId:message.batchId,assetId:message.assetId,sourceMessageId:message.sourceMessageId,assetStatus:claim,webhookEventId:message.webhookEventId??null}); return; }
	if(claim==='attempt_limit'){await markAssetAttemptLimitForReconciliation(env.DB,message.batchId,message.assetId);console.error({event:'reconciliation_required',batchId:message.batchId,assetId:message.assetId,resultingState:'asset_attempt_limit'});return;}
	if(claim==='busy') { console.log({event:'asset_claim_conflict',batchId:message.batchId,assetId:message.assetId,assetStatus:claim}); return; }
	if(claim!=='claimed'&&claim!=='claimed_terminal') throw new Error(`Registered asset ${message.assetId} was not found in batch ${message.batchId}.`);
	let terminalCompletion=claim==='claimed_terminal';
	console.log({event:'asset_claimed',batchId:message.batchId,assetId:message.assetId,assetStatus:'processing'});
	try {
	const downloaded = await downloadLineMessageContent(message.sourceMessageId, env.LINE_CHANNEL_ACCESS_TOKEN);
	const asset = await storeLineImageAsset(env.EVENT_INTAKES, {
		sourceType: 'line_image',
		sourceReference: message.sourceMessageId,
		lineUserId: message.lineUserId,
		receivedAt: message.receivedAt,
		contentType: downloaded.contentType,
		content: downloaded.content,
	});
	if(asset.assetId!==message.assetId)throw new Error(`Stored asset identity ${asset.assetId} did not match registered identity ${message.assetId}.`);
	console.log({event:'asset_preserved',batchId:message.batchId,assetId:asset.assetId,r2ObjectKey:asset.objectKey});
	const ownership=terminalCompletion?null:await claimBatchEventShell(env.DB,message.batchId,asset.assetId);
	if(!ownership)terminalCompletion=true;
	let shell:{id:string;duplicate:boolean}|null=null;
	if(ownership?.isAnchor)try { shell=await saveWineEvent(env.DB,{
		eventId:ownership.eventId,
		intakeId:asset.intakeId,assetId:asset.assetId,assetRole:'flyer',sourceType:'line_image',
		sourceMessageId:message.sourceMessageId,isPublic:true,r2ObjectKey:asset.objectKey,contentType:downloaded.contentType,
		title:'Wine Event',event:{date:null,startTime:null,priceTHB:null,venue:null,contactEmail:null,contactPhone:null,wines:[],wineRegions:[],isWineEvent:true,
			organizer:null,address:null,district:null,websiteUrl:null,bookingUrl:null,bookingInstructions:null,contactText:null,description:null,courseCount:null,
			priceText:null,currency:null,priceQualifier:null,endTime:null,timezone:null,wineProducers:[],partners:[],merchants:[],menu:[],notes:[],sourceContactInformation:[]},
	}); await markBatchEventShellCreated(env.DB,message.batchId,shell.id); }
	catch(error){await env.EVENT_INTAKES.put(`intakes/${asset.intakeId}/assets/${asset.assetId}/publication.json`,JSON.stringify({status:'retryable',stage:'minimal_shell',eventId:null,recordedAt:new Date().toISOString(),error:error instanceof Error?error.message:String(error)},null,2),{httpMetadata:{contentType:'application/json'}});throw error;}
	await env.EVENT_INTAKES.put(`intakes/${asset.intakeId}/assets/${asset.assetId}/publication.json`,JSON.stringify(ownership?{status:shell?'published':'preserved_pending_shell',stage:'minimal_shell',eventId:ownership.eventId,recordedAt:new Date().toISOString()}:{status:'preserved_for_reconciliation',stage:'late_asset_completion',eventId:(await getBatch(env.DB,message.batchId))?.minimalEventId??null,recordedAt:new Date().toISOString()},null,2),{httpMetadata:{contentType:'application/json'}});
	if(ownership)console.log({event:shell?(shell.duplicate?'event_shell_reused':'event_shell_created'):'event_shell_reused',batchId:message.batchId,assetId:asset.assetId,eventId:ownership.eventId,anchorAssetId:ownership.anchorAssetId,isAnchor:ownership.isAnchor});
	try { if(shell)await initializeEventEnrichment(env.DB,{assetId:asset.assetId,eventId:shell.id,intakeId:asset.intakeId}); }
	catch(error){console.error({event:'line_enrichment_state_write_failed',assetId:asset.assetId,stage:'initialize',error:error instanceof Error?error.message:String(error)});}
	const qr=await inspectAndStoreQr(env.EVENT_INTAKES,{intakeId:asset.intakeId,assetId:asset.assetId,contentType:downloaded.contentType,content:downloaded.content});
	const ocr=await extractAndStoreOcr(env.AI,env.EVENT_INTAKES,{intakeId:asset.intakeId,assetId:asset.assetId,contentType:downloaded.contentType,content:downloaded.content});
	try { await recordAssetEnrichment(env.DB,{assetId:asset.assetId,status:ocr.status==='completed'?'pending':'retryable',ocrStatus:ocr.status==='completed'?'complete':'failed',qrStatus:qr.status,errorCode:ocr.error??qr.error??null,model:ocr.model}); }
	catch(error){console.error({event:'line_enrichment_state_write_failed',assetId:asset.assetId,stage:'ocr_qr',error:error instanceof Error?error.message:String(error)});}
	if(ocr.status!=='completed')console.warn({event:'line_asset_ocr_enrichment_failed',conversationKey:message.conversationKey,batchId:message.batchId,assetId:message.assetId,sourceMessageId:message.sourceMessageId,assetStatus:'processing',webhookEventId:message.webhookEventId??null,error:ocr.error??'no text returned'});
	if(!await completeBatchAssetProcessing(env.DB,message.batchId,message.assetId,{intakeId:asset.intakeId,contentType:downloaded.contentType,r2ObjectKey:asset.objectKey}))throw new Error('Asset status changed before persistence completed.');
	console.log({event:'line_asset_existing_record_updated',conversationKey:message.conversationKey,batchId:message.batchId,assetId:message.assetId,sourceMessageId:message.sourceMessageId,assetStatus:'completed',webhookEventId:message.webhookEventId??null});
	if(terminalCompletion){const terminalBatch=await getBatch(env.DB,message.batchId);console.warn({event:'late_asset_completed',batchId:message.batchId,assetId:message.assetId,currentCount:terminalBatch?.pendingAssetWaitCount??0,maximumCount:3,firstWait:terminalBatch?.firstPendingAssetWaitAt??null,deadline:terminalBatch?.pendingAssetWaitDeadlineAt??null,nextDelay:null,resultingState:terminalBatch?.continuationState??terminalBatch?.status??'terminal'});}
	else await ensureBatchProcessingScheduledAfterAssetCompletion(message,env);
	}catch(error){await failBatchAssetProcessing(env.DB,message.batchId,message.assetId,error);console.error({event:'line_asset_processing_failed',conversationKey:message.conversationKey,batchId:message.batchId,assetId:message.assetId,sourceMessageId:message.sourceMessageId,assetStatus:'failed',webhookEventId:message.webhookEventId??null,error:error instanceof Error?error.message:String(error)});throw error;}
}

async function replyOnce(env:WorkerEnv,deliveryId:string,replyToken:string,text:string,batchId?:string|null):Promise<void>{
	await recordLineDeliveryOutcome(env.DB,deliveryId,'completed',batchId);
	if(!await claimLineAcknowledgement(env.DB,deliveryId)){console.log({event:'acknowledgement_suppressed',deliveryId,batchId:batchId??null});return;}
	console.log({event:'acknowledgement_claimed',deliveryId,batchId:batchId??null});
	try{await replyToLine(replyToken,text,env.LINE_CHANNEL_ACCESS_TOKEN);const now=new Date().toISOString();await env.DB.prepare(`UPDATE line_webhook_delivery_receipts SET acknowledgement_outcome='sent',acknowledgement_updated_at=?,updated_at=? WHERE webhook_event_id=?`).bind(now,now,deliveryId).run();console.log({event:'notification_sent',deliveryId,batchId:batchId??null,channel:'reply'});}
	catch(error){const now=new Date().toISOString();await env.DB.prepare(`UPDATE line_webhook_delivery_receipts SET acknowledgement_outcome='uncertain',acknowledgement_updated_at=?,updated_at=? WHERE webhook_event_id=?`).bind(now,now,deliveryId).run();console.error({event:'notification_failed',deliveryId,batchId:batchId??null,channel:'reply',error:error instanceof Error?error.message:String(error)});}
}

async function acknowledgeAndQueueImage(event: LineImageMessageEvent, env: WorkerEnv, deliveryId:string, defer?:(promise:Promise<unknown>)=>void): Promise<void> {
	const conversationKey=buildLineConversationKey(event.source)??undefined;
	const receivedAt=new Date(event.timestamp??Date.now()).toISOString();
	if(conversationKey){const expired=await expireActiveBatchForIncoming(env.DB,conversationKey,receivedAt);if(expired){console.log({event:'line_batch_lifecycle',lineUserId:event.source?.userId,webhookEventId:event.webhookEventId??event.message.id,batchId:expired.id,previousBatchStatus:'collecting',batchAge:Date.parse(receivedAt)-Date.parse(expired.createdAt),expiresAt:expired.expiresAt,expirationDecision:true,action:'close'});await env.IMAGE_PROCESSING_QUEUE.send({type:'process_batch',batchId:expired.id,expectedLastReceivedAt:expired.lastReceivedAt,closedProcessingToken:expired.processingAt!} satisfies BatchProcessingMessage);}}
	if(!conversationKey)throw new Error(`Cannot register LINE image ${event.message.id} without a conversation key.`);
	const assetId=`line-message-${event.message.id}`;const intakeId=`line-${event.message.id}`;const objectKey=`intakes/${intakeId}/assets/${assetId}/original`;
	const imageBatchWindowSeconds=getLineImageBatchWindowSeconds(env);
	const registered=await registerBatchAsset(env.DB,{assetId,intakeId,lineMessageId:event.message.id,webhookEventId:event.webhookEventId,contentType:'application/octet-stream',r2ObjectKey:objectKey,receivedAt,conversationKey,pushTarget:getPushTarget(event)},imageBatchWindowSeconds);
	console.log({event:'asset_registered',batchId:registered.batch.id,assetId,duplicate:registered.duplicate,status:'pending'});
	if(registered.action==='create')console.log({event:'batch_collection_started',batchId:registered.batch.id,status:registered.batch.status,expiresAt:registered.batch.expiresAt});
	console.log({event:registered.duplicate?'line_asset_duplicate_registration_suppressed':'line_asset_placeholder_inserted',conversationKey,batchId:registered.batch.id,assetId,sourceMessageId:event.message.id,assetStatus:'pending',assetCount:registered.assetCountAfterAppend??null,pendingAssetCount:null,webhookEventId:event.webhookEventId??null,action:registered.action??null});
	const imageJob:ImageProcessingMessage={
		type: 'process_image',batchId:registered.batch.id,assetId,sourceMessageId:event.message.id,
		messageId: event.message.id,
		receivedAt,
		webhookEventId:event.webhookEventId,
	};
	await ensureImageDeliveryIntents(env.DB,{receiptId:deliveryId,batchId:registered.batch.id,assetId,message:imageJob,batchExpectedLastReceivedAt:registered.batch.lastReceivedAt,batchDelaySeconds:imageBatchWindowSeconds,acknowledgementText:'Image received. Processing has started; related images or details sent now will be grouped with it.'});
	const dispatch=dispatchDeliveryOutbox(env,{receiptId:deliveryId,replyTokens:new Map([[deliveryId,event.replyToken]])});
	if(defer)defer(dispatch);else await dispatch;
}

async function dispatchReceipt(env:WorkerEnv,deliveryId:string,replyToken:string,defer?:(promise:Promise<unknown>)=>void):Promise<void>{
	const dispatch=dispatchDeliveryOutbox(env,{receiptId:deliveryId,replyTokens:new Map([[deliveryId,replyToken]])});
	if(defer)defer(dispatch);else await dispatch;
}

export async function processWebhookEvents(body: LineWebhookPayload, env: WorkerEnv, options:{defer?:(promise:Promise<unknown>)=>void}={}): Promise<void> {
	for (const event of body.events ?? []) {
		const record=event as Record<string,unknown>;const message=(record.message??{}) as Record<string,unknown>;
		const messageId=typeof message.id==='string'?message.id:crypto.randomUUID();const messageType=typeof message.type==='string'?message.type:typeof record.type==='string'?record.type:'unknown';
		const webhookEventId=typeof record.webhookEventId==='string'?record.webhookEventId:undefined;
		const source=(record.source??{}) as Parameters<typeof buildLineConversationKey>[0];const rawConversationId=buildLineConversationKey(source);
		const deliveryId=lineDeliveryId(webhookEventId,messageType,messageId);
		const delivery=await claimLineDelivery(env.DB,{deliveryId,messageId,messageType,conversationId:await hashConversationIdentity(rawConversationId)});
		if(!delivery.claimed){console.log({event:'webhook_duplicate',deliveryId,messageId,messageType,previousOutcome:delivery.previousOutcome});if(delivery.previousOutcome==='completed'||delivery.previousOutcome==='ignored'){console.log({event:'acknowledgement_suppressed',deliveryId,reason:'terminal_duplicate_delivery'});continue;}console.log({event:'delivery_stage_resumed',receiptId:deliveryId,batchId:null,assetId:null,stage:delivery.previousOutcome??'unknown',attempt:0,lease:null,outcome:'duplicate_recovery'});}
		console.log({event:'webhook_received',deliveryId,messageId,messageType});
		try{
		if (isImageMessageEvent(event)) await acknowledgeAndQueueImage(event, env,deliveryId,options.defer);
		else if (isPdfFileMessageEvent(event)) {
			await replyToLine(
				event.replyToken,
				'PDF files aren’t supported yet. Please send the flyer pages as images instead. You can send multiple images — Bangkok Wine Scout will process them together as one event.',
				env.LINE_CHANNEL_ACCESS_TOKEN,
			);
		}
		else if (isTextMessageEvent(event)) {
			const conversationKey = buildLineConversationKey(event.source);
			if (event.message.text.trim().toLowerCase() === '/done') {
				const now=new Date(event.timestamp??Date.now()).toISOString();
				const decision=conversationKey?await claimBatchForDone(env.DB,conversationKey,now):{outcome:'not_found'} as const;
				let queueAction='none';
				let duplicateSuppressionReason:string|null=null;
				if(decision.outcome==='claimed') {
					const token=decision.batch.processingAt!;
					await ensureBatchDeliveryIntent(env.DB,{receiptId:deliveryId,batchId:decision.batch.id,expectedLastReceivedAt:decision.batch.lastReceivedAt,closedProcessingToken:token,acknowledgementText:'Batch closed; enrichment is starting.'});
					queueAction='outbox_pending';
					await dispatchReceipt(env,deliveryId,event.replyToken,options.defer);
				}else if(decision.outcome==='already_processing'){
					duplicateSuppressionReason='batch_already_processing';
					if(decision.batch.processingAt?.startsWith('done:')){
						await ensureBatchDeliveryIntent(env.DB,{receiptId:deliveryId,batchId:decision.batch.id,expectedLastReceivedAt:decision.batch.lastReceivedAt,closedProcessingToken:decision.batch.processingAt,acknowledgementText:'The flyer is already published; enrichment is still processing.'});
						queueAction='outbox_pending';
						await dispatchReceipt(env,deliveryId,event.replyToken,options.defer);
					}else await replyOnce(env,deliveryId,event.replyToken,'The flyer is already published; enrichment is still processing.',decision.batch.id);
				}else if(decision.outcome==='already_completed'){
					duplicateSuppressionReason=`batch_status_${decision.batch.status}`;
					await replyOnce(env,deliveryId,event.replyToken,'This batch has already been processed and published.',decision.batch.id);
				}else await replyOnce(env,deliveryId,event.replyToken,'No batch is waiting for related messages.');
				const batch=decision.outcome==='not_found'?null:decision.batch;
				console.log({event:'line_batch_done_decision',conversationKey,webhookEventId:event.webhookEventId??event.message.id,batchId:batch?.id??null,previousStatus:decision.outcome==='claimed'?decision.previousStatus:batch?.status??null,currentStatus:batch?.status??null,expiresAt:batch?.expiresAt??null,doneTimestamp:now,expiredAtReceipt:batch?batch.expiresAt<=now:null,claimOutcome:decision.outcome,claimReason:decision.outcome==='claimed'?decision.claimReason:null,queueAction,duplicateSuppressionReason});
				continue;
			}
			if (isKnownCommand(event.message.text)) {
				await replyOnce(env,deliveryId,event.replyToken,routeCommand(event.message.text));
				continue;
			}

			if (event.message.text.trim() && conversationKey) {
				const receivedAt=new Date(event.timestamp ?? Date.now()).toISOString();
				const expired=await expireActiveBatchForIncoming(env.DB,conversationKey,receivedAt);
				if(expired)await env.IMAGE_PROCESSING_QUEUE.send({type:'process_batch',batchId:expired.id,expectedLastReceivedAt:expired.lastReceivedAt,closedProcessingToken:expired.processingAt!} satisfies BatchProcessingMessage);
				const detectedUrl=detectPrimaryWebUrl(event.message.text);
				if(detectedUrl){
					const urlDeliveryId=event.webhookEventId??event.message.id;const priorDelivery=await findUrlIngestionDelivery(env.DB,urlDeliveryId);
					if(priorDelivery){console.log({event:'line_web_source_ingestion',webhookEventId:urlDeliveryId,batchId:priorDelivery.batchId,normalizedUrl:priorDelivery.normalizedUrl,attemptNumber:0,retryPerformed:false,retryReason:null,firstStatus:null,secondStatus:null,firstResponseBytes:null,secondResponseBytes:null,firstParserStatus:null,secondParserStatus:null,finalErrorCode:priorDelivery.errorCode,reusedPriorSuccess:priorDelivery.status==='completed',ignoredPriorFailure:false,duplicate:true});await replyOnce(env,deliveryId,event.replyToken,priorDelivery.status==='completed'?'Event page received – waiting for related images or text.':`I couldn't read that event page. You can send the event details as text or an image instead.`,priorDelivery.batchId);continue;}
					const priorOutcome=await findPriorWebSourceOutcome(env.DB,detectedUrl.normalizedUrl);const ignoredPriorFailure=priorOutcome==='failed';
					const ingestion=await fetchAndExtractWebPage(detectedUrl.url,{timeoutMs:8_000,maxRedirects:5,maxHtmlBytes:1_500_000,maxExtractedTextChars:40_000,userAgent:'BangkokWineScoutBot/1.0 (+https://bangkokwinescout.com)'});
					console.log({
						event:'line_web_source_extracted',
						requestedUrl:ingestion.requestedUrl,
						finalUrl:ingestion.finalUrl,
						status:ingestion.status,
						title:ingestion.title,
						description:ingestion.description,
						openGraph:ingestion.openGraph,
						jsonLd:ingestion.jsonLd,
						extractedText:ingestion.extractedText,
						extractedTextLength:ingestion.extractedTextLength,
						originalReadableTextChars:ingestion.originalReadableTextChars,
						textReduced:ingestion.textReduced,
						truncationOccurred:ingestion.textReduced,
					});
					const batchWindowSeconds=getLineMessageBatchWindowSeconds(env);
					const registered=await registerBatchWebSource(env.DB,{messageId:event.message.id,webhookEventId:event.webhookEventId,receivedAt,conversationKey,pushTarget:getPushTarget(event as unknown as LineImageMessageEvent),...ingestion},batchWindowSeconds);
					await recordUrlIngestionDelivery(env.DB,{webhookEventId:urlDeliveryId,messageId:event.message.id,normalizedUrl:detectedUrl.normalizedUrl,batchId:registered.batch.id,status:ingestion.status,errorCode:ingestion.errorCode,receivedAt});
					await env.EVENT_INTAKES.put(`line-batches/${registered.batch.id}/web-sources/${encodeURIComponent(detectedUrl.normalizedUrl)}.json`,JSON.stringify(ingestion,null,2),{httpMetadata:{contentType:'application/json'}});
					if(!registered.duplicate&&ingestion.status==='completed'&&ingestion.mainImageUrl){
						const image=await fetchWebPageImage(ingestion.mainImageUrl,{timeoutMs:6_000,maxRedirects:3,maxBytes:8_000_000,userAgent:'BangkokWineScoutBot/1.0 (+https://bangkokwinescout.com)'});
						if(image){const reference=`${event.message.id}:web-main`;const asset=await storeLineImageAsset(env.EVENT_INTAKES,{sourceType:'web_image',sourceReference:reference,lineUserId:event.source?.userId,receivedAt,contentType:image.contentType,content:image.content});await registerBatchAsset(env.DB,{assetId:asset.assetId,intakeId:asset.intakeId,lineMessageId:reference,webhookEventId:`${event.webhookEventId??event.message.id}:web-main`,sourceType:'web_image',contentType:image.contentType,r2ObjectKey:asset.objectKey,receivedAt,conversationKey,pushTarget:getPushTarget(event as unknown as LineImageMessageEvent)},batchWindowSeconds);}
					}
					let contextRegistered=false;
					let scheduledBatch=registered.batch;
					if(detectedUrl.contextText){
						await storePendingLineText(env.DB,{messageId:`${event.message.id}:context`,conversationKey,text:detectedUrl.contextText,receivedAt});
						const textRegistration=await registerBatchText(env.DB,{messageId:`${event.message.id}:context`,webhookEventId:`${event.webhookEventId??event.message.id}:context`,text:detectedUrl.contextText,receivedAt,conversationKey,pushTarget:getPushTarget(event as unknown as LineImageMessageEvent)},batchWindowSeconds);
						contextRegistered=!textRegistration.duplicate;scheduledBatch=textRegistration.batch;
					}
					console.log({event:'line_web_source_ingestion',webhookEventId:urlDeliveryId,batchId:registered.batch.id,normalizedUrl:ingestion.normalizedUrl,status:ingestion.status,httpStatus:ingestion.httpStatus,errorCode:ingestion.errorCode,attemptNumber:ingestion.attemptNumber,retryPerformed:ingestion.retryPerformed,retryReason:ingestion.retryReason,firstStatus:ingestion.firstStatus,secondStatus:ingestion.secondStatus,firstResponseBytes:ingestion.firstResponseBytes,secondResponseBytes:ingestion.secondResponseBytes,firstParserStatus:ingestion.firstParserStatus,secondParserStatus:ingestion.secondParserStatus,finalErrorCode:ingestion.errorCode,reusedPriorSuccess:registered.duplicate&&ingestion.status==='completed',ignoredPriorFailure,duplicate:registered.duplicate});
					const finalizedUseless=ingestion.status!=='completed'&&!contextRegistered?await finalizeUselessWebBatch(env.DB,registered.batch.id):false;
					const acknowledgementText=ingestion.status==='completed'?'Event page received – waiting for related images or text.':`I couldn't read that event page (${ingestion.errorMessage??'unsupported page'}). You can send the event details as text or an image instead.`;
					if(!finalizedUseless&&((ingestion.status==='completed'&&!registered.duplicate)||contextRegistered)){
						await ensureBatchDeliveryIntent(env.DB,{receiptId:deliveryId,batchId:scheduledBatch.id,expectedLastReceivedAt:scheduledBatch.lastReceivedAt,delaySeconds:batchWindowSeconds,acknowledgementText});
						await dispatchReceipt(env,deliveryId,event.replyToken,options.defer);
					}else await replyOnce(env,deliveryId,event.replyToken,acknowledgementText,registered.batch.id);
					continue;
				}
				await storePendingLineText(env.DB, {
					messageId: event.message.id,
					conversationKey,
					text: event.message.text,
					receivedAt,
				});
				const batchWindowSeconds=getLineMessageBatchWindowSeconds(env);
				const registered=await registerBatchText(env.DB,{messageId:event.message.id,webhookEventId:event.webhookEventId,text:event.message.text,receivedAt,conversationKey,pushTarget:getPushTarget(event as unknown as LineImageMessageEvent)},batchWindowSeconds);
				console.log({event:'line_batch_lifecycle',lineUserId:event.source?.userId,webhookEventId:event.webhookEventId??event.message.id,batchId:registered.batch.id,expiresAt:registered.batch.expiresAt,expirationDecision:Boolean(registered.expiredBatchId),action:registered.expiredBatchId?'create':'append'});
				await ensureBatchDeliveryIntent(env.DB,{receiptId:deliveryId,batchId:registered.batch.id,expectedLastReceivedAt:registered.batch.lastReceivedAt,delaySeconds:batchWindowSeconds,acknowledgementText:'Event details received – waiting for related images or text.'});
				await dispatchReceipt(env,deliveryId,event.replyToken,options.defer);
				continue;
			}

			await replyOnce(env,deliveryId,event.replyToken,routeCommand(event.message.text));
		}
		else await recordLineDeliveryOutcome(env.DB,deliveryId,'ignored');
		}catch(error){await recordLineDeliveryOutcome(env.DB,deliveryId,'retryable_failed');console.error({event:'webhook_processing_retryable_failed',deliveryId,messageId,messageType,error:error instanceof Error?error.message:String(error)});}
	}
}

export async function handleWebhook(request: Request, env: WorkerEnv, ctx?:ExecutionContext): Promise<Response> {
	let body: LineWebhookPayload;

	try {
		body = (await request.json()) as LineWebhookPayload;
	} catch {
		return Response.json(
			{ status: 'error', message: 'Invalid request body' },
			{ status: 400 },
		);
	}

	await processWebhookEvents(body, env,{defer:ctx?(promise)=>ctx.waitUntil(promise):undefined});
	return Response.json({ status: 'ok', received: true, service: APP_NAME, version: VERSION, timestamp: new Date().toISOString() });
}
