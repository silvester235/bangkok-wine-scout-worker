import { parseEventDateFromText } from './date-parser';
import type { BatchAssetContext, BatchExtractedEvent } from './batch-event-extraction';
import type { EventAssetRole } from './event-repository';

export interface AssetContribution { assetId:string; candidateIndex:number|null; assigned:boolean; assignedRole:EventAssetRole|'unassigned'; attributionSignals:string[]; conflictSignals:string[]; exactReason:string; contributedFields:string[]; identityScore:number; menuLike:boolean }
export interface AttributionResult { events:BatchExtractedEvent[]; unassignedAssets:string[]; contributions:AssetContribution[] }

function canonical(value:string):string{return value.normalize('NFKD').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim();}
function contains(text:string,value:string|null|undefined):boolean{if(!value)return false;const needle=canonical(value);return needle.length>=4&&canonical(text).includes(needle);}
function menuSignals(text:string,event:BatchExtractedEvent):string[]{const signals:string[]=[];const headings=text.match(/\b(to start|starter|first course|pasta|main course|dessert)\b/gi)??[];if(headings.length)signals.push('menu-like OCR structure');const vintages=text.match(/\b(?:19|20)\d{2}\b/g)??[];if(vintages.length>=2)signals.push(`${vintages.length} wine vintages detected`);const wineMatches=event.wines.filter((wine)=>contains(text,wine));if(wineMatches.length)signals.push(`${wineMatches.length} wines contributed to merged candidate`);const menuMatches=event.menu.filter((item)=>contains(text,item));if(menuMatches.length)signals.push(`${menuMatches.length} menu items contributed to merged candidate`);return[...new Set(signals)];}
function identityScore(text:string,event:BatchExtractedEvent):number{let score=0;if(contains(text,event.title))score+=3;const detected=parseEventDateFromText(text,new Date(`${event.date??'2026-01-01'}T00:00:00Z`));if(detected&&detected===event.date)score+=3;if(contains(text,event.startTime?.replace(':',' ')))score++;if(contains(text,event.venue))score+=2;return score;}

/** One LINE message batch owns at most one event; AI assignments only hint roles. */
export function attributeContributingAssets(events:BatchExtractedEvent[],assets:BatchAssetContext[]):AttributionResult{
	if(events.length!==1)return{events:events.map((event)=>({...event,assetAssignments:[]})),unassignedAssets:assets.map((asset)=>asset.assetId),contributions:assets.map((asset)=>({assetId:asset.assetId,candidateIndex:null,assigned:false,assignedRole:'unassigned',attributionSignals:[],conflictSignals:[],exactReason:events.length>1?'left unassigned: one batch produced multiple event candidates':'left unassigned: no event candidate',contributedFields:[],identityScore:0,menuLike:false}))};
	const event=events[0];const hints=new Map(event.assetAssignments.map((assignment)=>[assignment.assetId,assignment.role]));
	const evaluated=assets.map((asset)=>{const text=`${asset.lineText??''}\n${asset.ocrText}`;const signals=menuSignals(text,event);return{asset,text,signals,menuLike:signals.length>0,score:identityScore(text,event),hint:hints.get(asset.assetId)};});
	const explicitMain=evaluated.find((item)=>item.hint==='main');
	const primary=explicitMain??[...evaluated].sort((a,b)=>b.score-a.score||a.asset.ordinal-b.asset.ordinal)[0];
	const assignments=evaluated.map((item)=>{let role:EventAssetRole=item.hint??(item.menuLike?'menu':item.score>0?'flyer':'other');if(item.asset.assetId===primary?.asset.assetId)role='main';else if(role==='main')role=item.menuLike?'menu':'flyer';return{assetId:item.asset.assetId,role};});
	const contributions=evaluated.map((item)=>{const role=assignments.find((assignment)=>assignment.assetId===item.asset.assetId)!.role;return{assetId:item.asset.assetId,candidateIndex:0,assigned:true,assignedRole:role,attributionSignals:[...item.signals,'one-batch-one-event ownership rule'],conflictSignals:[],exactReason:role==='main'?'assigned as the deterministic main asset':'assigned because every image in a publishable LINE message batch belongs to its single event',contributedFields:[],identityScore:item.score,menuLike:item.menuLike} satisfies AssetContribution;});
	return{events:[{...event,assetAssignments:assignments}],unassignedAssets:[],contributions};
}
