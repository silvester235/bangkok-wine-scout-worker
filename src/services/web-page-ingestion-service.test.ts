import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectPrimaryWebUrl, fetchAndExtractWebPage, normalizeWebUrl } from './web-page-ingestion-service';

const options={timeoutMs:1000,maxRedirects:2,maxHtmlBytes:10_000,maxExtractedTextChars:1000,userAgent:'test',retryDelayMs:0};

afterEach(()=>vi.unstubAllGlobals());

describe('web URL detection and normalization',()=>{
	it('preserves surrounding context, strips punctuation and removes fragments',()=>{
		expect(detectPrimaryWebUrl('Please use https://Example.com/Event/AbC?ref=LINE#details, thanks')).toEqual({url:'https://Example.com/Event/AbC?ref=LINE#details',normalizedUrl:'https://example.com/Event/AbC?ref=LINE',contextText:'Please use , thanks'});
	});
	it('rejects non-public and non-HTTP destinations',()=>{
		expect(normalizeWebUrl('http://127.0.0.1/event')).toBeNull();
		expect(normalizeWebUrl('http://192.168.1.2/event')).toBeNull();
		expect(normalizeWebUrl('file:///etc/passwd')).toBeNull();
	});
});

describe('web page ingestion',()=>{
	it('extracts metadata, JSON-LD, relative images, and readable content',async()=>{
		vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(`<html><head><title> Wine Dinner </title><meta property="og:description" content="Five courses"><meta property="og:image" content="/hero.jpg"><link rel="canonical" href="/events/dinner"><script type="application/ld+json">{"@type":"Event","name":"Wine Dinner"}</script></head><body><nav>Menu</nav><main><h1>Wine Dinner</h1><p>5 August 2026 at 7 PM</p></main></body></html>`,{status:200,headers:{'content-type':'text/html'}})));
		const result=await fetchAndExtractWebPage('https://example.com/source#top',options);
		expect(result).toEqual(expect.objectContaining({status:'completed',normalizedUrl:'https://example.com/source',title:'Wine Dinner',description:'Five courses',canonicalUrl:'https://example.com/events/dinner',mainImageUrl:'https://example.com/hero.jpg',jsonLd:[{'@type':'Event',name:'Wine Dinner'}]}));
		expect(result.extractedText).toContain('5 August 2026 at 7 PM');
	});
	it('checks every manual redirect and rejects a private target',async()=>{
		vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(null,{status:302,headers:{location:'http://127.0.0.1/admin'}})));
		const result=await fetchAndExtractWebPage('https://example.com/event',options);
		expect(result).toEqual(expect.objectContaining({status:'unsupported',errorCode:'unsafe_redirect'}));
	});
	it('rejects PDFs and oversized HTML',async()=>{
		vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response('pdf',{headers:{'content-type':'application/pdf'}})).mockResolvedValueOnce(new Response('x'.repeat(20_000),{headers:{'content-type':'text/html'}})));
		expect(await fetchAndExtractWebPage('https://example.com/a.pdf',options)).toEqual(expect.objectContaining({status:'unsupported',errorCode:'unsupported_content_type'}));
		expect(await fetchAndExtractWebPage('https://example.com/large',options)).toEqual(expect.objectContaining({status:'failed',errorCode:'response_too_large'}));
	});
	it('caps event-focused readable text and deduplicates JSON-LD',async()=>{const item={'@type':'Event',name:'Wine Dinner',startDate:'2026-08-12'};const repeated='Wine dinner menu booking 12 August 2026 '.repeat(300);vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(`<title>Dinner</title><script type="application/ld+json">${JSON.stringify(item)}</script><script type="application/ld+json">${JSON.stringify(item)}</script><main>${repeated}</main>`,{headers:{'content-type':'text/html'}})));const result=await fetchAndExtractWebPage('https://example.com/event',{...options,maxHtmlBytes:50_000,maxExtractedTextChars:40_000});expect(result.extractedTextLength).toBeLessThanOrEqual(5_000);expect(result.textReduced).toBe(true);expect(result.jsonLd).toEqual([item]);});
	it('returns a structured parser failure when HTML yields no usable content',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('<html><head></head><body><script>app()</script></body></html>',{headers:{'content-type':'text/html'}})));expect(await fetchAndExtractWebPage('https://example.com/empty',options)).toEqual(expect.objectContaining({status:'failed',errorCode:'PARSER_EMPTY',title:null,description:null,jsonLd:[],extractedText:null}));});
	it('retries one empty 202 without a content type and completes from a fresh useful 200 response',async()=>{const fetchMock=vi.fn().mockResolvedValueOnce(new Response('',{status:202})).mockResolvedValueOnce(new Response('<title>Wine Dinner</title><main>12 August 2026 wine tasting</main>',{status:200,headers:{'content-type':'text/html'}}));vi.stubGlobal('fetch',fetchMock);const result=await fetchAndExtractWebPage('https://example.com/event',options);expect(result).toEqual(expect.objectContaining({status:'completed',attemptNumber:2,retryPerformed:true,retryReason:'202_empty_or_short_parser_empty',firstStatus:202,secondStatus:200,firstResponseBytes:0,firstParserStatus:'empty',secondParserStatus:'useful',errorCode:null}));expect(fetchMock).toHaveBeenCalledTimes(2);expect(fetchMock.mock.calls[0][1].headers['User-Agent']).toBe(fetchMock.mock.calls[1][1].headers['User-Agent']);});
	it('returns TRANSIENT_EMPTY_RESPONSE after two empty 202 responses',async()=>{const fetchMock=vi.fn().mockImplementation(async()=>new Response('',{status:202,headers:{'content-type':'text/html'}}));vi.stubGlobal('fetch',fetchMock);const result=await fetchAndExtractWebPage('https://example.com/event',options);expect(result).toEqual(expect.objectContaining({status:'failed',attemptNumber:2,retryPerformed:true,firstStatus:202,secondStatus:202,firstParserStatus:'empty',secondParserStatus:'empty',errorCode:'TRANSIENT_EMPTY_RESPONSE'}));expect(fetchMock).toHaveBeenCalledTimes(2);});
	it('accepts a useful 202 without retrying',async()=>{const fetchMock=vi.fn().mockResolvedValue(new Response('<title>Wine Dinner</title><main>12 August 2026 wine event</main>',{status:202,headers:{'content-type':'text/html'}}));vi.stubGlobal('fetch',fetchMock);const result=await fetchAndExtractWebPage('https://example.com/event',options);expect(result).toEqual(expect.objectContaining({status:'completed',attemptNumber:1,retryPerformed:false,firstStatus:202,firstParserStatus:'useful'}));expect(fetchMock).toHaveBeenCalledOnce();});
	it('does not retry an empty 200 response',async()=>{const fetchMock=vi.fn().mockResolvedValue(new Response('',{status:200,headers:{'content-type':'text/html'}}));vi.stubGlobal('fetch',fetchMock);const result=await fetchAndExtractWebPage('https://example.com/event',options);expect(result).toEqual(expect.objectContaining({status:'failed',attemptNumber:1,retryPerformed:false,firstStatus:200,errorCode:'EMPTY_HTML_RESPONSE'}));expect(fetchMock).toHaveBeenCalledOnce();});
});
