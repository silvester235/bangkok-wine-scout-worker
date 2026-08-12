import {describe,expect,it,vi} from 'vitest';
import type {WorkerEnv} from '../types/env';
import {getIngestionMode,getV2PublicationControl} from './runtime-controls';
import {PUBLICATION_DISABLED_REASON,publicationBlockedNotification,publicationBlockedTerminal,runV2PersistenceBoundary} from '../workflows/wine-scout-submission-workflow';

function controlDb(read:()=>string|null):D1Database{return{prepare:vi.fn(()=>({first:vi.fn(async()=>{const value=read();return value===null?null:{value};})}))} as unknown as D1Database;}
function boundaryEnv(value:string,read:()=>string|null=()=>null):Pick<WorkerEnv,'DB'|'V2_PUBLICATION_ENABLED'|'INGESTION_MODE'>{return{DB:controlDb(read),V2_PUBLICATION_ENABLED:value,INGESTION_MODE:'v2'};}

describe('production safety controls',()=>{
	it('parses only supported ingestion modes and otherwise disables ingestion',()=>{expect(getIngestionMode({INGESTION_MODE:'v1'})).toBe('v1');expect(getIngestionMode({INGESTION_MODE:' V2 '})).toBe('v2');expect(getIngestionMode({INGESTION_MODE:'disabled'})).toBe('disabled');expect(getIngestionMode({INGESTION_MODE:'both'})).toBe('disabled');expect(getIngestionMode({})).toBe('disabled');});
	it('fails V2 publication closed for false, missing, and invalid environment values',async()=>{for(const value of ['false','invalid',''])expect((await getV2PublicationControl(boundaryEnv(value))).enabled).toBe(false);});
	it.each(['create','update'])('blocks %s persistence before any canonical or asset write',async operation=>{const canonicalWrite=vi.fn();const assetLink=vi.fn();const result=await runV2PersistenceBoundary(boundaryEnv('false'),'submission-1','workflow-1',async()=>{await canonicalWrite(operation);await assetLink();return{operation};});expect(result).toMatchObject({blocked:true,control:{enabled:false}});expect(canonicalWrite).not.toHaveBeenCalled();expect(assetLink).not.toHaveBeenCalled();});
	it('returns a precise terminal status and non-publication notification text',()=>{expect(publicationBlockedTerminal()).toEqual({status:'needs_review',errorCode:'publication_disabled',errorMessage:PUBLICATION_DISABLED_REASON});expect(PUBLICATION_DISABLED_REASON).toContain('publication is disabled');expect(publicationBlockedNotification()).toContain('needs review');expect(publicationBlockedNotification()).not.toMatch(/published|updated/i);});
	it('preserves persistence when publication is true',async()=>{const persist=vi.fn(async()=>({eventId:'event-1',updated:false}));const result=await runV2PersistenceBoundary(boundaryEnv('true'),'submission-1','workflow-1',persist);expect(result).toMatchObject({blocked:false,persisted:{eventId:'event-1'}});expect(persist).toHaveBeenCalledOnce();});
	it('re-reads the D1 override at persistence time for an already-running Workflow',async()=>{let liveValue:'true'|'false'='true';const env=boundaryEnv('true',()=>liveValue);expect((await getV2PublicationControl(env)).enabled).toBe(true);liveValue='false';const persist=vi.fn();const result=await runV2PersistenceBoundary(env,'in-flight','workflow-in-flight',persist);expect(result).toMatchObject({blocked:true,control:{source:'d1',rawValue:'false'}});expect(persist).not.toHaveBeenCalled();});
	it('gives the live D1 override precedence over the versioned environment flag',async()=>{expect(await getV2PublicationControl(boundaryEnv('true',()=> 'false'))).toMatchObject({enabled:false,source:'d1'});});
});
