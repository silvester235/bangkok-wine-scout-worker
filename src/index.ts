import { handlePublicApi } from './routes/events';
import {
	handleAdminEventDelete,
	handleAdminEventReprocess,
	handleAdminEventList,
	handleAdminBulkEventDelete,
	handleAdminAsset,
	handleAdminLogin,
	handleAdminLogout,
	handleAdminUi,
	handleAdminReviewItemList,
	handleAdminReviewItemDelete,
} from './routes/admin-events';
import { handleHealth } from './routes/health';
import { handleHome } from './routes/home';
import { handleWebhook, processImageMessage, type ImageProcessingMessage } from './routes/webhook';
import { processImageBatch, type BatchProcessingMessage } from './services/line-image-batch-processing';
import { recordAssetEnrichment } from './services/event-enrichment-repository';
import { listBatchAssets, markQueueRetryExhaustedForReconciliation } from './services/line-image-batch-repository';
import type { WorkerEnv } from './types/env';
import { notFoundResponse } from './utils/responses';
import { completeDeliveryOutboxIntent, runDeliveryReconciliation } from './services/line-delivery-outbox';
import { LineContentDownloadError } from './services/line';
import { handleAgentWebhookV2 } from './routes/agent-webhook-v2';
import { handlePublicEventPages } from './routes/public-event-pages';
import { getIngestionMode } from './services/runtime-controls';
import { runAgentSubmissionReconciliation } from './services/agent-submission-reconciliation';
export { WineScoutSubmissionWorkflow } from './workflows/wine-scout-submission-workflow';

export default {
	async fetch(request, env: WorkerEnv, ctx:ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const ingestionMode=getIngestionMode(env);
		const blocked=(pipeline:'v1'|'v2',reason:string):Response=>{console.warn(JSON.stringify({event:'INGESTION_BLOCKED',pipeline,ingestionMode,reason,timestamp:new Date().toISOString()}));return Response.json({status:'disabled',code:'INGESTION_DISABLED',pipeline,ingestionMode,reason},{status:503,headers:{'cache-control':'no-store','retry-after':'60'}});};

		if (request.method === 'GET' && url.pathname === '/health') {
			return handleHealth();
		}

		if (env.ENABLE_PUBLIC_EVENT_PAGES === 'true' && (
			['/', '/events', '/about', '/share-an-event', '/legal', '/privacy', '/disclaimer', '/sitemap.xml', '/robots.txt'].includes(url.pathname)
			|| url.pathname.startsWith('/events/')
		)) {
			return handlePublicEventPages(request,env);
		}

		if (request.method === 'GET' && url.pathname === '/') {
			return handleHome();
		}

		if (request.method === 'POST' && url.pathname === '/api/line/v2/webhook') {
			if(ingestionMode!=='v2')return blocked('v2',ingestionMode==='v1'?'v1_pipeline_active':'line_ingestion_disabled');
			return handleAgentWebhookV2(request,env,ctx);
		}

		if (url.pathname.startsWith('/api/')) {
			return handlePublicApi(request, env);
		}

		if (request.method === 'GET' && url.pathname === '/admin/events-ui') {
			return handleAdminUi(request, env);
		}

		if (request.method === 'POST' && url.pathname === '/admin/login') {
			return handleAdminLogin(request, env);
		}

		if (request.method === 'POST' && url.pathname === '/admin/logout') {
			return handleAdminLogout();
		}

		if (request.method === 'GET' && url.pathname === '/admin/events') {
			return handleAdminEventList(request, env);
		}

		if (request.method === 'GET' && url.pathname === '/admin/review-items') {
			return handleAdminReviewItemList(request, env);
		}

		if (request.method === 'POST' && url.pathname === '/admin/events/bulk-delete') {
			return handleAdminBulkEventDelete(request, env);
		}

		const adminAsset = url.pathname.match(/^\/admin\/assets\/([^/]+)$/);
		if (request.method === 'GET' && adminAsset) {
			return handleAdminAsset(request, env, adminAsset[1]);
		}

		const adminReviewItemDelete = url.pathname.match(/^\/admin\/review-items\/([^/]+)$/);
		if (request.method === 'DELETE' && adminReviewItemDelete) {
			return handleAdminReviewItemDelete(request, env, adminReviewItemDelete[1]);
		}

		const adminEventDelete = url.pathname.match(/^\/admin\/events\/([^/]+)$/);
		const adminEventReprocess = url.pathname.match(/^\/admin\/events\/([^/]+)\/reprocess$/);
		if (request.method === 'POST' && adminEventReprocess) return handleAdminEventReprocess(request, env, adminEventReprocess[1]);
		if (request.method === 'DELETE' && adminEventDelete) {
			return handleAdminEventDelete(request, env, adminEventDelete[1]);
		}

		if (request.method === 'POST' && url.pathname === '/webhook') {
			if(ingestionMode!=='v1')return blocked('v1',ingestionMode==='v2'?'v2_pipeline_active':'line_ingestion_disabled');
			return handleWebhook(request, env, ctx);
		}

		return notFoundResponse();
	},

	async queue(batch: MessageBatch<ImageProcessingMessage|BatchProcessingMessage>, env: WorkerEnv): Promise<void> {
		for (const message of batch.messages) {
			try {
				if(message.body.type==='process_batch') await processImageBatch(message.body,env);
				else await processImageMessage(message.body, env);
				await completeDeliveryOutboxIntent(env.DB,message.body.outboxId);
				message.ack();
			} catch (error) {
				console.error('IMAGE PROCESSING FAILED:', error);
				const exhausted = message.attempts >= 4 || (error instanceof LineContentDownloadError&&!error.retryable);
				if (exhausted) {
					const errorCode=error instanceof Error?error.message:String(error);
					console.error({event:'enrichment_permanently_failed',batchId:message.body.batchId,jobType:message.body.type,error:errorCode});
					try {
						const assetIds=message.body.type==='process_image'?[message.body.assetId]:(await listBatchAssets(env.DB,message.body.batchId)).map((asset)=>asset.assetId);
						for(const assetId of assetIds) await recordAssetEnrichment(env.DB,{assetId,status:'permanently_failed',extractionStatus:'failed',errorCode});
						await markQueueRetryExhaustedForReconciliation(env.DB,message.body.batchId,errorCode);
						await completeDeliveryOutboxIntent(env.DB,message.body.outboxId,'needs_reconciliation',errorCode);
						console.error({event:'reconciliation_required',batchId:message.body.batchId,resultingState:'queue_retry_exhausted'});
					} catch(stateError){console.error('PERMANENT ENRICHMENT FAILURE STATE WRITE FAILED:',stateError);}
					message.ack();
				} else message.retry();
			}
		}
	},

	async scheduled(_controller:ScheduledController,env:WorkerEnv,ctx:ExecutionContext):Promise<void>{
		ctx.waitUntil(Promise.all([runDeliveryReconciliation(env,{limit:25}),runAgentSubmissionReconciliation(env,{limit:25})]).then(()=>undefined));
	},
} satisfies ExportedHandler<WorkerEnv, ImageProcessingMessage|BatchProcessingMessage>;
