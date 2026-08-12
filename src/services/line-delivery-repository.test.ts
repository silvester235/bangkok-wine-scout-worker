import { env } from 'cloudflare:test';
import { beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { claimLineAcknowledgement,claimLineDelivery,hashConversationIdentity,lineDeliveryId,recordLineDeliveryOutcome } from './line-delivery-repository';

beforeAll(async()=>{await env.DB.exec(`CREATE TABLE IF NOT EXISTS line_webhook_delivery_receipts(webhook_event_id TEXT PRIMARY KEY,message_id TEXT NOT NULL,message_type TEXT NOT NULL,conversation_id TEXT,batch_id TEXT,processing_outcome TEXT NOT NULL,processing_claimed_at TEXT NOT NULL,acknowledgement_claimed_at TEXT,delivery_stage TEXT NOT NULL DEFAULT 'registered',registration_completed_at TEXT,dispatch_pending_at TEXT,dispatched_at TEXT,handoff_completed_at TEXT,acknowledgement_outcome TEXT,acknowledgement_updated_at TEXT,last_progress_at TEXT,reconciliation_reason TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE UNIQUE INDEX IF NOT EXISTS delivery_test_message ON line_webhook_delivery_receipts(message_type,message_id);`);});
beforeEach(async()=>{await env.DB.prepare('DELETE FROM line_webhook_delivery_receipts').run();});

describe('LINE delivery receipts',()=>{
	it('claims a delivery and acknowledgement exactly once',async()=>{const input={deliveryId:'webhook-1',messageId:'message-1',messageType:'image',conversationId:await hashConversationIdentity('user:private')};expect((await claimLineDelivery(env.DB,input)).claimed).toBe(true);await recordLineDeliveryOutcome(env.DB,input.deliveryId,'registered','batch-1');expect((await claimLineDelivery(env.DB,input)).duplicate).toBe(true);const acknowledgements=await Promise.all([claimLineAcknowledgement(env.DB,input.deliveryId),claimLineAcknowledgement(env.DB,input.deliveryId)]);expect(acknowledgements.filter(Boolean)).toHaveLength(1);});
	it('uses message identity when webhook identity is unavailable',()=>{expect(lineDeliveryId(undefined,'text','m1')).toBe('message:text:m1');});
	it('stores only a hash for conversation correlation',async()=>{const hash=await hashConversationIdentity('user:private');expect(hash).toMatch(/^[a-f0-9]{64}$/);expect(hash).not.toContain('private');});
});
