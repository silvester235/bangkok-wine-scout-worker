import { normalizeWineEvent } from "../src/services/event-normalizer";

const MODEL = "@cf/mistralai/mistral-small-3.1-24b-instruct";

const DEFAULT_TEXT = `Event by Spectrum Lounge & Bar

Spectrum Lounge & Bar

Public · Anyone on or off Facebook

🍷✨ Embark on a journey through Italy's most celebrated wine regions!

From the sparkling hills of Veneto to the sun-drenched vineyards of Sicily and the iconic estates of Tuscany, get ready for an unforgettable evening. Discover 11 exceptional wines that beautifully showcase the diversity, heritage, and world-class craftsmanship of Italian winemaking.

🗓 26 August 2026

📍 Spectrum Rooftop · Hyatt Regency Bangkok Sukhumvit

🎟️ Secure your spot and shop now: https://bit.ly/augpvts`;

const TASK = `Analyze the supplied wine-event flyer and accompanying text together.
Extract all event information available from either source.
Do not invent missing information.

Return ONLY one raw JSON object.
Do not use Markdown.
Do not use \`\`\`json code fences.
Do not add commentary before or after the JSON.
Do not explain your reasoning.
The first character of your response must be {
The last character of your response must be }

Use exactly this structure:

{
  "title": null,
  "date": null,
  "start_time": null,
  "end_time": null,
  "venue": null,
  "hotel": null,
  "organizer": null,
  "partners": [],
  "price": null,
  "currency": null,
  "description": null,
  "booking_url": null,
  "phone": null,
  "wine_count": null,
  "food": null,
  "notes": []
}

If a value is not supported by the flyer or accompanying text, use null or [] as appropriate.`;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export default {
  async fetch(request: Request, env: { AI: any }): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("POST multipart/form-data with a JPG/PNG field named 'flyer' and optional text field named 'text'.", { status: 405 });
    }

    const form = await request.formData();
    const flyer = form.get("flyer");
    const inputText = String(form.get("text") || DEFAULT_TEXT);

    if (!(flyer instanceof File) || !["image/jpeg", "image/png"].includes(flyer.type)) {
      return new Response("'flyer' must be a JPG or PNG file.", { status: 400 });
    }

    const dataUrl = `data:${flyer.type};base64,${bytesToBase64(new Uint8Array(await flyer.arrayBuffer()))}`;
    const result = await env.AI.run(MODEL, {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: `${TASK}\n\nACCOMPANYING TEXT:\n${inputText}` },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      }],
      max_tokens: 1200,
      temperature: 0,
    });
    const response = result?.response;
    const raw = typeof response === "string"
      ? response
      : response !== null && typeof response === "object"
        ? JSON.stringify(response, null, 2)
        : String(response ?? "");
    let parsed: unknown;
    if (response !== null && typeof response === "object") {
      parsed = response;
    } else if (typeof response === "string") {
      try {
        parsed = JSON.parse(response);
      } catch {
        parsed = undefined;
      }
    }

    const modelEvent = parsed as Record<string, unknown> | undefined;
    const normalized = modelEvent === undefined ? undefined : normalizeWineEvent({
      isWineEvent: true,
      date: modelEvent.date as string | null,
      startTime: modelEvent.start_time as string | null,
      endTime: modelEvent.end_time as string | null,
      price: typeof modelEvent.price === "string" ? modelEvent.price : null,
      priceAmount: typeof modelEvent.price === "number" ? modelEvent.price : null,
      currency: modelEvent.currency as string | null,
      venue: modelEvent.venue as string | null,
      address: modelEvent.hotel as string | null,
      organizer: modelEvent.organizer as string | null,
      partners: modelEvent.partners as string[],
      contact: modelEvent.phone as string | null,
      contactPhone: modelEvent.phone as string | null,
      bookingUrl: modelEvent.booking_url as string | null,
      description: modelEvent.description as string | null,
      menu: modelEvent.food ? [modelEvent.food as string] : [],
      notes: modelEvent.notes as string[],
      wines: [],
    });

    const output = [
      "--- MODEL ---",
      MODEL,
      "",
      "--- INPUT TEXT ---",
      inputText,
      "",
      "--- RAW MODEL RESPONSE ---",
      raw,
      "",
      "--- MODEL PARSED JSON ---",
      parsed === undefined ? "INVALID JSON" : JSON.stringify(parsed, null, 2),
      "",
      "--- EXTRACTED TITLE ---",
      modelEvent === undefined ? "SKIPPED: INVALID JSON" : String(modelEvent.title ?? ""),
      "",
      "--- NORMALIZED EVENT ---",
      normalized === undefined ? "SKIPPED: INVALID JSON" : JSON.stringify(normalized, null, 2),
      "",
      "--- MATCHER RESULT ---",
      "SKIPPED: existing candidates require a D1 read; the isolated test has no D1 binding.",
    ];

    if (result?.usage != null) {
      output.push("", "--- USAGE ---", JSON.stringify(result.usage, null, 2));
    }

    const report = output.join("\n");
    console.log(report);
    return new Response(report, { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
