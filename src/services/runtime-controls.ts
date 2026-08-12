import type { WorkerEnv } from '../types/env';

export type IngestionMode='v1'|'v2'|'disabled';
export interface PublicationControl {enabled:boolean;source:'d1'|'environment';rawValue:string|null;}

export function getIngestionMode(env:Pick<WorkerEnv,'INGESTION_MODE'>):IngestionMode{
	const value=env.INGESTION_MODE?.trim().toLowerCase();
	return value==='v1'||value==='v2'||value==='disabled'?value:'disabled';
}

function publicationValue(value:string|undefined|null):boolean{return value?.trim().toLowerCase()==='true';}

/**
 * D1 is the live override for already-running Workflows. If no override exists,
 * the versioned environment value is used and any missing/invalid value is false.
 */
export async function getV2PublicationControl(env:Pick<WorkerEnv,'DB'|'V2_PUBLICATION_ENABLED'>):Promise<PublicationControl>{
	try{
		const row=await env.DB.prepare("SELECT value FROM runtime_controls WHERE key='v2_publication_enabled' LIMIT 1").first<{value:string}>();
		if(row)return{enabled:publicationValue(row.value),source:'d1',rawValue:row.value};
	}catch(error){
		if(!(error instanceof Error)||!error.message.toLowerCase().includes('no such table'))throw error;
	}
	return{enabled:publicationValue(env.V2_PUBLICATION_ENABLED),source:'environment',rawValue:env.V2_PUBLICATION_ENABLED??null};
}
