import type { BatchExtractedEvent } from './batch-event-extraction';

export interface CandidateConflict { field:string; preferredSource:'batch'; alternateSource:'fallback' }

const scalarFields=['title','organizer','venue','address','district','date','startTime','endTime','timezone','price','priceAmount','priceQualifier','currency','bookingUrl','websiteUrl','bookingInstructions','contact','contactPhone','contactEmail','contactText','description','courseCount','qrCodePresent','decodedQrValue'] as const;
const arrayFields=['wines','wineRegions','wineProducers','partners','merchants','menu','notes','sourceContactInformation'] as const;

const present=(value:unknown)=>value!==null&&value!==undefined&&(typeof value!=='string'||value.trim()!=='');
const canonical=(value:unknown)=>typeof value==='string'?value.normalize('NFKC').trim().toLocaleLowerCase('en-US'):JSON.stringify(value);
function union(left:string[]|undefined,right:string[]|undefined):string[]{const values:string[]=[];const seen=new Set<string>();for(const item of [...(left??[]),...(right??[])]){const display=item.trim();const key=canonical(display);if(display&&!seen.has(key)){seen.add(key);values.push(display);}}return values;}

export function fuseEventCandidates(batch:BatchExtractedEvent,fallback:BatchExtractedEvent):{event:BatchExtractedEvent;conflicts:CandidateConflict[]}{
	const event={...fallback,...batch} as BatchExtractedEvent;const conflicts:CandidateConflict[]=[];
	for(const field of scalarFields){const preferred=batch[field];const alternate=fallback[field];(event as unknown as Record<string,unknown>)[field]=present(preferred)?preferred:alternate??null;if(present(preferred)&&present(alternate)&&canonical(preferred)!==canonical(alternate))conflicts.push({field,preferredSource:'batch',alternateSource:'fallback'});}
	for(const field of arrayFields)(event as unknown as Record<string,unknown>)[field]=union(batch[field] as string[]|undefined,fallback[field] as string[]|undefined);
	event.isWineEvent=batch.isWineEvent||fallback.isWineEvent;
	event.confidence=Math.max(batch.confidence??0,fallback.confidence??0);
	event.assetAssignments=unionAssignments(batch.assetAssignments,fallback.assetAssignments);
	return{event,conflicts};
}

function unionAssignments(left:BatchExtractedEvent['assetAssignments'],right:BatchExtractedEvent['assetAssignments']):BatchExtractedEvent['assetAssignments']{
	const result=[...left];const seen=new Set(left.map((item)=>item.assetId));for(const item of right)if(!seen.has(item.assetId)){seen.add(item.assetId);result.push(item);}return result;
}
