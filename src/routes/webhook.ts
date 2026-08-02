import {
	APP_NAME, getLineMessageBatchWindowSeconds, VERSION,
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
import { claimBatchForDone, expireActiveBatchForIncoming, registerBatchAsset, registerBatchText, registerBatchWebSource, releaseDoneClaim } from '../services/line-image-batch-repository';
import { detectPrimaryWebUrl, fetchAndExtractWebPage, fetchWebPageImage } from '../services/web-page-ingestion-service';
import type { BatchProcessingMessage } from '../services/line-image-batch-processing';
import type { WorkerEnv } from '../types/env';
import type {
	LineImageMessageEvent,
	LineTextMessageEvent,
	LineWebhookPayload,
} from '../types/line';

export interface ImageProcessingMessage {
	type: 'register_image';
	messageId: string;
	lineUserId?: string;
	pushTarget?: string;
	conversationKey?: string;
	receivedAt: string;
	webhookEventId?: string;
}

function isTextMessageEvent(event: unknown): event is LineTextMessageEvent {
	const candidate = event as LineTextMessageEvent;
	return candidate?.type === 'message' && candidate.message?.type === 'text' && typeof candidate.replyToken === 'string';
}

function isImageMessageEvent(event: unknown): event is LineImageMessageEvent {
	const candidate = event as LineImageMessageEvent;
	return candidate?.type === 'message' && candidate.message?.type === 'image' && typeof candidate.message.id === 'string' && typeof candidate.replyToken === 'string';
}

function getPushTarget(event: LineImageMessageEvent): string | undefined {
	return event.source?.userId ?? event.source?.groupId ?? event.source?.roomId;
}

export async function processImageMessage(message: ImageProcessingMessage, env: WorkerEnv): Promise<void> {
	const downloaded = await downloadLineMessageContent(message.messageId, env.LINE_CHANNEL_ACCESS_TOKEN);
	const asset = await storeLineImageAsset(env.EVENT_INTAKES, {
		sourceType: 'line_image',
		sourceReference: message.messageId,
		lineUserId: message.lineUserId,
		receivedAt: message.receivedAt,
		contentType: downloaded.contentType,
		content: downloaded.content,
	});

	const conversationKey=message.conversationKey??`line-message:${message.messageId}`;
	const batchWindowSeconds=getLineMessageBatchWindowSeconds(env);
	const registered=await registerBatchAsset(env.DB,{assetId:asset.assetId,intakeId:asset.intakeId,lineMessageId:message.messageId,webhookEventId:message.webhookEventId,contentType:downloaded.contentType,r2ObjectKey:asset.objectKey,receivedAt:message.receivedAt,conversationKey,pushTarget:message.pushTarget},batchWindowSeconds);
	if(registered.duplicate) return;
	console.log({event:'line_batch_lifecycle',lineUserId:message.lineUserId,webhookEventId:message.webhookEventId??message.messageId,batchId:registered.batch.id,expiresAt:registered.batch.expiresAt,expirationDecision:Boolean(registered.expiredBatchId),action:registered.expiredBatchId?'create':'append'});
	await env.IMAGE_PROCESSING_QUEUE.send({type:'process_batch',batchId:registered.batch.id,expectedLastReceivedAt:registered.batch.lastReceivedAt} satisfies BatchProcessingMessage,{delaySeconds:batchWindowSeconds});
}

async function acknowledgeAndQueueImage(event: LineImageMessageEvent, env: WorkerEnv): Promise<void> {
	const conversationKey=buildLineConversationKey(event.source)??undefined;
	const receivedAt=new Date(event.timestamp??Date.now()).toISOString();
	if(conversationKey){const expired=await expireActiveBatchForIncoming(env.DB,conversationKey,receivedAt);if(expired){console.log({event:'line_batch_lifecycle',lineUserId:event.source?.userId,webhookEventId:event.webhookEventId??event.message.id,batchId:expired.id,previousBatchStatus:'collecting',batchAge:Date.parse(receivedAt)-Date.parse(expired.createdAt),expiresAt:expired.expiresAt,expirationDecision:true,action:'close'});await env.IMAGE_PROCESSING_QUEUE.send({type:'process_batch',batchId:expired.id,expectedLastReceivedAt:expired.lastReceivedAt,closedProcessingToken:expired.processingAt!} satisfies BatchProcessingMessage);}}
	await env.IMAGE_PROCESSING_QUEUE.send({
		type: 'register_image',
		messageId: event.message.id,
		lineUserId: event.source?.userId,
		pushTarget: getPushTarget(event),
		conversationKey,
		receivedAt,
		webhookEventId:event.webhookEventId,
	} satisfies ImageProcessingMessage);

	await replyToLine(event.replyToken, 'Image received – waiting for related messages.', env.LINE_CHANNEL_ACCESS_TOKEN);
}

export async function processWebhookEvents(body: LineWebhookPayload, env: WorkerEnv): Promise<void> {
	for (const event of body.events ?? []) {
		if (isImageMessageEvent(event)) await acknowledgeAndQueueImage(event, env);
		else if (isTextMessageEvent(event)) {
			const conversationKey = buildLineConversationKey(event.source);
			if (event.message.text.trim().toLowerCase() === '/done') {
				const now=new Date(event.timestamp??Date.now()).toISOString();
				const decision=conversationKey?await claimBatchForDone(env.DB,conversationKey,now):{outcome:'not_found'} as const;
				let queueAction='none';
				let duplicateSuppressionReason:string|null=null;
				if(decision.outcome==='claimed') {
					const token=decision.batch.processingAt!;
					try{
						await env.IMAGE_PROCESSING_QUEUE.send({type:'process_batch',batchId:decision.batch.id,expectedLastReceivedAt:decision.batch.lastReceivedAt,closedProcessingToken:token} satisfies BatchProcessingMessage);
						queueAction='enqueued';
					}catch(error){
						queueAction=await releaseDoneClaim(env.DB,decision.batch.id,token,now)?'enqueue_failed_claim_released':'enqueue_failed_claim_changed';
						console.error({event:'line_batch_done_enqueue_failed',batchId:decision.batch.id,queueAction,error:error instanceof Error?error.message:String(error)});
						throw error;
					}
					await replyToLine(event.replyToken, 'Batch closed – processing now.', env.LINE_CHANNEL_ACCESS_TOKEN);
				}else if(decision.outcome==='already_processing'){
					duplicateSuppressionReason='batch_already_processing';
					await replyToLine(event.replyToken,'This batch is already being processed.',env.LINE_CHANNEL_ACCESS_TOKEN);
				}else if(decision.outcome==='already_completed'){
					duplicateSuppressionReason=`batch_status_${decision.batch.status}`;
					await replyToLine(event.replyToken,'This batch has already been processed.',env.LINE_CHANNEL_ACCESS_TOKEN);
				}else await replyToLine(event.replyToken, 'No active batch to close.', env.LINE_CHANNEL_ACCESS_TOKEN);
				const batch=decision.outcome==='not_found'?null:decision.batch;
				console.log({event:'line_batch_done_decision',conversationKey,webhookEventId:event.webhookEventId??event.message.id,batchId:batch?.id??null,previousStatus:decision.outcome==='claimed'?decision.previousStatus:batch?.status??null,currentStatus:batch?.status??null,expiresAt:batch?.expiresAt??null,doneTimestamp:now,expiredAtReceipt:batch?batch.expiresAt<=now:null,claimOutcome:decision.outcome,claimReason:decision.outcome==='claimed'?decision.claimReason:null,queueAction,duplicateSuppressionReason});
				continue;
			}
			if (isKnownCommand(event.message.text)) {
				await replyToLine(event.replyToken, routeCommand(event.message.text), env.LINE_CHANNEL_ACCESS_TOKEN);
				continue;
			}

			if (event.message.text.trim() && conversationKey) {
				const receivedAt=new Date(event.timestamp ?? Date.now()).toISOString();
				const expired=await expireActiveBatchForIncoming(env.DB,conversationKey,receivedAt);
				if(expired)await env.IMAGE_PROCESSING_QUEUE.send({type:'process_batch',batchId:expired.id,expectedLastReceivedAt:expired.lastReceivedAt,closedProcessingToken:expired.processingAt!} satisfies BatchProcessingMessage);
				const detectedUrl=detectPrimaryWebUrl(event.message.text);
				if(detectedUrl){
					const ingestion=await fetchAndExtractWebPage(detectedUrl.url,{timeoutMs:8_000,maxRedirects:5,maxHtmlBytes:1_500_000,maxExtractedTextChars:40_000,userAgent:'BangkokWineScoutBot/1.0 (+https://bangkokwinescout.com)'});
					console.log({
						event:'line_web_source_extracted',
						requestedUrl:ingestion.requestedUrl,
						finalUrl:ingestion.finalUrl,
						status:ingestion.status,
						title:ingestion.title,
						description:ingestion.description,
						jsonLd:ingestion.jsonLd,
						extractedText:ingestion.extractedText,
					});
					const batchWindowSeconds=getLineMessageBatchWindowSeconds(env);
					const registered=await registerBatchWebSource(env.DB,{messageId:event.message.id,webhookEventId:event.webhookEventId,receivedAt,conversationKey,pushTarget:getPushTarget(event as unknown as LineImageMessageEvent),...ingestion},batchWindowSeconds);
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
					console.log({event:'line_web_source_ingestion',batchId:registered.batch.id,normalizedUrl:ingestion.normalizedUrl,status:ingestion.status,httpStatus:ingestion.httpStatus,errorCode:ingestion.errorCode,duplicate:registered.duplicate});
					if(!registered.duplicate||contextRegistered)await env.IMAGE_PROCESSING_QUEUE.send({type:'process_batch',batchId:scheduledBatch.id,expectedLastReceivedAt:scheduledBatch.lastReceivedAt},{delaySeconds:batchWindowSeconds});
					await replyToLine(event.replyToken,ingestion.status==='completed'?'Event page received – waiting for related images or text.':`I couldn't read that event page (${ingestion.errorMessage??'unsupported page'}). You can send the event details as text or an image instead.`,env.LINE_CHANNEL_ACCESS_TOKEN);
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
				if(!registered.duplicate)await env.IMAGE_PROCESSING_QUEUE.send({type:'process_batch',batchId:registered.batch.id,expectedLastReceivedAt:registered.batch.lastReceivedAt} satisfies BatchProcessingMessage,{delaySeconds:batchWindowSeconds});
				await replyToLine(
					event.replyToken,
					'Event details received – waiting for related images or text.',
					env.LINE_CHANNEL_ACCESS_TOKEN,
				);
				continue;
			}

			await replyToLine(event.replyToken, routeCommand(event.message.text), env.LINE_CHANNEL_ACCESS_TOKEN);
		}
	}
}

export async function handleWebhook(request: Request, env: WorkerEnv): Promise<Response> {
	let body: LineWebhookPayload;

	try {
		body = (await request.json()) as LineWebhookPayload;
	} catch {
		return Response.json(
			{ status: 'error', message: 'Invalid request body' },
			{ status: 400 },
		);
	}

	await processWebhookEvents(body, env);
	return Response.json({ status: 'ok', received: true, service: APP_NAME, version: VERSION, timestamp: new Date().toISOString() });
}
