import { describe, expect, it, vi } from 'vitest';
import type { WorkerEnv } from './types/env';

const mocks=vi.hoisted(()=>({v1:vi.fn(async()=>Response.json({pipeline:'v1'})),v2:vi.fn(async()=>Response.json({pipeline:'v2'})),processImage:vi.fn(),processBatch:vi.fn(),record:vi.fn(),listAssets:vi.fn(),reconcile:vi.fn()}));
vi.mock('./routes/webhook',()=>({handleWebhook:mocks.v1,processImageMessage:mocks.processImage,QueueClaimConflictError:class QueueClaimConflictError extends Error{}}));
vi.mock('./routes/agent-webhook-v2',()=>({handleAgentWebhookV2:mocks.v2,handleAgentSubmissionDebug:vi.fn()}));
vi.mock('./services/line-image-batch-processing',()=>({processImageBatch:mocks.processBatch}));
vi.mock('./services/event-enrichment-repository',()=>({recordAssetEnrichment:mocks.record}));
vi.mock('./services/line-image-batch-repository',()=>({listBatchAssets:mocks.listAssets,markQueueRetryExhaustedForReconciliation:mocks.reconcile}));

import worker from './index';

function message(attempts:number){return{body:{type:'process_image' as const,batchId:'b1',assetId:'a1',sourceMessageId:'m1',messageId:'m1',receivedAt:'2026-08-01T00:00:00Z'},attempts,ack:vi.fn(),retry:vi.fn()};}

describe('processing queue retry exhaustion',()=>{
	it('retries before the configured final attempt',async()=>{mocks.processImage.mockRejectedValueOnce(new Error('AI unavailable'));const item=message(3);await worker.queue({messages:[item]} as never,{DB:{}} as WorkerEnv);expect(item.retry).toHaveBeenCalledOnce();expect(item.ack).not.toHaveBeenCalled();expect(mocks.record).not.toHaveBeenCalled();});
	it('records permanent failure and acknowledges the fourth failed attempt',async()=>{mocks.processImage.mockRejectedValueOnce(new Error('AI unavailable'));mocks.record.mockResolvedValue(undefined);mocks.reconcile.mockResolvedValue(undefined);const item=message(4);await worker.queue({messages:[item]} as never,{DB:{}} as WorkerEnv);expect(mocks.record).toHaveBeenCalledWith({},expect.objectContaining({assetId:'a1',status:'permanently_failed',errorCode:'AI unavailable'}));expect(mocks.reconcile).toHaveBeenCalledWith({},'b1','AI unavailable');expect(item.ack).toHaveBeenCalledOnce();expect(item.retry).not.toHaveBeenCalled();});
});

function routeEnv(mode?:string):WorkerEnv{const db={prepare:()=>({bind(){return this},all:async()=>({results:[]})})};return{INGESTION_MODE:mode,ADMIN_API_TOKEN:'admin',DB:db} as unknown as WorkerEnv;}
const fetchWith=(path:string,mode?:string,method='GET')=>worker.fetch(new Request(`https://example.com${path}`,{method}),routeEnv(mode),{waitUntil:vi.fn()} as unknown as ExecutionContext);

describe('LINE ingestion safety mode',()=>{
	it('allows only V1 in v1 mode and blocks V2 before its handler',async()=>{mocks.v1.mockClear();mocks.v2.mockClear();expect((await fetchWith('/webhook','v1','POST')).status).toBe(200);const blocked=await fetchWith('/api/line/v2/webhook','v1','POST');expect(blocked.status).toBe(503);expect(await blocked.json()).toMatchObject({code:'INGESTION_DISABLED',pipeline:'v2',ingestionMode:'v1'});expect(mocks.v1).toHaveBeenCalledOnce();expect(mocks.v2).not.toHaveBeenCalled();});
	it('allows only V2 in v2 mode',async()=>{mocks.v1.mockClear();mocks.v2.mockClear();expect((await fetchWith('/api/line/v2/webhook','v2','POST')).status).toBe(200);expect((await fetchWith('/webhook','v2','POST')).status).toBe(503);expect(mocks.v2).toHaveBeenCalledOnce();expect(mocks.v1).not.toHaveBeenCalled();});
	it.each([['disabled'],['invalid'],[undefined]])('fails closed for mode %s',async(mode)=>{mocks.v1.mockClear();mocks.v2.mockClear();expect((await fetchWith('/webhook',mode,'POST')).status).toBe(503);expect((await fetchWith('/api/line/v2/webhook',mode,'POST')).status).toBe(503);expect(mocks.v1).not.toHaveBeenCalled();expect(mocks.v2).not.toHaveBeenCalled();});
	it.each(['v1','v2','disabled','invalid'])('keeps public API, website, health, and admin available in %s mode',async(mode)=>{expect((await fetchWith('/',mode)).status).toBe(200);expect((await fetchWith('/health',mode)).status).toBe(200);expect((await fetchWith('/api/events',mode)).status).toBe(200);expect((await fetchWith('/admin/events-ui',mode)).status).toBe(200);});
});
