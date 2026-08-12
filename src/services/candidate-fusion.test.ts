import { describe,expect,it } from 'vitest';
import type { BatchExtractedEvent } from './batch-event-extraction';
import { fuseEventCandidates } from './candidate-fusion';

const candidate=(overrides:Partial<BatchExtractedEvent>):BatchExtractedEvent=>({
	isWineEvent:true,title:null,venue:null,address:null,date:null,startTime:null,endTime:null,timezone:null,price:null,currency:null,
	bookingUrl:null,contact:null,wines:[],wineRegions:[],menu:[],notes:[],confidence:0,assetAssignments:[],...overrides,
} as BatchExtractedEvent);

describe('candidate fusion',()=>{
	it('fills missing fields without replacing richer structured values',()=>{const result=fuseEventCandidates(candidate({title:'Structured title',venue:'Trusted venue',organizer:'Organizer',wines:['A'],confidence:.8,assetAssignments:[{assetId:'flyer',role:'flyer'}]}),candidate({title:'Fallback title',venue:null,bookingUrl:'https://book.example',contactPhone:'02 123 4567',wines:['A','B'],assetAssignments:[{assetId:'menu',role:'menu'}]}));expect(result.event).toMatchObject({title:'Structured title',venue:'Trusted venue',organizer:'Organizer',bookingUrl:'https://book.example',contactPhone:'02 123 4567',wines:['A','B']});expect(result.event.assetAssignments).toHaveLength(2);expect(result.conflicts.map((item)=>item.field)).toContain('title');});
	it('records conflicts while retaining the preferred value',()=>{const result=fuseEventCandidates(candidate({venue:'Venue A'}),candidate({venue:'Venue B'}));expect(result.event.venue).toBe('Venue A');expect(result.conflicts).toEqual([{field:'venue',preferredSource:'batch',alternateSource:'fallback'}]);});
});
