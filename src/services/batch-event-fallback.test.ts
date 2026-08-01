import { beforeEach,describe,expect,it,vi } from 'vitest';
import type { ExtractedWineEvent } from './event-extraction';
import type { BatchAssetContext } from './batch-event-extraction';
import { recoverBatchEventsWithSingleAssetFallback } from './batch-event-fallback';

const mocks=vi.hoisted(()=>({extract:vi.fn()}));
vi.mock('./event-extraction',async(importOriginal)=>({...await importOriginal<typeof import('./event-extraction')>(),extractAndStoreEvent:mocks.extract}));
const put=vi.fn().mockResolvedValue(undefined);
const flyer=(title='Tenute Girolamo Wine Dinner',date='2026-08-05'):ExtractedWineEvent=>({isWineEvent:true,title,venue:null,address:null,date,startTime:'18:30',endTime:null,timezone:null,price:'THB 1800++',currency:'THB',bookingUrl:null,contact:null,wines:[],wineRegions:[],menu:[],notes:[],confidence:.9});
const menu:ExtractedWineEvent={isWineEvent:true,title:null,venue:null,address:null,date:null,startTime:null,endTime:null,timezone:null,price:null,currency:null,bookingUrl:null,contact:null,wines:['Wine A','Wine B'],wineRegions:[],menu:['Starter','Main course'],notes:[],confidence:.7};
const asset=(assetId:string,ocrText:string):BatchAssetContext=>({assetId,intakeId:`i-${assetId}`,ordinal:1,receivedAt:'2026-08-01T00:00:00Z',contentType:'image/jpeg',ocrText});
function completed(event:ExtractedWineEvent|null){return {status:'completed',event,model:'model'};}
beforeEach(()=>{vi.clearAllMocks();put.mockClear()});

describe('single-asset batch fallback',()=>{
	it('recovers a strong flyer and assigns a menu to the same event',async()=>{mocks.extract.mockResolvedValueOnce(completed(flyer())).mockResolvedValueOnce(completed(menu));const result=await recoverBatchEventsWithSingleAssetFallback({} as Ai,{put} as unknown as R2Bucket,'b1',[asset('flyer','TENUTE GIROLAMO WINE DINNER 5 AUGUST 2026 18:30'),asset('menu','MENU Starter Main course Wine A Wine B')]);expect(result.events).toHaveLength(1);expect(result.events[0].assetAssignments).toEqual([{assetId:'flyer',role:'flyer'},{assetId:'menu',role:'menu'}]);expect(result.unassignedAssets).toEqual([])});
	it('never turns a menu-only asset into an event',async()=>{mocks.extract.mockResolvedValueOnce(completed(menu));const result=await recoverBatchEventsWithSingleAssetFallback({} as Ai,{put} as unknown as R2Bucket,'b1',[asset('menu','MENU Starter Main course Wine A Wine B')]);expect(result.events).toEqual([]);expect(result.unassignedAssets).toEqual(['menu'])});
	it('keeps two different strong flyers as two events',async()=>{mocks.extract.mockResolvedValueOnce(completed(flyer())).mockResolvedValueOnce(completed(flyer('Burgundy Growers Dinner','2026-08-12')));const result=await recoverBatchEventsWithSingleAssetFallback({} as Ai,{put} as unknown as R2Bucket,'b1',[asset('f1','TENUTE GIROLAMO WINE DINNER'),asset('f2','BURGUNDY GROWERS WINE DINNER')]);expect(result.events).toHaveLength(2);expect(result.events.map((event)=>event.assetAssignments)).toEqual([[{assetId:'f1',role:'flyer'}],[{assetId:'f2',role:'flyer'}]])});
});
