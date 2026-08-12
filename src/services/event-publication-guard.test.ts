import { describe,expect,it } from 'vitest';
import { validatePublishableEvent } from './event-publication-guard';

const base={date:null,startTime:null,priceTHB:null,venue:null,contactEmail:null,contactPhone:null,wines:[],wineRegions:[],isWineEvent:true};
describe('LINE flyer metadata quality evaluation',()=>{
	it('publishes the fallback title while retaining missing-field warnings',()=>{const result=validatePublishableEvent({title:'Wine Event',bookingUrl:null,event:{...base,wines:['Bordeaux']}});expect(result.publishable).toBe(true);expect(result.missingRequiredFields).toEqual(['meaningfulTitle','date','minimumMetadataScore']);expect(result.exactReason).toContain('publishable with extraction warnings')});
	it('treats a menu-shaped candidate as publishable with warnings',()=>{const result=validatePublishableEvent({title:'Five-course menu',bookingUrl:null,event:{...base,wines:['Barolo']}});expect(result.publishable).toBe(true);expect(result.missingRequiredFields).toContain('date')});
	it('accepts an independently identifiable wine event',()=>{expect(validatePublishableEvent({title:'Maison Rouge Winemaker Dinner',bookingUrl:null,event:{...base,date:'2026-08-20',venue:'Le Cellier',isWineEvent:true}}).publishable).toBe(true)});
	it('explains low metadata confidence without rejecting publication',()=>{const result=validatePublishableEvent({title:'Maison Rouge Winemaker Dinner',bookingUrl:null,event:{...base,date:'2026-08-20',isWineEvent:false}});expect(result.publishable).toBe(true);expect(result.score).toBe(4);expect(result.missingRequiredFields).toEqual(['minimumMetadataScore']);expect(result.exactReason).toBe('publishable with extraction warnings: metadata score 4 is below required score 5')});
});
