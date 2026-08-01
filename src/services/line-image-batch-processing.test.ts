import { beforeEach,describe,expect,it,vi } from 'vitest';
import type { WorkerEnv } from '../types/env';
import { processImageBatch } from './line-image-batch-processing';

const mocks=vi.hoisted(()=>({getBatch:vi.fn(),claim:vi.fn(),list:vi.fn(),complete:vi.fn(),markNotification:vi.fn(),ocr:vi.fn(),batchExtract:vi.fn(),fallback:vi.fn(),save:vi.fn()}));
vi.mock('../config',()=>({getOptionalAiEventResolutionOptions:vi.fn(),getOptionalLineTextContextWindowSeconds:vi.fn().mockReturnValue(null)}));
vi.mock('./line-image-batch-repository',()=>({getBatch:mocks.getBatch,claimReadyBatch:mocks.claim,listBatchAssets:mocks.list,completeBatch:mocks.complete,markBatchNotificationSent:mocks.markNotification,retryFailedBatch:vi.fn(),failBatch:vi.fn()}));
vi.mock('./ocr',()=>({extractAndStoreOcr:mocks.ocr}));
vi.mock('./batch-event-extraction',()=>({extractBatchEvents:mocks.batchExtract}));
vi.mock('./batch-event-fallback',()=>({recoverBatchEventsWithSingleAssetFallback:mocks.fallback}));
vi.mock('./event-repository',async(importOriginal)=>({...await importOriginal<typeof import('./event-repository')>(),saveWineEvent:mocks.save}));
vi.mock('./line-text-context',()=>({claimLineTextContext:vi.fn().mockResolvedValue(null),markLineTextContextLinked:vi.fn()}));
vi.mock('./line',()=>({pushToLine:vi.fn()}));

const candidate={isWineEvent:true,title:'Tenute Girolamo Wine Dinner',venue:null,address:null,date:'2026-08-05',startTime:'18:30',endTime:null,timezone:null,price:'THB 1800++',currency:'THB',bookingUrl:null,contact:null,wines:['Wine A'],wineRegions:[],menu:['Dish'],notes:[],confidence:.9,assetAssignments:[{assetId:'a1',role:'flyer'},{assetId:'a2',role:'menu'}]};
const diagnostics={model:'model',rawResponse:{},parseSuccess:true,parseError:null,schemaValidationSuccess:true,schemaValidationError:null,fallbackRequired:true,fallbackReason:'batch analysis returned zero events'};
const bucket={get:vi.fn().mockResolvedValue({arrayBuffer:vi.fn().mockResolvedValue(new Uint8Array([1]).buffer)}),put:vi.fn().mockResolvedValue(undefined)};
const env={DB:{},AI:{},EVENT_INTAKES:bucket,IMAGE_PROCESSING_QUEUE:{},LINE_IMAGE_BATCH_WINDOW_SECONDS:'15'} as unknown as WorkerEnv;

beforeEach(()=>{vi.clearAllMocks();const batch={id:'b1',status:'collecting',lastReceivedAt:'2026-01-01T00:00:00.000Z',pushTarget:null};mocks.getBatch.mockResolvedValue(batch);mocks.claim.mockResolvedValue({...batch,status:'processing'});mocks.list.mockResolvedValue([{batchId:'b1',assetId:'a1',intakeId:'i1',lineMessageId:'m1',contentType:'image/jpeg',r2ObjectKey:'o1',receivedAt:'2026-01-01T00:00:00Z',conversationKey:'user:u',ordinal:1},{batchId:'b1',assetId:'a2',intakeId:'i2',lineMessageId:'m2',contentType:'image/jpeg',r2ObjectKey:'o2',receivedAt:'2026-01-01T00:00:01Z',conversationKey:'user:u',ordinal:2}]);mocks.ocr.mockResolvedValueOnce({status:'completed',text:'TENUTE GIROLAMO WINE DINNER 5 AUGUST 2026 18:30',model:'ocr'}).mockResolvedValueOnce({status:'completed',text:'MENU Dish Wine A Wine B',model:'ocr'});mocks.complete.mockResolvedValue(true);mocks.save.mockResolvedValue({id:'event-1',duplicate:false})});

describe('batch processing fallback integration',()=>{
	it('publishes one recovered flyer event with its menu asset',async()=>{mocks.batchExtract.mockResolvedValue({events:[],unassignedAssets:['a1','a2'],ambiguous:true,diagnostics});mocks.fallback.mockResolvedValue({events:[candidate],unassignedAssets:[],ambiguous:false,diagnostics:[]});await processImageBatch({type:'process_batch',batchId:'b1',expectedLastReceivedAt:'2026-01-01T00:00:00.000Z'},env);expect(mocks.fallback).toHaveBeenCalledOnce();expect(mocks.save).toHaveBeenCalledOnce();expect(mocks.save.mock.calls[0][1]).toEqual(expect.objectContaining({assetId:'a1',assetRole:'main',relatedAssets:[expect.objectContaining({assetId:'a2',assetRole:'menu'})]}));expect(mocks.complete).toHaveBeenCalledWith(env.DB,'b1','completed',['event-1'])});
	it('does not invoke fallback when batch analysis succeeds normally',async()=>{mocks.batchExtract.mockResolvedValue({events:[candidate],unassignedAssets:[],ambiguous:false,diagnostics:{...diagnostics,fallbackRequired:false,fallbackReason:null}});await processImageBatch({type:'process_batch',batchId:'b1',expectedLastReceivedAt:'2026-01-01T00:00:00.000Z'},env);expect(mocks.fallback).not.toHaveBeenCalled();expect(mocks.save).toHaveBeenCalledOnce()});
	it('links a menu deterministically when its wine survives but AI leaves it unassigned',async()=>{mocks.batchExtract.mockResolvedValue({events:[{...candidate,assetAssignments:[{assetId:'a1',role:'flyer'}]}],unassignedAssets:['a2'],ambiguous:true,diagnostics:{...diagnostics,fallbackRequired:false,fallbackReason:null}});await processImageBatch({type:'process_batch',batchId:'b1',expectedLastReceivedAt:'2026-01-01T00:00:00.000Z'},env);expect(mocks.fallback).not.toHaveBeenCalled();expect(mocks.save.mock.calls[0][1]).toEqual(expect.objectContaining({assetRole:'main',relatedAssets:[expect.objectContaining({assetId:'a2',assetRole:'menu'})]}));expect(mocks.complete).toHaveBeenCalledWith(env.DB,'b1','completed',['event-1'])});
});
