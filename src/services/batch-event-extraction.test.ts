import { beforeEach,describe,expect,it,vi } from 'vitest';
import { extractBatchEvents,type BatchAssetContext } from './batch-event-extraction';

const put=vi.fn().mockResolvedValue(undefined);
const asset:BatchAssetContext={assetId:'flyer',intakeId:'intake',ordinal:1,receivedAt:'2026-08-01T00:00:00Z',contentType:'image/jpeg',ocrText:'TENUTE GIROLAMO WINE DINNER WEDNESDAY 5TH AUGUST 2026 18:30 HRS'};
const validEvent={isWineEvent:true,title:'Tenute Girolamo Wine Dinner',venue:'Venue',address:null,date:'2026-08-05',startTime:'18:30',endTime:null,timezone:null,price:'1800',currency:'THB',bookingUrl:null,contact:null,wines:[],wineRegions:[],menu:[],notes:[],confidence:0.9,assetAssignments:[{assetId:'flyer',role:'flyer'}]};

beforeEach(()=>vi.clearAllMocks());
describe('batch AI response diagnostics',()=>{
	it('marks valid empty events for fallback',async()=>{const result=await extractBatchEvents({run:vi.fn().mockResolvedValue({response:{events:[],unassignedAssets:['flyer'],ambiguous:true}})} as unknown as Ai,{put} as unknown as R2Bucket,'b1',[asset]);expect(result.diagnostics.parseSuccess).toBe(true);expect(result.diagnostics.schemaValidationSuccess).toBe(true);expect(result.diagnostics.fallbackRequired).toBe(true);expect(result.diagnostics.fallbackReason).toBe('batch analysis returned zero events')});
	it('records malformed JSON and requires fallback',async()=>{const result=await extractBatchEvents({run:vi.fn().mockResolvedValue({response:'not json'})} as unknown as Ai,{put} as unknown as R2Bucket,'b1',[asset]);expect(result.diagnostics.parseSuccess).toBe(false);expect(result.diagnostics.parseError).toBeTruthy();expect(result.diagnostics.fallbackRequired).toBe(true)});
	it('records a schema-invalid response and requires fallback',async()=>{const result=await extractBatchEvents({run:vi.fn().mockResolvedValue({response:{events:'invalid',unassignedAssets:[],ambiguous:false}})} as unknown as Ai,{put} as unknown as R2Bucket,'b1',[asset]);expect(result.diagnostics.parseSuccess).toBe(true);expect(result.diagnostics.schemaValidationSuccess).toBe(false);expect(result.diagnostics.schemaValidationError).toBe('events must be an array');expect(result.diagnostics.fallbackRequired).toBe(true)});
	it('accepts a normal direct-object response without invoking fallback',async()=>{const result=await extractBatchEvents({run:vi.fn().mockResolvedValue({events:[validEvent],unassignedAssets:[],ambiguous:false})} as unknown as Ai,{put} as unknown as R2Bucket,'b1',[asset]);expect(result.events).toHaveLength(1);expect(result.diagnostics.parseSuccess).toBe(true);expect(result.diagnostics.schemaValidationSuccess).toBe(true);expect(result.diagnostics.fallbackRequired).toBe(false)});
});
