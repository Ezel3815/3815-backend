// Small shared helper: one Gemini call that must answer in JSON.
// Retries when Gemini is busy, tells you if the answer was cut off,
// and rescues the complete part of a cut-off JSON answer.

export interface GeminiJsonOptions {
    apiKey: string;
    model: string;
    prompt: string;
    schema?: any;
    file?: { base64: string; mime: string };
    files?: { base64: string; mime: string }[]; // extra pictures (Gemini / Claude keys only)
    maxTokens?: number;
    fast?: boolean; // key-pool mode: no long waits, report 429 at once so the next key can be used
}

// Tries the preferred model first, then falls back to others when Google says
// "high demand" (503), "rate limit" (429), "error" (500) or "model not found" (404).
// If the key starts with "sk-ant-" it is a Claude (Anthropic) key: call Claude instead
// and return the answer in Gemini's shape so the rest of the app works unchanged.
const CLAUDE_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"];

async function claudeFetch(apiKey: string, body: any, preferred?: string): Promise<Response> {
    const parts: any[] = body?.contents?.[0]?.parts ?? [];
    const content: any[] = [];
    for (const p of parts) {
        if (p.inline_data) {
            const mime: string = p.inline_data.mime_type;
            content.push(
                mime === "application/pdf"
                    ? { type: "document", source: { type: "base64", media_type: mime, data: p.inline_data.data } }
                    : { type: "image", source: { type: "base64", media_type: mime, data: p.inline_data.data } }
            );
        }
    }
    for (const p of parts) if (p.text) content.push({ type: "text", text: p.text + "\n\nReturn ONLY valid JSON, no markdown fences, no commentary." });
    let last: Response | undefined;
    let netErr = "";
    const order = preferred?.startsWith("claude-") ? [preferred, ...CLAUDE_MODELS.filter((x) => x !== preferred)] : CLAUDE_MODELS;
    for (const m of order) {
        try {
            last = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-api-key": apiKey,
                    "anthropic-version": "2023-06-01",
                    
                },
                body: JSON.stringify({
                    model: m,
                    max_tokens: Math.min(body?.generationConfig?.maxOutputTokens ?? 8192, 16000),
                    temperature: 0.2,
                    messages: [{ role: "user", content }],
                }),
            });
        } catch (e: any) {
            netErr = String(e?.message || e);
            continue;
        }
        if (![404, 429, 500, 503, 529].includes(last.status)) break;
    }
    if (!last) throw new Error(`Could not reach Claude (${netErr}).`);
    const j: any = await last.json();
    if (!last.ok) {
        return new Response(JSON.stringify({ error: { message: j?.error?.message || `Claude error ${last.status}` } }), { status: last.status });
    }
    const text = (j.content ?? []).map((x: any) => x?.text ?? "").join("");
    return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: j.stop_reason === "max_tokens" ? "MAX_TOKENS" : "STOP" }] }),
        { status: 200 }
    );
}

// Key typed as "mistral:YOUR_KEY" -> use Mistral (free tier): PDFs are read with Mistral OCR,
// then Mistral writes the cards. Answer is returned in Gemini's shape so the app works unchanged.
const ocrCache = new Map<string, string>();

async function mistralPost(apiKey: string, path: string, payload: any): Promise<Response> {
    let res!: Response;
    for (let i = 0; i < 3; i++) {
        res = await fetch("https://api.mistral.ai/v1/" + path, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
            body: JSON.stringify(payload),
        });
        if (![429, 500, 502, 503].includes(res.status)) break;
        await new Promise((r) => setTimeout(r, 3000));
    }
    return res;
}

const errRes = (status: number, message: string) => new Response(JSON.stringify({ error: { message } }), { status });

async function mistralFetch(apiKey: string, body: any): Promise<Response> {
    try {
        const parts: any[] = body?.contents?.[0]?.parts ?? [];
        const prompt = parts.filter((p) => p.text).map((p) => p.text).join("\n\n");
        const file = parts.find((p) => p.inline_data)?.inline_data;
        const content: any[] = [];
        let docText = "";
        if (file?.mime_type === "application/pdf") {
            const key = file.data.length + file.data.slice(0, 64) + file.data.slice(-64);
            if (!ocrCache.has(key)) {
                const r = await mistralPost(apiKey, "ocr", {
                    model: "mistral-ocr-latest",
                    document: { type: "document_url", document_url: "data:application/pdf;base64," + file.data },
                });
                const j: any = await r.json();
                if (!r.ok) return errRes(r.status, "Mistral OCR: " + (j?.message || j?.error?.message || r.status));
                ocrCache.set(key, (j.pages ?? []).map((pg: any, i: number) => `--- Page ${i + 1} ---\n${pg.markdown}`).join("\n\n"));
            }
            docText = ocrCache.get(key)!;
        } else if (file) {
            content.push({ type: "image_url", image_url: `data:${file.mime_type};base64,${file.data}` });
        }
        content.push({
            type: "text",
            text: prompt + (docText ? "\n\nDocument content:\n" + docText : "") + "\n\nReturn ONLY valid JSON, no markdown fences, no commentary.",
        });
        const r = await mistralPost(apiKey, "chat/completions", {
            model: "mistral-small-latest",
            temperature: 0.2,
            max_tokens: Math.min(body?.generationConfig?.maxOutputTokens ?? 8192, 8192),
            messages: [{ role: "user", content }],
        });
        const j: any = await r.json();
        if (!r.ok) return errRes(r.status, "Mistral: " + (j?.message || j?.error?.message || r.status));
        const choice = j.choices?.[0];
        const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
        return new Response(
            JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: choice?.finish_reason === "length" ? "MAX_TOKENS" : "STOP" }] }),
            { status: 200 }
        );
    } catch (e: any) {
        throw new Error(`Could not reach Mistral (${String(e?.message || e)}).`);
    }
}

// Order matters: the NEWEST models (3.8, 3.6) are the ones everybody hammers, so they
// answer "high demand" (503) most often. Start with the stable ones, newest last.
export const GEMINI_FALLBACKS = ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.6-flash", "gemini-3.8-flash"];

export async function geminiFetch(apiKey: string, model: string, body: any, fast = false): Promise<Response> {
    if (apiKey.trim().toLowerCase().startsWith("mistral:")) return mistralFetch(apiKey.trim().slice(8).trim(), body);
    if (apiKey.trim().startsWith("sk-ant-")) return claudeFetch(apiKey.trim(), body, model);
    const models = [model, ...GEMINI_FALLBACKS.filter((m) => m !== model)];
    let last: Response | undefined;
    let netErr = "";
    for (let round = 0; round < (fast ? 1 : 3); round++) {
        for (const m of models) {
            // 3.x models "think" by default, which makes them very slow: turn it off
            const b = m.startsWith("gemini-3")
                ? { ...body, generationConfig: { ...body.generationConfig, thinkingConfig: { thinkingLevel: "low" } } }
                : body;
            try {
                last = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(b),
                });
            } catch (e: any) {
                // browser-level network failure ("Load failed"): try the next model
                netErr = String(e?.message || e);
                continue;
            }
            if (![404, 429, 500, 503].includes(last.status)) return last;
        }
        if (!fast) await new Promise((r) => setTimeout(r, 4000 * (round + 1)));
    }
    if (last) return last;
    throw new Error(`Could not reach Google (${netErr}). Check your internet, turn off VPN/ad-blocker, or the file may be too big (keep it under ~15MB).`);
}

export async function geminiJson(o: GeminiJsonOptions): Promise<{ data: any; truncated: boolean }> {
    const parts: any[] = [{ text: o.prompt }];
    if (o.file) parts.push({ inline_data: { mime_type: o.file.mime, data: o.file.base64 } });
    for (const f of o.files ?? []) parts.push({ inline_data: { mime_type: f.mime, data: f.base64 } });

    {
        const res = await geminiFetch(o.apiKey, o.model, {
                contents: [{ parts }],
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: o.maxTokens ?? 8192,
                    responseMimeType: "application/json",
                    ...(o.schema ? { responseSchema: o.schema } : {}),
                },
            }, !!o.fast);
        const json = await res.json();
        if (res.ok) {
            const cand = json?.candidates?.[0];
            const raw: string = (cand?.content?.parts ?? []).map((x: any) => x?.text ?? "").join("");
            const truncated = cand?.finishReason === "MAX_TOKENS";
            const cleaned = raw.replace(/```json|```/g, "").trim();
            const end = cleaned.lastIndexOf("}");
            const tries = [cleaned];
            if (end > 0) {
                const cut = cleaned.slice(0, end + 1).replace(/,\s*$/, "");
                tries.push(cut + "]", cut + "]}");
            }
            for (const t of tries) {
                try {
                    return { data: JSON.parse(t), truncated };
                } catch {}
            }
            throw new Error("The AI returned an unreadable answer. Try again.");
        }
        throw Object.assign(new Error(json?.error?.message || `Gemini error ${res.status}`), { status: res.status });
    }
}
