import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import type { WorkerEnv } from '../types/env';
import type { NormalizedWineEvent } from './event-normalizer';
import type { AgentSubmissionItem } from './agent-submission-repository';

const mocks=vi.hoisted(()=>({saveWineEvent:vi.fn(),findCandidateEvents:vi.fn()}));
vi.mock('./event-repository',()=>({saveWineEvent:mocks.saveWineEvent,findCandidateEvents:mocks.findCandidateEvents}));

import { persistEditorialEvent,type EditorialProposal,type PreparedSubmissionContext } from './wine-scout-editorial-agent';

const source:AgentSubmissionItem={id:'item-1',submissionId:'submission-1',sourceMessageId:'message-1',webhookEventId:'webhook-1',itemType:'image',assetId:'asset-1',intakeId:'intake-1',r2ObjectKey:'intakes/intake-1/assets/asset-1/original',contentType:'image/jpeg',textContent:null,sourceUrl:null,ordinal:1,receivedAt:'2026-08-13T00:00:00.000Z'};
const prepared:PreparedSubmissionContext={submissionId:'submission-1',items:[source],labels:{'item-1':'IMAGE_1'},contexts:[],imageDiagnostics:[],urlDiagnostics:[],contextR2Key:'context'};
const proposal={event:{title:'Bangkok Burgundy Dinner'},assetRoles:[{assetId:'asset-1',role:'main'}]} as EditorialProposal;
const normalized={title:undefined,date:'2026-08-20',startTime:'19:00',priceTHB:3200,venue:'Le Venue Bangkok',contactEmail:null,contactPhone:null,wines:[],wineRegions:[],isWineEvent:true} as NormalizedWineEvent;
const identity={eventId:null,decision:'new',diagnostics:{}} as const;
const first=vi.fn().mockResolvedValue({slug:'bangkok-burgundy-dinner-2026-08-20'});
const db={prepare:vi.fn(()=>({bind:vi.fn(()=>({first}))}))} as unknown as D1Database;
const workerEnv={DB:db,ADMIN_LINE_USER_ID:'admin-user-id',LINE_CHANNEL_ACCESS_TOKEN:'line-token'} as WorkerEnv;

beforeEach(()=>{mocks.saveWineEvent.mockReset();first.mockClear();vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(null,{status:200})));});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('new-event admin LINE notification',()=>{
	it('sends the requested message to only ADMIN_LINE_USER_ID after a new event is created',async()=>{mocks.saveWineEvent.mockResolvedValue({id:'event-1',duplicate:false});await persistEditorialEvent(workerEnv,'submission-1',prepared,proposal,normalized,identity);expect(fetch).toHaveBeenCalledOnce();const [url,request]=(fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string,RequestInit];expect(url).toBe('https://api.line.me/v2/bot/message/push');expect(JSON.parse(request.body as string)).toEqual({to:'admin-user-id',messages:[{type:'text',text:'🍷 New event posted\n\nBangkok Burgundy Dinner\n2026-08-20 · Le Venue Bangkok\n\nhttps://bangkokwinescout.com/events/bangkok-burgundy-dinner-2026-08-20'}]});});
	it('does not notify when persistence updates an existing event',async()=>{mocks.saveWineEvent.mockResolvedValue({id:'event-1',duplicate:true});await persistEditorialEvent(workerEnv,'submission-1',prepared,proposal,normalized,{eventId:'event-1',decision:'update',diagnostics:{}});expect(fetch).not.toHaveBeenCalled();expect(first).not.toHaveBeenCalled();});
	it('does not fail event creation when LINE notification fails',async()=>{mocks.saveWineEvent.mockResolvedValue({id:'event-1',duplicate:false});vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('LINE unavailable',{status:500})));vi.spyOn(console,'error').mockImplementation(()=>undefined);await expect(persistEditorialEvent(workerEnv,'submission-1',prepared,proposal,normalized,identity)).resolves.toEqual({eventId:'event-1',updated:false});});
});
