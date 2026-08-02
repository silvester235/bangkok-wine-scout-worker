import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectPrimaryWebUrl, fetchAndExtractWebPage, normalizeWebUrl } from './web-page-ingestion-service';

const options={timeoutMs:1000,maxRedirects:2,maxHtmlBytes:10_000,maxExtractedTextChars:1000,userAgent:'test'};

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
});
