import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { TableColumn } from "../../models/table-request.model";
import { MatDialog } from "@angular/material/dialog";
import { ENV } from "../../environments/environment";
import { Observable, firstValueFrom } from "rxjs";
import { ObjectToHttpParams } from "../../utils/http.utils";
import { DecksService } from "./decks.service";

@Injectable({ providedIn: "root" })
export class CodesService {
    URL = `${ENV.BASE_URL}/codes`;

    constructor(private _httpClient: HttpClient) {}

    read(page: number): Observable<any> {
        return this._httpClient.get(`${this.URL}`, {
            params: ObjectToHttpParams({
                skip: page * 15,
                limit: 15,
            }),
        });
    }

    create(data: any): Observable<any> {
        return this._httpClient.post(`${this.URL}/`, data);
    }

    /**
     * VIP code: ONE code linked to every admin deck that exists right now
     * (a snapshot, so decks created later are not included) and limited to
     * `maxUses` students. The limit is sent as `max_uses` and must be enforced
     * by the backend when a student redeems the code.
     */
    async createVip(
        code: string,
        maxUses: number,
    ): Promise<{ code: string; decks: number }> {
        const decks = await new DecksService(this._httpClient).readAll();
        const ids = decks.map((d: any) => d.id);
        if (!ids.length) throw new Error("There are no decks to link.");
        // The admin always chooses the code (the server needs 6-20 characters).
        const finalCode = code.trim();
        if (finalCode.length < 6 || finalCode.length > 20)
            throw new Error("The code must be 6 to 20 characters.");
        const created: any = await firstValueFrom(
            this.create({ code: finalCode, decks_ids: ids, max_uses: maxUses }),
        );
        // An old backend silently ignores max_uses and makes a normal single-use code.
        if (created?.max_uses !== maxUses) {
            throw new Error(
                "The server did not save the usage limit (it is running an old backend version). " +
                    "Deploy the updated backend, then delete this code and create it again.",
            );
        }
        return { code: finalCode, decks: ids.length };
    }

    private randomCode(len: number): string {
        const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alike characters
        const buf = new Uint32Array(len);
        crypto.getRandomValues(buf);
        return Array.from(buf, (n) => chars[n % chars.length]).join("");
    }

    generate(data: any): Observable<any> {
        return this._httpClient.post(`${this.URL}/create-multi-code`, data);
    }

   
    /**
     * Generates codes and returns ONLY the ones this call created.
     * Uses the server response when it lists the codes; otherwise it compares
     * the table before/after (ids newer than anything that existed before).
     */
    async generateAndCollect(
        formData: any,
    ): Promise<{ code: string; decks: string; created_at: string }[]> {
        const toRow = (r: any) => ({
            code: typeof r === "string" ? r : String(r?.code ?? ""),
            decks: (r?.decks ?? [])
                .map((d: any) => d?.deck?.title)
                .filter(Boolean)
                .join(", "),
            created_at: String(r?.created_at ?? ""),
        });

        // snapshot of both ends of the table before generating
        const edges = async () => {
            const first: any = await firstValueFrom(this.read(0));
            const total = Number(first?.count ?? 0);
            const lastPage = Math.max(0, Math.ceil(total / 15) - 1);
            const last: any =
                lastPage > 0 ? await firstValueFrom(this.read(lastPage)) : first;
            return {
                total,
                lastPage,
                rows: [...(first?.data ?? []), ...(last?.data ?? [])] as any[],
            };
        };
        const before = await edges();

        const resp: any = await firstValueFrom(this.generate(formData));
        const list = Array.isArray(resp)
            ? resp
            : (resp?.codes ?? resp?.data ?? resp?.items ?? null);
        if (Array.isArray(list) && list.length && list.every((r: any) =>
            typeof r === "string" || r?.code)) {
            return list.map(toRow);
        }

        // fall back: read what is new
        const want = Number(formData?.count ?? 1);
        const after = await edges();
        const pages = new Set<number>([0, after.lastPage]);
        // include one more page at each end if the batch is bigger than a page
        for (let i = 1; i * 15 < want + 15; i++) {
            pages.add(i);
            pages.add(Math.max(0, after.lastPage - i));
        }
        const seen = new Map<any, any>();
        for (const pg of pages) {
            const r: any = await firstValueFrom(this.read(pg));
            for (const row of r?.data ?? []) seen.set(row.id, row);
        }
        const beforeIds = new Set(before.rows.map((r) => r.id));
        const numeric = before.rows.map((r) => Number(r.id)).filter((n) => !isNaN(n));
        const maxBefore = numeric.length ? Math.max(...numeric) : -Infinity;
        const fresh = [...seen.values()].filter((r) =>
            !isNaN(Number(r.id)) && isFinite(maxBefore)
                ? Number(r.id) > maxBefore
                : !beforeIds.has(r.id),
        );
        return fresh.sort((a, b) => Number(a.id) - Number(b.id)).map(toRow);
    }

    downloadCsv(): void {
        this._httpClient.get(`${this.URL}/export-csv`, { responseType: 'blob' }).subscribe({
          next: (data: Blob) => {
            const blob = new Blob([data], { type: 'text/csv;charset=utf-8;' });
            const downloadURL = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = downloadURL;
            link.download = 'codes.csv';
            link.click();
            window.URL.revokeObjectURL(downloadURL);
          },
          error: (err) => {
            console.error('Download failed', err);
          }
        });
      }

    update(id: number, data: any): Observable<any> {
        return this._httpClient.put(`${this.URL}/${id}`, data);
    }

    delete(id: number): Observable<any> {
        return this._httpClient.delete(`${this.URL}/${id}`);
    }
}
