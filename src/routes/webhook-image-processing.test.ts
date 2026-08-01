import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerEnv } from '../types/env';
import { processImageMessage, type ImageProcessingMessage } from './webhook';

const mocks=vi.hoisted(()=>({download:vi.fn(),store:vi.fn(),register:vi.fn()}));
vi.mock('../services/line',()=>({downloadLineMessageContent:mocks.download,pushToLine:vi.fn(),replyToLine:vi.fn()}));
vi.mock('../services/event-intake',()=>({storeLineImageAsset:mocks.store}));
vi.mock('../services/line-image-batch-repository',()=>({registerBatchAsset:mocks.register}));

const send=vi.fn();
const env={LINE_CHANNEL_ACCESS_TOKEN:'token',EVENT_INTAKES:{},DB:{},AI:{},IMAGE_PROCESSING_QUEUE:{send},LINE_MESSAGE_BATCH_WINDOW_SECONDS:'60',LINE_IMAGE_BATCH_WINDOW_SECONDS:'15',LINE_TEXT_CONTEXT_WINDOW_SECONDS:'600'} as unknown as WorkerEnv;
const message:ImageProcessingMessage={type:'register_image',messageId:'m1',conversationKey:'user:u1',pushTarget:'u1',receivedAt:'2026-08-01T00:00:00.000Z'};

beforeEach(()=>{vi.clearAllMocks();mocks.download.mockResolvedValue({contentType:'image/jpeg',content:new Uint8Array([1]).buffer});mocks.store.mockResolvedValue({intakeId:'i1',assetId:'a1',objectKey:'objects/a1',duplicate:false});mocks.register.mockResolvedValue({batch:{id:'b1',lastReceivedAt:message.receivedAt},duplicate:false});send.mockResolvedValue(undefined)});

describe('LINE image registration',()=>{
	it('stores and registers an image, then schedules one delayed batch check',async()=>{await processImageMessage(message,env);expect(mocks.register).toHaveBeenCalledWith(env.DB,expect.objectContaining({lineMessageId:'m1',assetId:'a1',conversationKey:'user:u1'}));expect(send).toHaveBeenCalledWith({type:'process_batch',batchId:'b1',expectedLastReceivedAt:message.receivedAt},{delaySeconds:60})});
	it('does not reschedule a duplicate webhook delivery',async()=>{mocks.register.mockResolvedValue({batch:{id:'b1',lastReceivedAt:message.receivedAt},duplicate:true});await processImageMessage(message,env);expect(send).not.toHaveBeenCalled()});
});
