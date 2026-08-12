import type { BatchExtractedEvent } from './batch-event-extraction';

export interface ParserWarning { field:string; code:string }
export interface PriceEvidence { raw:string; amount:number; qualifier:string|null; currency:string|null }

function amountFrom(raw:string):number|null{
	let compact=raw.replace(/\s/g,'');
	const numeric=compact.match(/\d[\d,.]*/)?.[0]??'';
	if(/^\d{1,3}(?:[,.]\d{3})+$/.test(numeric))compact=compact.replace(/[,.]/g,'');
	else compact=compact.replace(/,/g,'');
	const match=compact.match(/\d+(?:\.\d+)?/);
	if(!match)return null;
	const amount=Number(match[0]);
	return Number.isFinite(amount)&&amount>=100&&amount<=1_000_000?amount:null;
}

export function parsePriceEvidence(text:string):{value:PriceEvidence|null;warnings:ParserWarning[]}{
	const candidates:Array<PriceEvidence&{strength:number}>=[];
	const patterns=[
		{regex:/(?:THB|฿)[ \t]*[\d][\d,. \t]*(?:\+\+|\+|\bnet\b)?/gi,strength:3},
		{regex:/\b[\d][\d,.]*(?:\s*)(?:THB|baht)(?:\s*)(?:\+\+|\+|\bnet\b)?/gi,strength:3},
		{regex:/\b[\d][\d,.]*(?:\s*)(?:\+\+|\+|\bnet\b)/gi,strength:2},
		{regex:/(?:price|priced at|per person|per pax)\s*[:\-]?\s*(?:THB|฿)?\s*[\d][\d,.]*/gi,strength:2},
	];
	for(const {regex,strength} of patterns)for(const match of text.matchAll(regex)){
		const raw=match[0].trim();const amount=amountFrom(raw);if(amount===null)continue;
		const hasCurrency=/(?:THB|฿|baht)/i.test(raw);const qualifier=raw.match(/\+\+|\+|\bnet\b/i)?.[0]??null;
		if(!hasCurrency&&!qualifier&&Number.isInteger(amount)&&amount>=1900&&amount<=2100)continue;
		if(raw.replace(/\D/g,'').length>=8)continue;
		candidates.push({raw,amount,qualifier,currency:hasCurrency?'THB':null,strength});
	}
	const unique=[...new Map(candidates.map((item)=>[`${item.amount}:${item.qualifier??''}:${item.currency??''}`,item])).values()]
		.sort((left,right)=>right.strength-left.strength);
	if(unique.length===0)return{value:null,warnings:[]};
	const strongest=unique.filter((item)=>item.strength===unique[0].strength);
	if(new Set(strongest.map((item)=>item.amount)).size>1)return{value:null,warnings:[{field:'price',code:'ambiguous_multiple_prices'}]};
	const {strength:_,...value}=strongest[0];return{value,warnings:[]};
}

function firstMatch(text:string,regex:RegExp):string|null{return text.match(regex)?.[1]?.trim()??null;}

export function recoverDeterministicEventFields(candidate:BatchExtractedEvent,evidence:string):{event:BatchExtractedEvent;warnings:ParserWarning[]}{
	const warnings:ParserWarning[]=[];const price=parsePriceEvidence(evidence);warnings.push(...price.warnings);
	const contactPhone=firstMatch(evidence,/(?:tel(?:ephone)?|phone|call|contact)\s*[:.]?\s*(\+?\d[\d\s-]{7,}\d)/i);
	const contactEmail=firstMatch(evidence,/\b([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})\b/i);
	const websiteMatches=[...evidence.matchAll(/(?<!@)\b((?:https?:\/\/)?(?:www\.)?[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:\/[\w./?%&=+#-]*)?)/gi)].map((match)=>match[1]);
	const websites=[...new Set(websiteMatches)];
	if(websites.length>1)warnings.push({field:'websiteUrl',code:'ambiguous_multiple_websites'});
	const websiteUrl=websites.length===1?websites[0]:null;
	const course=firstMatch(evidence,/\b(\d{1,2})\s*(?:courses?|course[- ]pairing)\b/i);
	const bookingInstructions=evidence.split(/\r?\n/).map((line)=>line.trim()).find((line)=>/\b(?:book|reserve|reservation|scan to book)\b/i.test(line))??null;
	return{event:{...candidate,
		price:candidate.price??price.value?.raw??null,
		priceAmount:candidate.priceAmount??price.value?.amount??null,
		priceQualifier:candidate.priceQualifier??price.value?.qualifier??null,
		currency:candidate.currency??price.value?.currency??null,
		contactPhone:candidate.contactPhone??contactPhone,
		contactEmail:candidate.contactEmail??contactEmail,
		websiteUrl:candidate.websiteUrl??websiteUrl,
		courseCount:candidate.courseCount??(course?Number(course):null),
		bookingInstructions:candidate.bookingInstructions??bookingInstructions,
	},warnings};
}
