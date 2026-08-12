import type { WorkerEnv } from '../types/env';
import { readSubmission, setWorkflowInstance } from './agent-submission-repository';

const COMPONENT='agent_submission_v2';
const PROCESSING_STALE_MS=5*60_000;
type Candidate={id:string;status:'collecting'|'queued'|'processing';last_received_at:string;updated_at:string;workflow_instance_id:string|null};
const log=(level:'log'|'warn'|'error',fields:Record<string,unknown>)=>console[level](JSON.stringify({component:COMPONENT,...fields}));
const errorMessage=(error:unknown)=>error instanceof Error?error.message:String(error);

export async function ensureAgentSubmissionWorkflow(env:WorkerEnv,submissionId:string,source:'webhook'|'reconciliation'='webhook'):Promise<{instanceId:string;action:string;status:string}> {
	if(!env.WINE_SCOUT_SUBMISSION_WORKFLOW)throw new Error('WINE_SCOUT_SUBMISSION_WORKFLOW binding is required');
	const submission=await readSubmission(env.DB,submissionId);if(!submission)throw new Error('submission_not_found');
	const instanceId=submission.workflowInstanceId??submissionId;
	let instance:WorkflowInstance;let action='created';
	try{instance=submission.workflowInstanceId?await env.WINE_SCOUT_SUBMISSION_WORKFLOW.get(instanceId):await env.WINE_SCOUT_SUBMISSION_WORKFLOW.create({id:instanceId,params:{submissionId}});}
	catch(createError){
		try{instance=await env.WINE_SCOUT_SUBMISSION_WORKFLOW.get(instanceId);action='recovered_existing';}
		catch(getError){log('error',{event:'analysis_enqueue_result',submissionId,workflowInstanceId:instanceId,source,outcome:'failed',errorCode:errorMessage(createError),recoveryError:errorMessage(getError)});throw createError;}
	}
	await setWorkflowInstance(env.DB,submissionId,instance.id);
	const state=await instance.status();
	if(state.status==='errored'||state.status==='terminated'){await instance.restart();action='restarted';}
	else if(state.status==='paused'){await instance.resume();action='resumed';}
	else if(state.status==='complete'&& !['published','needs_review','failed'].includes(submission.status)){await instance.restart();action='restarted_complete_without_terminal_state';}
	else if(state.status==='running'||state.status==='waiting')try{await instance.sendEvent({type:'submission-updated',payload:{submissionId}});action='signalled';}catch(error){log('warn',{event:'analysis_signal_failed',submissionId,workflowInstanceId:instance.id,source,errorCode:errorMessage(error)});}
	log('log',{event:'analysis_enqueue_result',submissionId,workflowInstanceId:instance.id,source,outcome:'success',action,workflowStatus:state.status});
	return{instanceId:instance.id,action,status:state.status};
}

export async function runAgentSubmissionReconciliation(env:WorkerEnv,{limit=25,now=new Date().toISOString()}:{limit?:number;now?:string}={}):Promise<{selected:number;recovered:number;skipped:number;failed:number}> {
	const collectingCutoff=new Date(Date.parse(now)-Number(env.AGENT_SUBMISSION_WINDOW_SECONDS||'60')*1000).toISOString();
	const processingCutoff=new Date(Date.parse(now)-PROCESSING_STALE_MS).toISOString();
	const rows=await env.DB.prepare(`SELECT id,status,last_received_at,updated_at,workflow_instance_id FROM agent_submissions
		WHERE (status='collecting' AND last_received_at<=?) OR status='queued' OR (status='processing' AND updated_at<=?)
		ORDER BY updated_at,id LIMIT ?`).bind(collectingCutoff,processingCutoff,limit).all<Candidate>();
	const candidates=rows.results??[];
	log('log',{event:'reconciliation_scan_result',resultCount:candidates.length,selectedSubmissionIds:candidates.map(row=>row.id),limit});
	let recovered=0,skipped=0,failed=0;
	for(const candidate of candidates)try{
		if(candidate.status==='collecting'){
			const changed=await env.DB.prepare("UPDATE agent_submissions SET status='queued',closed_at=?,closure_reason='reconciliation_inactivity_timeout',updated_at=? WHERE id=? AND status='collecting' AND last_received_at=?").bind(now,now,candidate.id,candidate.last_received_at).run();
			if(!(changed.meta.changes??0)){skipped++;log('warn',{event:'reconciliation_submission_skipped',submissionId:candidate.id,reason:'state_changed_during_claim'});continue;}
		}
		if(candidate.status==='processing'){
			if(!candidate.workflow_instance_id){skipped++;log('warn',{event:'reconciliation_submission_skipped',submissionId:candidate.id,reason:'processing_without_workflow_instance_requires_manual_review'});continue;}
			const instance=await env.WINE_SCOUT_SUBMISSION_WORKFLOW!.get(candidate.workflow_instance_id);const state=await instance.status();
			if(state.status==='running'||state.status==='waiting'||state.status==='queued'){skipped++;log('warn',{event:'reconciliation_submission_skipped',submissionId:candidate.id,reason:'workflow_active',workflowStatus:state.status});continue;}
			await instance.restart();recovered++;log('log',{event:'analysis_enqueue_result',submissionId:candidate.id,workflowInstanceId:instance.id,source:'reconciliation',outcome:'success',action:'restarted',workflowStatus:state.status});continue;
		}
		await ensureAgentSubmissionWorkflow(env,candidate.id,'reconciliation');recovered++;
	}catch(error){failed++;log('error',{event:'reconciliation_submission_failed',submissionId:candidate.id,reason:'workflow_handoff_failed',errorCode:errorMessage(error)});}
	log('log',{event:'reconciliation_scan_completed',resultCount:candidates.length,recovered,skipped,failed});return{selected:candidates.length,recovered,skipped,failed};
}
