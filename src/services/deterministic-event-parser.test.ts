import { describe,expect,it } from 'vitest';
import type { BatchExtractedEvent } from './batch-event-extraction';
import { parsePriceEvidence,recoverDeterministicEventFields } from './deterministic-event-parser';

const blank={isWineEvent:true,title:'Wine dinner',venue:null,address:null,date:null,startTime:null,endTime:null,timezone:null,price:null,currency:null,bookingUrl:null,contact:null,wines:[],wineRegions:[],menu:[],notes:[],confidence:.5,assetAssignments:[]} as BatchExtractedEvent;

describe('contextual deterministic event parsing',()=>{
	it.each([
		['THB 1,490++',1490,'++'],['฿ 2.500 net',2500,'net'],['Price: 990+',990,'+'],['1,250 baht',1250,null],
	])('parses contextual price %s', (text,amount,qualifier)=>{const result=parsePriceEvidence(text);expect(result.value?.amount).toBe(amount);expect(result.value?.qualifier).toBe(qualifier);});
	it.each(['2026','26 August 2026','6 PM','Telephone 063 832 3605','5 courses','malformed OCR ?!'])('does not fabricate a price from %s',(text)=>expect(parsePriceEvidence(text).value).toBeNull());
	it('returns a warning rather than choosing between multiple prices',()=>{const result=parsePriceEvidence('Early bird THB 1,200; regular THB 1,500');expect(result.value).toBeNull();expect(result.warnings).toContainEqual({field:'price',code:'ambiguous_multiple_prices'});});
	it('fills only missing fields and preserves raw qualifiers and contact evidence',()=>{const result=recoverDeterministicEventFields({...blank,venue:'Existing venue'},'5 Courses\nTHB 1,490++\nTelephone: 063 832 3605\nhello@example.com\nchezpapa.example\nScan to book');expect(result.event).toMatchObject({venue:'Existing venue',price:'THB 1,490++',priceAmount:1490,priceQualifier:'++',currency:'THB',contactPhone:'063 832 3605',contactEmail:'hello@example.com',websiteUrl:'chezpapa.example',courseCount:5,bookingInstructions:'Scan to book'});});
	it('does not choose an arbitrary website',()=>{const result=recoverDeterministicEventFields(blank,'Details: a.example and b.example');expect(result.event.websiteUrl).toBeNull();expect(result.warnings).toContainEqual({field:'websiteUrl',code:'ambiguous_multiple_websites'});});
});
