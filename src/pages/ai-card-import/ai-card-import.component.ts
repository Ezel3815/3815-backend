import { Component } from "@angular/core";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { HttpClient } from "@angular/common/http";
import { firstValueFrom } from "rxjs";
import { ENV } from "../../environments/environment";
import { AuthService } from "../../services/http-services/auth.service";

interface DraftCard {
    question: string;
    answer: string;
    suggested_deck: string;
    status: "pending" | "saving" | "saved" | "error";
    msg: string;
}

@Component({
    selector: "app-ai-card-import",
    standalone: true,
    imports: [CommonModule, FormsModule],
    template: `
        <div class="bar">
            <label>Gemini API key (free, from aistudio.google.com)
                <input [(ngModel)]="apiKey" (ngModelChange)="saveKey()" type="password" style="width:260px" />
            </label>
            <label>Deck
                <select [(ngModel)]="deckId" style="min-width:220px" dir="rtl">
                    <option [ngValue]="null">Choose a deck…</option>
                    @for (d of deckOptions; track d.id) {
                        <option [ngValue]="d.id">{{ d.label }}</option>
                    }
                </select>
            </label>
            <label>File (image or PDF)
                <input type="file" accept="application/pdf,image/*" (change)="onFile($event)" />
            </label>
            <button (click)="extract()" [disabled]="busy || !file || !apiKey">
                {{ busy ? "Extracting…" : "Extract Cards" }}
            </button>
        </div>

        @if (error) {
            <p class="warn">{{ error }}</p>
        }

        @if (drafts.length) {
            <p class="info">{{ drafts.length }} draft cards. Edit anything wrong, then approve.</p>
            <div class="actions">
                <button class="primary" (click)="approveAll()" [disabled]="saving || !deckId">
                    Approve all ({{ pendingCount() }})
                </button>
                @if (!deckId) { <span class="warn">Pick a deck first</span> }
            </div>
            <div class="grid">
                @for (c of drafts; track c; let i = $index) {
                    <div class="card" [class.done]="c.status === 'saved'" [class.err]="c.status === 'error'">
                        <div class="small">Deck guess: {{ c.suggested_deck || "—" }}</div>
                        <label class="small">Front
                            <textarea [(ngModel)]="c.question" rows="3" dir="auto"></textarea>
                        </label>
                        <label class="small">Back
                            <textarea [(ngModel)]="c.answer" rows="3" dir="auto"></textarea>
                        </label>
                        <div class="row">
                            <button (click)="approveOne(c)" [disabled]="c.status === 'saving' || c.status === 'saved' || !deckId">
                                {{ c.status === 'saved' ? '✓ Saved' : 'Approve' }}
                            </button>
                            <button (click)="drafts.splice(i, 1)" [disabled]="c.status === 'saving'">Reject</button>
                        </div>
                        @if (c.msg) { <div class="small" [class.ok]="c.status === 'saved'">{{ c.msg }}</div> }
                    </div>
                }
            </div>
        }
    `,
    styles: [
        `
            .bar { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 12px; }
            .bar label { display: flex; flex-direction: column; font-size: 12px; gap: 2px; }
            .info { font-size: 13px; } .warn { color: #b26a00; font-size: 13px; }
            .actions { display: flex; gap: 12px; align-items: center; padding: 8px 0; }
            .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
            .card { border: 3px solid #90caf9; border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 6px; background: #fff; }
            .card.done { border-color: #1565c0; } .card.err { border-color: #c62828; }
            .card textarea { width: 100%; font-size: 13px; }
            .small { font-size: 11px; color: #666; display: flex; flex-direction: column; gap: 2px; }
            .ok { color: #2e7d32; font-weight: 700; }
            .row { display: flex; gap: 6px; }
            button { cursor: pointer; padding: 6px 10px; }
            .primary { background: #43a047; color: #fff; border: 0; border-radius: 4px; }
        `,
    ],
})
export class AiCardImportComponent {
    apiKey = "";
    deckId: number | null = null;
    deckOptions: { id: number; label: string }[] = [];
    file: File | null = null;
    busy = false;
    saving = false;
    error = "";
    drafts: DraftCard[] = [];

    private readonly GEMINI_MODEL = "gemini-2.0-flash-lite";
    private readonly PROMPT = `
You are helping build flashcards for a medical-education app from the attached document/image.
Read all the content and extract the important, testable facts as flashcards.
Skip filler text, headers, and anything too trivial to quiz on.
Prefer clear, atomic questions (one fact per card) over broad ones.

Return ONLY a JSON array, no markdown fences, no commentary, in this exact shape:
[
  { "question": "...", "answer": "...", "suggested_deck": "..." }
]
"suggested_deck" is a short topic guess (e.g. "Cardiology"), just for your own reference.
`.trim();

    constructor(
        private http: HttpClient,
        private auth: AuthService,
    ) {
        try {
            this.apiKey = localStorage.getItem("gemini_api_key") || "";
        } catch {}
        this.loadDecks();
    }

    saveKey() {
        try {
            localStorage.setItem("gemini_api_key", this.apiKey);
        } catch {}
    }

    async loadDecks() {
        const roots: any[] = await firstValueFrom(
            this.http.get<any[]>(`${ENV.BASE_URL}/decks/hierarchy`),
        );
        const flat: { id: number; label: string }[] = [];
        const walk = (d: any, depth: number) => {
            flat.push({ id: d.id, label: "— ".repeat(depth) + d.title });
            for (const c of d.children ?? []) walk(c, depth + 1);
        };
        for (const d of roots ?? []) walk(d, 0);
        this.deckOptions = flat;
    }

    onFile(e: Event) {
        const input = e.target as HTMLInputElement;
        this.file = input.files?.[0] ?? null;
    }

    pendingCount() {
        return this.drafts.filter((d) => d.status === "pending" || d.status === "error").length;
    }

    private fileToBase64(file: File): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    async extract() {
        if (!this.file) return;
        this.busy = true;
        this.error = "";
        try {
            const base64 = await this.fileToBase64(this.file);
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.GEMINI_MODEL}:generateContent?key=${this.apiKey}`;
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [
                        {
                            parts: [
                                { text: this.PROMPT },
                                { inline_data: { mime_type: this.file.type, data: base64 } },
                            ],
                        },
                    ],
                    generationConfig: { temperature: 0.2 },
                }),
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message || `Gemini error ${res.status}`);

            const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
            const cleaned = rawText.replace(/```json|```/g, "").trim();
            const cards: { question: string; answer: string; suggested_deck?: string }[] = JSON.parse(cleaned);

            this.drafts = [
                ...this.drafts,
                ...cards.map((c) => ({
                    question: c.question,
                    answer: c.answer,
                    suggested_deck: c.suggested_deck ?? "",
                    status: "pending" as const,
                    msg: "",
                })),
            ];
            this.file = null;
        } catch (e: any) {
            this.error = "Extraction failed: " + String(e?.message || e);
        } finally {
            this.busy = false;
        }
    }

    async approveOne(c: DraftCard) {
        if (!this.deckId) return;
        c.status = "saving";
        c.msg = "";
        try {
            const body = {
                type: "BASIC",
                data: {
                    front: { text: c.question, size: 14, align: "center" },
                    back: { text: c.answer, size: 14, align: "center" },
                },
            };
            const res = await fetch(`${ENV.BASE_URL}/cards/${this.deckId}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `${this.auth.getToken()}`,
                },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(`save failed (${res.status})`);
            c.status = "saved";
        } catch (e: any) {
            c.status = "error";
            c.msg = String(e?.message || e);
        }
    }

    async approveAll() {
        this.saving = true;
        for (const c of this.drafts) {
            if (c.status === "pending" || c.status === "error") await this.approveOne(c);
        }
        this.drafts = this.drafts.filter((d) => d.status !== "saved");
        this.saving = false;
    }
}
