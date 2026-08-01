import { describe,expect,it } from 'vitest';
import { validatePublishableEvent } from './event-publication-guard';

const base={date:null,startTime:null,priceTHB:null,venue:null,contactEmail:null,contactPhone:null,wines:[],wineRegions:[],isWineEvent:true};
describe('phantom-event publication guard',()=>{
	it('rejects the fallback title even when menu text contains wines',()=>{const result=validatePublishableEvent({title:'Wine Event',bookingUrl:null,event:{...base,wines:['Bordeaux']}});expect(result.publishable).toBe(false);expect(result.missingRequiredFields).toEqual(['meaningfulTitle','date','minimumMetadataScore']);expect(result.exactReason).toContain('title is generic')});
	it('rejects a menu-only candidate',()=>{expect(validatePublishableEvent({title:'Five-course menu',bookingUrl:null,event:{...base,wines:['Barolo']}}).publishable).toBe(false)});
	it('accepts an independently identifiable wine event',()=>{expect(validatePublishableEvent({title:'Maison Rouge Winemaker Dinner',bookingUrl:null,event:{...base,date:'2026-08-20',venue:'Le Cellier',isWineEvent:true}}).publishable).toBe(true)});
	it('explains rejection when title and date exist but corroborating metadata is insufficient',()=>{const result=validatePublishableEvent({title:'Maison Rouge Winemaker Dinner',bookingUrl:null,event:{...base,date:'2026-08-20',isWineEvent:false}});expect(result.publishable).toBe(false);expect(result.score).toBe(4);expect(result.missingRequiredFields).toEqual(['minimumMetadataScore']);expect(result.exactReason).toBe('not publishable: metadata score 4 is below required score 5')});
});
